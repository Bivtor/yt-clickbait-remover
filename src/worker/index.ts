import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import Anthropic from "@anthropic-ai/sdk";
import type { SQSEvent, SQSBatchResponse } from "aws-lambda";

const ddb = new DynamoDBClient({});
const ssm = new SSMClient({});

// Cached titles/frames never go stale and are kept indefinitely (no DynamoDB TTL / no
// S3 lifecycle expiry — removed 2026-06-30). Items are only ever overwritten.

// ── Secrets (fetched at runtime, cached per container) ─────────────────────────
// Keys live in SSM SecureString and only the parameter NAMES are in env vars, so the
// actual secrets never appear in CloudFormation, the Lambda console, or
// GetFunctionConfiguration. Fetched once per cold start; a failed fetch is retried
// on the next invocation (the cached promise is cleared on rejection).
let clientsPromise: Promise<{ anthropic: Anthropic; transcriptKey: string }> | null = null;
function getClients() {
  if (!clientsPromise) {
    const p = (async () => {
      const get = async (name: string) =>
        (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true })))
          .Parameter!.Value!;
      const [anthropicKey, transcriptKey] = await Promise.all([
        get(process.env.ANTHROPIC_API_KEY_PARAM!),
        get(process.env.TRANSCRIPT_API_KEY_PARAM!),
      ]);
      return { anthropic: new Anthropic({ apiKey: anthropicKey }), transcriptKey };
    })();
    p.catch(() => { if (clientsPromise === p) clientsPromise = null; });
    clientsPromise = p;
  }
  return clientsPromise;
}

// Computed per handler run (NOT per container) — warm environments live for days, so a
// module-level date goes stale, wrong exactly at the year boundary the prompt cares about.
const systemTitleOnly = () => `\
You de-clickbait YouTube titles. You have ONLY the original title and the channel name — no information about what the video actually contains.
Rewrite it to be calmer and less sensational while preserving its apparent meaning.
Rules: remove ALL-CAPS, curiosity gaps, emoji, and hype words; keep proper nouns and channel name if relevant; aim for ~6-8 words; write in the same language as the original title.
An opinion or joke framing that makes no factual promise is not clickbait by itself; keep its meaning and only strip hype formatting.
If the title is already plain, accurate, and contains no clickbait, return it in Title Case without changing any words.
Output ONLY the rewritten title, nothing else.`;

const systemWithTranscript = (today: string) => `\
You de-clickbait YouTube titles. You have the original title, the channel name, and a transcript excerpt of what the video actually contains.
Today's date: ${today}. First, silently classify the video from the transcript, then rewrite the title:
- INFORMATIONAL (tutorial, explainer, news, review, podcast, essay): state plainly and accurately what the video really delivers; prefer concrete specifics from the transcript.
- WORK OR MOMENT TO EXPERIENCE (movie/TV scene, trailer or teaser, music, standup, speech or reading, meme — the transcript is dialogue, lyrics, or performance rather than someone informing the viewer): do NOT summarize the content into a literal description; never summarize lyrics, jokes, or plot. Identify it instead: name the source work, artist, or speaker, plus a short neutral label (scene, official trailer, standup clip). You may use your own knowledge to name the source only if you confidently recognize it; never guess. If satire or parody, the title must stay recognizable as satire. If the source is unidentifiable, keep the original title's meaning and only strip the hype.
Rules for both: remove hype, curiosity gaps, ALL-CAPS, emoji, and any factual promise the content doesn't keep; keep proper nouns; aim for ~6–8 words; write in the same language as the original title.
An opinion or joke framing (like "worst line in movie history") that makes no factual promise is not clickbait by itself; keep the framing and only remove hype formatting.
If you include a year in the title, use ${today.slice(0, 4)} unless the transcript explicitly refers to a past event.
If the original title is already plain, accurate, and contains no clickbait, return it in Title Case without changing any words.
Never mention or explain your classification. Output ONLY the rewritten title: a single line, no explanation, no markdown, no quotes.`;

// ── oEmbed: authoritative title + existence check ───────────────────────────────
// The resolver can't verify client-supplied titles (any anonymous caller can POST a
// fabricated title for a real-but-uncached videoId → shared-cache poisoning / prompt
// injection, and random valid-shaped IDs would still buy an LLM call). oEmbed is free,
// keyless, and needs no proxy:
//   404/400        → video doesn't exist → mark unavailable, spend nothing.
//   401/403        → exists but embedding-disabled/private → no title available; fall
//                    back to the client-supplied title (bounded by the resolver's caps).
//   200            → use YouTube's own title/channel, ignoring the client's copy.
//   network error  → treat as exists (don't fail the record over a transient).
interface OembedResult { exists: boolean; title?: string; author?: string }

async function fetchOembed(videoId: string): Promise<OembedResult> {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
    const resp = await fetch(url);
    if (resp.status === 400 || resp.status === 404) return { exists: false };
    if (!resp.ok) return { exists: true };
    const j = (await resp.json()) as { title?: string; author_name?: string };
    return { exists: true, title: j.title, author: j.author_name };
  } catch {
    return { exists: true };
  }
}

