import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import * as https from "node:https";
import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { VPS_CAPTIONS_CA } from "./vps-ca";

const ddb = new DynamoDBClient({});
const ssm = new SSMClient({});

// Cached titles/frames never go stale and are kept indefinitely (no DynamoDB TTL / no
// S3 lifecycle expiry — removed 2026-06-30). Items are only ever overwritten.

// ── Secrets (fetched at runtime, cached per container) ─────────────────────────
// Keys live in SSM SecureString and only the parameter NAMES are in env vars, so the
// actual secrets never appear in CloudFormation, the Lambda console, or
// GetFunctionConfiguration. Fetched once per cold start; a failed fetch is retried
// on the next invocation (the cached promise is cleared on rejection).
// Haiku was REMOVED from the provider chain 2026-07-14 (Victor: never pay Haiku
// rates again) — chain is now qwen-flash → Gemini Flash-Lite → original title.
let clientsPromise: Promise<{
  transcriptKey: string; geminiKey: string; captionToken: string;
  qwenKey: string; qwenBase: string;
}> | null = null;
function getClients() {
  if (!clientsPromise) {
    const p = (async () => {
      const get = async (name: string) =>
        (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true })))
          .Parameter!.Value!;
      // Optional params: ABSENT env var = that lane is deliberately off.
      // A FAILED fetch must reject (not silently disable the lane): after the
      // 2026-07-14 deploy, containers that raced the SSM policy propagation
      // cached empty qwen creds for their whole lifetime and served Gemini.
      // Rejection resets clientsPromise, so the next invocation retries.
      const opt = (envName?: string) => (envName ? get(envName) : Promise.resolve(""));
      const [transcriptKey, geminiKey, captionToken, qwenKey, qwenBase] = await Promise.all([
        get(process.env.TRANSCRIPT_API_KEY_PARAM!),
        get(process.env.GEMINI_API_KEY_PARAM!),
        opt(process.env.CAPTION_SERVICE_TOKEN_PARAM),
        opt(process.env.DASHSCOPE_API_KEY_PARAM),
        opt(process.env.DASHSCOPE_BASE_URL_PARAM),
      ]);
      return { transcriptKey, geminiKey, captionToken, qwenKey, qwenBase };
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
If the title is already plain, accurate, and contains no clickbait, output it EXACTLY as written, changing nothing. Never reword a title cosmetically; only rewrite when something clickbait is actually being removed.
Output ONLY the rewritten title, nothing else.`;

const systemWithTranscript = (today: string) => `\
You de-clickbait YouTube titles. You have the original title, the channel name, and a transcript excerpt of what the video actually contains.
Today's date: ${today}.
STEP 1 — decide whether the title needs rewriting at all. A title needs rewriting ONLY if it contains clickbait: hype words, ALL-CAPS words, curiosity gaps, emoji, sensational punctuation, or a promise the content doesn't keep. If it contains none of these, output the original title EXACTLY as written, changing nothing. Series/episode markers ("(Part 4)", "【Day308】", "EP13"), channel suffixes ("| Glamour"), and plain descriptive phrasing are NOT clickbait.
STEP 2 — if rewriting is needed, silently classify the video from the transcript:
- INFORMATIONAL (tutorial, explainer, news, review, podcast, essay): state plainly and accurately what the video really delivers; prefer concrete specifics from the transcript.
- WORK OR MOMENT TO EXPERIENCE (movie/TV scene, trailer or teaser, music, standup, speech or reading, meme — the transcript is dialogue, lyrics, or performance rather than someone informing the viewer): do NOT summarize the content into a literal description; never summarize lyrics, jokes, or plot. Identify it instead: name the source work, artist, or speaker, plus a short neutral label (scene, official trailer, standup clip). You may use your own knowledge to name the source only if you confidently recognize it; never guess. If satire or parody, the title must stay recognizable as satire. If the source is unidentifiable, keep the original title's meaning and only strip the hype.
Rewriting rules: remove ONLY the clickbait, keep everything else — the accurate distinctive elements (premise, setting, gimmick, series markers), proper nouns, and the original title's language; aim for ~6–10 words.
An opinion or joke framing (like "worst line in movie history") that makes no factual promise is not clickbait; keep the framing and only remove hype formatting.
If you include a year in the title, use ${today.slice(0, 4)} unless the transcript explicitly refers to a past event.
Never mention or explain your classification or decision. Output ONLY the title: a single line, no explanation, no markdown, no quotes.`;

// ── Title providers: qwen-flash primary, Gemini Flash-Lite fallback ────────────
// Chain decided 2026-07-14 (4-iteration head-to-head, notes/testrun/2026-07-14-*):
//   qwen-flash ($0.01/$0.40 ≈ $0.00003/title) → Gemini Flash-Lite (~$0.00026)
//   → original title. HAIKU IS OUT of the chain (Victor: never pay Haiku rates).
// Qwen quirks and their mitigations, all validated in the harness:
//   * inconsistent ALL-CAPS cleanup → deterministic decapsTitle() post-pass
//   * rare hallucinated names ("Tammy", "Gileina": 1/60 at this config) →
//     properNounGuard() routes that cure to Gemini instead of caching it
//   * occasional data_inspection_failed from Alibaba's content filter on
//     innocuous titles → same fallback path
//   * strong pass-through instinct (keeps borderline titles unchanged) →
//     accepted personality, Victor's call
const QWEN_MODEL = "qwen-flash";
// Appended to the shared system prompt for qwen only (formatting duties the
// model must do itself; caps are handled deterministically after).
const QWEN_SUFFIX = `
STRICT ADDITION: remove all emoji and decorative symbols (✅ 🥹 ❤️ 🇰🇷 and similar) from the title. Never alter names, numbers, or factual details; if you are not certain of a detail from the transcript, keep the original wording for that part. Replace bare @handles with the plain channel or artist name.`;

async function qwenRewrite(
  qwenKey: string, qwenBase: string, system: string, userMsg: string,
): Promise<string | null> {
  try {
    const resp = await fetch(`${qwenBase}/compatible-mode/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${qwenKey}` },
      body: JSON.stringify({
        model: QWEN_MODEL, max_tokens: 60, temperature: 0.2, enable_thinking: false,
        messages: [
          { role: "system", content: system + QWEN_SUFFIX },
          { role: "user", content: userMsg },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) {
      // 400 data_inspection_failed / 429 / 5xx — all fall through to Gemini.
      console.warn(`qwen ${resp.status}, falling back to gemini`);
      return null;
    }
    const j = (await resp.json()) as any;
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn("qwen network error, falling back to gemini:", err);
    return null;
  }
}

// Deterministic ALL-CAPS cleanup (validated in tools/llm_headtohead.mjs, unit
// cases there): title-case a caps word when it has 5+ letters OR its run of
// consecutive caps words totals 8+ letters; digit-bearing words (PS5, GBB23)
// and short standalone acronyms (NASA, FNAF, TBS) survive.
function decapsTitle(title: string): string {
  const words = title.split(/(\s+)/); // separators kept at odd indexes
  const letterCount = words.map((w) => (w.match(/\p{L}/gu) ?? []).length);
  const isCaps = words.map((w) => {
    const letters = w.match(/\p{L}/gu) ?? [];
    return letters.length >= 2 && !/\p{N}/u.test(w)
      && letters.every((c) => c.toUpperCase() === c && c.toLowerCase() !== c);
  });
  const runTotal = new Array(words.length).fill(0);
  let runStart = -1, total = 0;
  for (let i = 0; i <= words.length + 1; i += 2) {
    if (i < words.length && isCaps[i]) {
      if (runStart < 0) runStart = i;
      total += letterCount[i];
    } else if (runStart >= 0) {
      for (let k = runStart; k < i; k += 2) runTotal[k] = total;
      runStart = -1; total = 0;
    }
  }
  return words.map((w, i) => {
    if (!isCaps[i]) return w;
    if (letterCount[i] < 5 && runTotal[i] < 8) return w;
    return w.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, sep, l) => sep + l.toUpperCase());
  }).join("");
}

// Hallucination guard: a capitalized word in qwen's output that appears nowhere
// in the original title + creator + transcript AND isn't ordinary title-case
// vocabulary is treated as an invented name → that cure routes to Gemini.
// A false positive just means paying Flash-Lite price for one title; a true
// positive keeps a "Gileina Targaryen" out of the permanent cache.
const GUARD_COMMON = new Set(`
the a an and or but nor for yet so with without from into onto over under about
after before during between against through why how what when where which who
whose whom this that these those his her its their our your
playing building making creating trying testing reviewing reacting watching
exploring explaining ranking comparing debunking disproving returning restoring
renovating unboxing cooking baking driving flying racing fighting winning losing
finding hunting searching visiting touring interviewing discussing debating
analyzing breaking fixing repairing upgrading installing starting ending
finishing completing beating solving opening closing buying selling collecting
trading crafting farming mining surviving escaping running walking climbing
jumping swimming diving sailing camping hiking traveling moving living eating
tasting drinking sleeping training learning teaching studying reading writing
drawing painting singing dancing performing recording streaming editing filming
coding programming designing developing launching recreating identifying
history story review reaction gameplay tutorial guide tips tricks secrets facts
myths mistakes problems solutions questions answers thoughts ideas theory
theories analysis breakdown comparison collection compilation highlights
moments scene scenes clips episode episodes part parts series season chapter
volume edition version update news recap summary overview introduction basics
explained ranked rated tested compared revealed uncovered examined
best worst top new old first last final ultimate complete full official
original real true hidden secret rare common popular famous modern classic
things ways reasons times days years weeks months hours minutes seconds people
men women kids children family friends world life home house room car truck
game games movie movies film films music song songs video videos channel show
podcast interview documentary trailer teaser live stream vod mix remix cover
lyrics audio performance concert
`.trim().split(/\s+/));

// Diacritic-folded lowercase — "Arête" must match a transcript's "arete".
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function properNounGuard(out: string, refText: string): string[] {
  // Hyphens normalize to spaces on BOTH sides ("Low-Impact" vs "low impact").
  const ref = fold(refText).replace(/-/g, " ");
  const words = out.match(/\p{Lu}[\p{L}'’-]{2,}/gu) ?? [];
  return [...new Set(words.filter((w) => {
    // Possessive + inflection stripping: "Ondra's"→ondra, "Climbed"→climb,
    // "Bouldering"→boulder(+e), "Changes"→change. First guard deploy fired on
    // ~50% of rewrites from exactly these shapes (2026-07-14).
    const base = fold(w).replace(/['’]s$/, "").replace(/-/g, " ");
    const candidates = [base];
    for (const suf of ["s", "es", "ed", "d", "ing"]) {
      if (base.endsWith(suf)) candidates.push(base.slice(0, -suf.length));
    }
    if (base.endsWith("ing")) candidates.push(base.slice(0, -3) + "e");
    if (candidates.some((c) => GUARD_COMMON.has(c))) return false;
    return !candidates.some((c) => c.length >= 3 && ref.includes(c));
  }))];
}

const GEMINI_MODEL = "gemini-3.1-flash-lite";

async function geminiRewrite(
  geminiKey: string, system: string, userMsg: string,
): Promise<string | null> {
  const RETRYABLE = new Set([429, 500, 503]);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2 ** attempt * 2000));
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: userMsg }] }],
            generationConfig: { maxOutputTokens: 60, thinkingConfig: { thinkingBudget: 0 } },
          }),
          // A hung connection must not eat the 120s Lambda timeout — abort and
          // let the retry/Haiku-fallback path handle it within this invocation.
          // 20s keeps the worst case (3 hangs + backoffs + transcript retries +
          // Haiku fallback) safely inside the Lambda timeout.
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!resp.ok) {
        if (RETRYABLE.has(resp.status) && attempt < 2) continue;
        console.warn(`gemini ${resp.status}, falling back to haiku`);
        return null;
      }
      const j = (await resp.json()) as any;
      // Safety-blocked or empty responses have no text parts — that's the
      // filter case; fall back rather than caching garbage.
      const text = j.candidates?.[0]?.content?.parts
        ?.map((p: any) => p.text ?? "").join("").trim();
      return text || null;
    } catch (err) {
      if (attempt < 2) continue;
      console.warn("gemini network error, falling back to haiku:", err);
      return null;
    }
  }
  return null;
}

// The cache is permanent, so a malformed model response must never be stored as
// a title. Known failure modes this catches (both observed in testing):
//  - leaked classification labels: "INFORMATIONAL (tutorial): <title>" or a
//    sentence mentioning WORK OR MOMENT TO EXPERIENCE
//  - multi-line reasoning, markdown wrapping, over-length output
// Returns null when nothing usable survives, which triggers provider fallback.
function sanitizeTitle(raw: string): string | null {
  const lines = raw.trim().split("\n").map(l => l.trim()).filter(Boolean);
  let candidate = (lines[lines.length - 1] ?? "")
    .replace(/^[*"'`]+|[*"'`]+$/g, "").trim();
  // Strip a leaked classification label prefix (ALL-CAPS label + optional
  // parenthetical, then ':' or '：'), e.g. "INFORMATIONAL (tutorial): ...".
  // Case-SENSITIVE on purpose: leaks echo the prompt's caps labels, while real
  // titles like "Entertainment: The Rise of X" must not be touched.
  candidate = candidate
    .replace(/^(?:INFORMATIONAL|WORK OR MOMENT TO EXPERIENCE|ENTERTAINMENT(?: CLIP)?)\s*(?:\([^)]*\))?\s*[:：]\s*/, "")
    .trim();
  if (!candidate || candidate.length > 120) return null;
  // If a caps prompt label still appears after stripping, the output is
  // reasoning, not a title. (Not lowercase words — "Why Clickbait Works" and
  // "Scientists Classify New Species" are legitimate titles.)
  if (/\b(?:INFORMATIONAL|WORK OR MOMENT TO EXPERIENCE|ENTERTAINMENT CLIP)\b/.test(candidate)) return null;
  return candidate;
}

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

