import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import Anthropic from "@anthropic-ai/sdk";
import type { SQSEvent, SQSBatchResponse } from "aws-lambda";

const ddb       = new DynamoDBClient({});
const anthropic = new Anthropic();

const TODAY        = new Date().toISOString().split("T")[0];
// Cached frames/titles never go stale, so we keep them long. 180d bounds storage
// and lets deleted/privated videos fall out. Match the S3 lifecycle rule.
const TTL_180_DAYS = 180 * 24 * 60 * 60;

const SYS_TITLE_ONLY = `\
You de-clickbait YouTube titles. You have ONLY the original title and the channel name — no information about what the video actually contains.
Rewrite it to be calmer and less sensational while preserving its apparent meaning.
Rules: remove ALL-CAPS, curiosity gaps, emoji, and hype words; keep proper nouns and channel name if relevant; aim for ~6–8 words.
If the title is already plain, accurate, and contains no clickbait, return it in Title Case without changing any words.
Output ONLY the rewritten title, nothing else.`;

const SYS_WITH_TRANSCRIPT = `\
You de-clickbait YouTube titles. You have the original title, the channel name, and a transcript excerpt of what the video actually contains.
Today's date: ${TODAY}. Rewrite the title to state plainly and accurately what the video really delivers, based on the transcript.
Rules: remove hype, curiosity gaps, ALL-CAPS, emoji, and any promise the content doesn't keep; prefer concrete specifics from the transcript; keep proper nouns; aim for ~6–8 words.
If you include a year in the title, use ${TODAY.slice(0, 4)} unless the transcript explicitly refers to a past event.
If the original title is already plain, accurate, and contains no clickbait, return it in Title Case without changing any words.
Output ONLY the rewritten title, nothing else.`;

async function fetchTranscript(videoId: string): Promise<string | null> {
  const RETRYABLE = new Set([408, 429, 503]);

  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2 ** attempt * 1000));

    const resp = await fetch(
      `https://transcriptapi.com/api/v2/youtube/transcript?video_url=${videoId}&format=text`,
      { headers: { "Authorization": `Bearer ${process.env.TRANSCRIPT_API_KEY!}` } },
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
        : (parsed.text ?? parsed.content ?? raw);
    } catch {
      text = raw;
    }

    if (!text.trim()) return null;
    return text.split(/\s+/).slice(0, 3000).join(" ");
  }

  return null;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const failures: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    const { videoId, originalTitle, creator } = JSON.parse(record.body) as {
      videoId: string;
      originalTitle: string;
      creator: string;
    };

    try {
      const transcript = await fetchTranscript(videoId);

      const system  = transcript ? SYS_WITH_TRANSCRIPT : SYS_TITLE_ONLY;
      const userMsg = transcript
        ? `Creator: ${creator}\nOriginal title: ${originalTitle}\n\nTranscript excerpt:\n${transcript}`
        : `Creator: ${creator}\nOriginal title: ${originalTitle}`;

      const response = await anthropic.messages.create({
        model:      "claude-haiku-4-5",
        max_tokens: 60,
        system,
        messages:   [{ role: "user", content: userMsg }],
      });

      const rewrittenTitle =
        response.content[0]?.type === "text"
          ? response.content[0].text.trim()
          : originalTitle;

      // UpdateItem (not PutItem) so we only touch the title attributes — the
      // thumbnail worker writes thumbUrl on the same item and PutItem would
      // clobber it (and vice versa). Each worker owns its own fields.
      await ddb.send(new UpdateItemCommand({
        TableName: process.env.TABLE_NAME!,
        Key: { videoId: { S: videoId } },
        UpdateExpression:
          "SET originalTitle = :ot, rewrittenTitle = :rt, creator = :cr, #st = :st, cachedAt = :ca, #ttl = :ttl",
        ExpressionAttributeNames: { "#st": "status", "#ttl": "ttl" },
        ExpressionAttributeValues: {
          ":ot":  { S: originalTitle },
          ":rt":  { S: rewrittenTitle },
          ":cr":  { S: creator },
          ":st":  { S: "done" },
          ":ca":  { N: String(Date.now()) },
          ":ttl": { N: String(Math.floor(Date.now() / 1000) + TTL_180_DAYS) },
        },
      }));

      console.log(`✓ ${videoId}: "${originalTitle}" → "${rewrittenTitle}"`);
    } catch (err) {
      console.error(`✗ ${videoId}:`, err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};