// Nonexistent video: terminal for BOTH pipelines — status stops the title path, and
// thumbStatus=unavailable stops the resolver's thumb self-heal re-enqueues (the thumb
// worker would only burn a residential-proxy gate call discovering the same thing).
async function markVideoUnavailable(videoId: string, reason: string) {
  await ddb.send(new UpdateItemCommand({
    TableName: process.env.TABLE_NAME!,
    Key: { videoId: { S: videoId } },
    UpdateExpression: "SET #st = :st, thumbStatus = :ts, thumbReason = :tr",
    ExpressionAttributeNames: { "#st": "status" },
    ExpressionAttributeValues: {
      ":st": { S: "unavailable" },
      ":ts": { S: "unavailable" },
      ":tr": { S: reason.slice(0, 200) },
    },
  }));
}

async function fetchTranscript(videoId: string, apiKey: string): Promise<string | null> {
  const RETRYABLE = new Set([408, 429, 503]);

  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2 ** attempt * 1000));

    const resp = await fetch(
      `https://transcriptapi.com/api/v2/youtube/transcript?video_url=${videoId}&format=text`,
      { headers: { "Authorization": `Bearer ${apiKey}` } },
    );

    if (!resp.ok) {
      if (RETRYABLE.has(resp.status) && attempt < 3) continue;
      return null; // 400/404 = no captions, geo-blocked, private — skip gracefully
    }

    const raw = await resp.text();
    let text: string;
    try {
      const parsed = JSON.parse(raw) as any;
      text = Array.isArray(parsed)
        ? parsed.map((s: any) => s.text ?? "").join(" ")
        : (parsed.transcript ?? parsed.text ?? parsed.content ?? raw);
    } catch {
      text = raw;
    }

    // transcriptapi's "text" format still carries [Ns] timestamps — strip them so
    // they don't eat into the word budget or add noise the model has to see past.
    text = text.replace(/\[\d+(?:\.\d+)?s\]/g, " ");

    if (!text.trim()) return null;
    return text.split(/\s+/).slice(0, 3000).join(" ");
  }

  return null;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const failures: SQSBatchResponse["batchItemFailures"] = [];
  const today = new Date().toISOString().split("T")[0];

  for (const record of event.Records) {
    const { videoId, originalTitle, creator } = JSON.parse(record.body) as {
      videoId: string;
      originalTitle: string;
      creator: string;
    };

    try {
      // Existence gate + authoritative title BEFORE spending money on the LLM.
      const oembed = await fetchOembed(videoId);
      if (!oembed.exists) {
        await markVideoUnavailable(videoId, "video not found (oembed 404)");
        console.log(`∅ ${videoId}: does not exist — marked unavailable, no LLM call`);
        continue;
      }
      const title = oembed.title ?? originalTitle;
      const creatorName = oembed.author ?? creator;

      const { anthropic, transcriptKey } = await getClients();
      const transcript = await fetchTranscript(videoId, transcriptKey);

      const system = transcript ? systemWithTranscript(today) : systemTitleOnly();
      const userMsg = transcript
        ? `Creator: ${creatorName}\nOriginal title: ${title}\n\nTranscript excerpt:\n${transcript}`
        : `Creator: ${creatorName}\nOriginal title: ${title}`;

      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 60,
        system,
        messages: [{ role: "user", content: userMsg }],
      });

      // The cache is permanent, so a malformed response (leaked reasoning, markdown,
      // multi-line) must never be stored as a title: keep the last non-empty line,
      // strip wrapping */" chars, and fall back to the original title if it still
      // doesn't look like one.
      let rewrittenTitle = title;
      if (response.content[0]?.type === "text") {
        const lines = response.content[0].text.trim().split("\n").map(l => l.trim()).filter(Boolean);
        const candidate = (lines[lines.length - 1] ?? "")
          .replace(/^[*"'`]+|[*"'`]+$/g, "").trim();
        if (candidate && candidate.length <= 120) rewrittenTitle = candidate;
      }

      // UpdateItem (not PutItem) so we only touch the title attributes — the
      // thumbnail worker writes thumbUrl on the same item and PutItem would
      // clobber it (and vice versa). Each worker owns its own fields.
      await ddb.send(new UpdateItemCommand({
        TableName: process.env.TABLE_NAME!,
        Key: { videoId: { S: videoId } },
        UpdateExpression:
          "SET originalTitle = :ot, rewrittenTitle = :rt, creator = :cr, #st = :st, cachedAt = :ca",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":ot": { S: title },
          ":rt": { S: rewrittenTitle },
          ":cr": { S: creatorName },
          ":st": { S: "done" },
          ":ca": { N: String(Date.now()) },
        },
      }));

      console.log(`✓ ${videoId}: "${title}" → "${rewrittenTitle}"`);
    } catch (err) {
      console.error(`✗ ${videoId}:`, err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};