// ── Captions: VPS service first (flat-cost), paid API as fallback ───────────────
// Model B lane (notes/SPEND_SOLUTIONS.md): the VPS only does the one thing Lambda
// can't — fetch YouTube captions from a clean IP. Step-0 validated that the
// auto-caption text matches the paid API word-for-word (it resells YouTube's own
// ASR), so any non-200/timeout here degrades to a COST regression, never a worse
// title. The endpoint is a bare IP with a pinned self-signed cert (src/worker/
// vps-ca.ts) — no DNS or public CA in the loop.
function vpsGet(
  url: string, headers: Record<string, string>, timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers, ca: VPS_CAPTIONS_CA, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    // Inactivity timeout doubles as the total budget: the service sends nothing
    // until its android→ios retry ladder resolves, so a slow ladder trips this
    // and we move on to the paid API within the invocation's time budget.
    req.on("timeout", () => req.destroy(new Error(`caption service timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

// Transcript plus the per-video metadata the skip gates need. duration/views/
// uploadDate come from the VPS probe's player response — authoritative (never
// client-supplied) but only present when the VPS lane answered; the paid path
// carries no metadata, so gated behavior simply doesn't apply there.
interface TranscriptResult {
  transcript: string | null;
  duration?: number | null;   // seconds; null for live/premiere
  views?: number | null;      // null when the channel hides view counts
  uploadDate?: string | null; // "YYYYMMDD"
}

async function fetchTranscript(
  videoId: string, apiKey: string, captionToken: string,
): Promise<TranscriptResult> {
  if (process.env.CAPTION_SERVICE_URL && captionToken) {
    try {
      const { status, body } = await vpsGet(
        `${process.env.CAPTION_SERVICE_URL}/captions?v=${videoId}`,
        { authorization: `Bearer ${captionToken}` }, 20_000,
      );
      const j = JSON.parse(body) as {
        text?: string; outcome?: string;
        duration?: number | null; views?: number | null; uploadDate?: string | null;
      };
      if (status === 200) {
        const text = (j.text ?? "").trim();
        if (text) {
          console.log(`[captions:vps] ${videoId}`);
          return {
            transcript: text.split(/\s+/).slice(0, 3000).join(" "),
            duration: j.duration, views: j.views, uploadDate: j.uploadDate,
          };
        }
      }
      // Authoritative miss: the probe got a HEALTHY player response with zero
      // caption tracks. The paid API resells the same data, so a paid call here
      // is a charged guaranteed-miss (their dashboard bills unfulfilled
      // requests too, pending Victor's audit) — skip it.
      if (status === 404 && j.outcome === "no_captions") {
        console.log(`[captions:none] ${videoId} (vps-authoritative, paid call skipped)`);
        return { transcript: null, duration: j.duration, views: j.views, uploadDate: j.uploadDate };
      }
      // degraded / 503 busy / 5xx → paid API decides for itself below.
    } catch (err) {
      console.warn(`caption service unavailable, trying paid API: ${err}`);
    }
  }
  const paid = await fetchTranscriptPaid(videoId, apiKey);
  // [captions:paid] is the fallback-rate signal (rollout gate: < ~20%); a
  // sustained spike means the VPS lane is sick while cures still work.
  console.log(`[captions:${paid ? "paid" : "none"}] ${videoId}`);
  return { transcript: paid };
}

// ── Skip gates (Victor, 2026-07-14): don't de-clickbait what isn't worth it ────
// <1min: mostly memes and movie clips — the original titles are funnier anyway.
// <10k views: the esoteric long tail. NO age guard (Victor's call, 2026-07-14,
// reversing the initial implementation): a video first requested while still
// under 10k views is skip-cached PERMANENTLY, including big-channel uploads
// seen minutes after publish — accepted cost. titleSkip="lowviews" marks them
// for a future re-cure sweep if that ever changes. Both gates need VPS
// metadata; cures on the paid path (no metadata) proceed ungated.
const SKIP_SHORT_S = Number(process.env.SKIP_SHORT_SECONDS ?? 60);
const SKIP_VIEWS = Number(process.env.SKIP_VIEWS_UNDER ?? 10_000);

function titleSkipReason(meta: TranscriptResult): string | null {
  if (meta.duration != null && meta.duration > 0 && meta.duration < SKIP_SHORT_S) return "short";
  if (meta.views != null && meta.views < SKIP_VIEWS) return "lowviews";
  return null;
}

async function fetchTranscriptPaid(videoId: string, apiKey: string): Promise<string | null> {
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

      const { transcriptKey, geminiKey, captionToken, qwenKey, qwenBase } = await getClients();
      const result = await fetchTranscript(videoId, transcriptKey, captionToken);
      const transcript = result.transcript;

      // Skip gates BEFORE any LLM spend. Cached exactly like a normal cure
      // (status=done, rewrittenTitle=originalTitle) plus a titleSkip marker so
      // skipped items are queryable if we ever want to re-cure them.
      const skipReason = titleSkipReason(result);
      if (skipReason) {
        await ddb.send(new UpdateItemCommand({
          TableName: process.env.TABLE_NAME!,
          Key: { videoId: { S: videoId } },
          UpdateExpression:
            "SET originalTitle = :ot, rewrittenTitle = :rt, creator = :cr, #st = :st, cachedAt = :ca, titleSkip = :sk",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: {
            ":ot": { S: title },
            ":rt": { S: title },
            ":cr": { S: creatorName },
            ":st": { S: "done" },
            ":ca": { N: String(Date.now()) },
            ":sk": { S: skipReason },
          },
        }));
        console.log(`✓ ${videoId} [skip:${skipReason}]: "${title}" (LLM skipped)`);
        continue;
      }

      const system = transcript ? systemWithTranscript(today) : systemTitleOnly();
      const userMsg = transcript
        ? `Creator: ${creatorName}\nOriginal title: ${title}\n\nTranscript excerpt:\n${transcript}`
        : `Creator: ${creatorName}\nOriginal title: ${title}`;

      // Primary: qwen-flash (sanitize → decaps → proper-noun guard; any failure
      // or guard hit routes this one cure to Gemini). Fallback: Gemini
      // Flash-Lite. Last resort: the original title, never a broken one.
      // NO Haiku anywhere in this chain (Victor, 2026-07-14).
      let provider = "qwen";
      let rewrittenTitle: string | null = null;

      if (qwenKey && qwenBase) {
        const qwenRaw = await qwenRewrite(qwenKey, qwenBase, system, userMsg);
        if (qwenRaw) {
          const cleaned = sanitizeTitle(qwenRaw);
          if (cleaned) {
            const decapsed = decapsTitle(cleaned);
            const novel = properNounGuard(decapsed, `${title}\n${creatorName}\n${transcript ?? ""}`);
            if (novel.length) {
              console.warn(`qwen guard hit ${videoId} [${novel.join(", ")}], falling back to gemini`);
            } else {
              rewrittenTitle = decapsed;
            }
          }
        }
      }

      if (!rewrittenTitle) {
        provider = "gemini";
        const geminiRaw = await geminiRewrite(geminiKey, system, userMsg);
        if (geminiRaw) rewrittenTitle = sanitizeTitle(geminiRaw);
      }

      if (!rewrittenTitle) {
        provider = "none";
        rewrittenTitle = title;
      }

      // UpdateItem (not PutItem) so we only touch the title attributes — the
      // thumbnail worker writes thumbUrl on the same item and PutItem would
      // clobber it (and vice versa). Each worker owns its own fields.
      await ddb.send(new UpdateItemCommand({
        TableName: process.env.TABLE_NAME!,
        Key: { videoId: { S: videoId } },
        // REMOVE titleSkip: a re-cure that passes the gates (e.g. the video
        // gained views) must not leave a stale skip marker behind.
        UpdateExpression:
          "SET originalTitle = :ot, rewrittenTitle = :rt, creator = :cr, #st = :st, cachedAt = :ca REMOVE titleSkip",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":ot": { S: title },
          ":rt": { S: rewrittenTitle },
          ":cr": { S: creatorName },
          ":st": { S: "done" },
          ":ca": { N: String(Date.now()) },
        },
      }));

      console.log(`✓ ${videoId} [${provider}]: "${title}" → "${rewrittenTitle}"`);
    } catch (err) {
      console.error(`✗ ${videoId}:`, err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};
