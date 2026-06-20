/**
 * De-Clickbait — Phase 0 eval harness (v2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Question: does adding a transcript help Haiku write a better title, and how
 * much transcript do you actually need?
 *
 * For each video in dataset.jsonl the script:
 *   1. Fetches the full transcript from Supadata (cached to ./transcript-cache/)
 *   2. Slices it to three context levels:
 *        words_1000  — first ~1 000 words  (cheap, intro/hook)
 *        words_3000  — first ~3 000 words  (moderate)
 *        half        — first half of full transcript
 *   3. Generates four rewrites via Haiku:
 *        A  title-only       (no transcript — zero extra cost)
 *        B  title + 1 000w
 *        C  title + 3 000w
 *        D  title + half
 *   4. A blind Sonnet judge scores each of B/C/D vs A, reporting faithfulness
 *      gain and net win rate per level.
 *
 * Verdict thresholds (from PROJECT_SUMMARY):
 *   net win rate  ≥ 20 %  AND  faithfulness gain ≥ 0.40  → level is justified
 *
 * Run:
 *   npm install
 *   npm run eval
 *
 * Dataset format (one JSON object per line in dataset.jsonl):
 *   { "videoId": "dRLvkY3NKqI", "creator": "Channel Name", "originalTitle": "The Title" }
 *
 * TODO (before production):
 *   - Run all generated titles through a slur/profanity filter library (e.g. `bad-words`,
 *     `leo-profanity`, or a custom blocklist) before writing to the DB or serving to users.
 *     Transcripts can contain anything; Haiku may surface it in a rewrite.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── load .env ────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const envPath = join(HERE, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) process.env[m[1]] ??= m[2].trim();
  }
}

// ── config ───────────────────────────────────────────────────────────────────

const REWRITE_MODEL = "claude-haiku-4-5";
const JUDGE_MODEL   = "claude-sonnet-4-6";
const CONCURRENCY    = 1;
const HALF_CAP_WORDS = 4000; // keeps token usage sane for long podcasts/interviews

const TODAY = new Date().toISOString().split("T")[0]; // e.g. "2026-06-13"

const PRICING: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5":  { in: 1,  out: 5  },
  "claude-sonnet-4-6": { in: 3,  out: 15 },
};

const VERDICT = { minNetWinRate: 0.20, minFaithfulnessGain: 0.40 };

const LEVELS = ["words_1000", "words_3000", "half"] as const;
type Level = typeof LEVELS[number];

const client = new Anthropic();

// ── types ────────────────────────────────────────────────────────────────────

interface Row {
  videoId:       string;
  creator:       string;
  originalTitle: string;
}

interface Usage  { input: number; output: number; model: string }
interface Scores { faithfulness: number; informativeness: number; sensationalism_removed: number }

interface Condition {
  rewrite: string;
  scores:  Scores;
  winner:  "context" | "title_only" | "tie";
  reason:  string;
  usage:   Usage[];
}

interface RowResult {
  row:              Row;
  titleOnly:        Condition;
  levels:           Record<Level, Condition>;
  transcriptSkipped: boolean;
}

// ── prompts ──────────────────────────────────────────────────────────────────

const SYS_TITLE_ONLY = `\
You de-clickbait YouTube titles. You have ONLY the original title and the channel name — no information about what the video actually contains.
Rewrite it to be calmer and less sensational while preserving its apparent meaning.
Rules: remove ALL-CAPS, curiosity gaps, emoji, and hype words; keep proper nouns and channel name if relevant; aim for ~6–8 words.
If the title is already plain, accurate, and contains no clickbait, return it in Title Case (capitalize the first letter of each major word) without changing any of the words.
Output ONLY the rewritten title, nothing else.`;

const SYS_WITH_TRANSCRIPT = `\
You de-clickbait YouTube titles. You have the original title, the channel name, and a transcript excerpt of what the video actually contains.
Today's date: ${TODAY}. Rewrite the title to state plainly and accurately what the video really delivers, based on the transcript.
Rules: remove hype, curiosity gaps, ALL-CAPS, emoji, and any promise the content doesn't keep; prefer concrete specifics from the transcript; keep proper nouns; aim for ~6–8 words.
If you include a year in the title, use ${TODAY.slice(0, 4)} unless the transcript explicitly refers to a past event.
If the original title is already plain, accurate, and contains no clickbait, return it in Title Case (capitalize the first letter of each major word) without changing any of the words.
Output ONLY the rewritten title, nothing else.`;

const SYS_JUDGE = `\
You are evaluating two candidate replacement titles for a YouTube video.
You are given: the ORIGINAL clickbait title, the CREATOR name, a TRANSCRIPT EXCERPT (ground truth of what the video contains), and two candidates labelled A and B.

Score each candidate 1–5 on:
- faithfulness: accurately reflects the transcript without overpromising (5 = fully accurate)
- informativeness: tells a viewer what they'll actually get (5 = very informative)
- sensationalism_removed: hype/clickbait removed (5 = calm and plain)

Pick the better overall replacement. If genuinely equivalent, answer "tie".

Respond with ONLY this JSON, no prose, no code fences:
{"a":{"faithfulness":0,"informativeness":0,"sensationalism_removed":0},"b":{"faithfulness":0,"informativeness":0,"sensationalism_removed":0},"winner":"A|B|tie","reason":"one short sentence"}`;

// ── Anthropic call (with 429 retry) ─────────────────────────────────────────

async function llm(
  model: string, system: string, user: string, maxTokens: number,
): Promise<{ text: string; usage: Usage }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const msg = await client.messages.create({
        model, max_tokens: maxTokens, system,
        messages: [{ role: "user", content: user }],
      });
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map(b => b.text).join("").trim();
      return { text, usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens, model } };
    } catch (e: any) {
      if (e?.status === 429 && attempt < 5) {
        const wait = (parseInt(e?.headers?.["retry-after"] ?? "15", 10) + 1) * 1000;
        process.stdout.write(`  [rate-limit] waiting ${Math.round(wait / 1000)}s…\n`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
}

// ── transcript fetch + cache ─────────────────────────────────────────────────

// TranscriptAPI allows 300 req/min — no serialization needed.
// Returns null (instead of throwing) for videos that are unavailable or geo-blocked.
// Retryable errors (408, 429, 503) are retried with exponential backoff.
// Hard errors (401, 402, network) still throw so the run fails loudly.
async function fetchTranscript(videoId: string): Promise<string | null> {
  const cacheDir  = join(HERE, "transcript-cache");
  const cachePath = join(cacheDir, `${videoId}.txt`);
  if (existsSync(cachePath)) {
    process.stdout.write(`  [cache] ${videoId}\n`);
    return readFileSync(cachePath, "utf8");
  }

  process.stdout.write(`  [fetch] ${videoId} … `);

  const RETRYABLE = new Set([408, 429, 503]);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      const wait = 2 ** attempt * 1000;
      process.stdout.write(`  [retry ${attempt}] waiting ${wait / 1000}s…\n`);
      await new Promise(r => setTimeout(r, wait));
    }

    const resp = await fetch(
      `https://transcriptapi.com/api/v2/youtube/transcript?video_url=${videoId}&format=text`,
      { headers: { "Authorization": `Bearer ${process.env.TRANSCRIPT_API_KEY ?? ""}` } },
    );

    if (!resp.ok) {
      if (RETRYABLE.has(resp.status) && attempt < 3) continue;
      // Soft failures: geo-blocked, private, deleted, no captions
      if (resp.status === 404 || resp.status === 400) {
        const body = await resp.text().catch(() => "");
        process.stdout.write(`skipped (${resp.status} ${body.slice(0, 80)})\n`);
        return null;
      }
      const body = await resp.text().catch(() => "");
      throw new Error(`TranscriptAPI ${resp.status} for ${videoId}: ${body}`);
    }

    // format=text returns plain text; guard against an accidental JSON envelope
    const raw = await resp.text();
    let text: string;
    try {
      const parsed = JSON.parse(raw) as any;
      // If it came back as JSON array of segments, join the text fields
      text = Array.isArray(parsed)
        ? parsed.map((s: any) => s.text ?? "").join(" ")
        : (parsed.text ?? parsed.content ?? raw);
    } catch {
      text = raw;
    }

    if (!text.trim()) {
      process.stdout.write(`skipped (empty transcript)\n`);
      return null;
    }

    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, text);
    process.stdout.write(`${text.split(/\s+/).length} words cached\n`);
    return text;
  }

  process.stdout.write(`skipped (all retries exhausted)\n`);
  return null;
}

// ── transcript slicing ───────────────────────────────────────────────────────

function sliceToWords(text: string, n: number): string {
  return text.split(/\s+/).slice(0, n).join(" ");
}

function makelevels(full: string): Record<Level, string> {
  const words = full.split(/\s+/);
  return {
    words_1000: sliceToWords(full, 1000),
    words_3000: sliceToWords(full, 3000),
    half:       words.slice(0, Math.min(Math.floor(words.length / 2), HALF_CAP_WORDS)).join(" "),
  };
}

// ── judge helper ─────────────────────────────────────────────────────────────

async function judge(
  row: Row,
  transcriptExcerpt: string,
  levelLabel: string,
  titleOnlyRewrite: string,
  contextRewrite: string,
): Promise<{ scoresTitleOnly: Scores; scoresContext: Scores; winner: Condition["winner"]; reason: string; usage: Usage }> {
  const flip = Math.random() < 0.5;
  const candA = flip ? contextRewrite : titleOnlyRewrite;
  const candB = flip ? titleOnlyRewrite : contextRewrite;

  const userMsg = [
    `ORIGINAL: ${row.originalTitle}`,
    `CREATOR: ${row.creator}`,
    `TRANSCRIPT (${levelLabel}, ${transcriptExcerpt.split(/\s+/).length}w): ${transcriptExcerpt.slice(0, 800)}${transcriptExcerpt.length > 800 ? "…" : ""}`,
    `CANDIDATE A: ${candA}`,
    `CANDIDATE B: ${candB}`,
  ].join("\n\n");

  const j = await llm(JUDGE_MODEL, SYS_JUDGE, userMsg, 300);

  let parsed: any;
  try { parsed = JSON.parse(j.text.replace(/```(?:json)?/gi, "").trim()); }
  catch { parsed = { a: { faithfulness: 3, informativeness: 3, sensationalism_removed: 3 }, b: { faithfulness: 3, informativeness: 3, sensationalism_removed: 3 }, winner: "tie", reason: "parse error" }; }

  const scoresContext   = (flip ? parsed.a : parsed.b) as Scores;
  const scoresTitleOnly = (flip ? parsed.b : parsed.a) as Scores;

  let winner: Condition["winner"] = "tie";
  if      (parsed.winner === "A") winner = flip ? "context"    : "title_only";
  else if (parsed.winner === "B") winner = flip ? "title_only" : "context";

  return { scoresTitleOnly, scoresContext, winner, reason: parsed.reason ?? "", usage: j.usage };
}

// ── core eval per row ────────────────────────────────────────────────────────

const SKIPPED_CONDITION: Condition = {
  rewrite: "(no transcript)", scores: { faithfulness: 0, informativeness: 0, sensationalism_removed: 0 },
  winner: "tie", reason: "skipped — transcript unavailable", usage: [],
};

async function evalRow(row: Row): Promise<RowResult> {
  const full = await fetchTranscript(row.videoId);

  // A — title only (always runs, transcript or not)
  const a = await llm(
    REWRITE_MODEL, SYS_TITLE_ONLY,
    `Creator: ${row.creator}\nOriginal title: ${row.originalTitle}`,
    60,
  );
  const titleOnlyRewrite = a.text;

  // If no transcript available, return title-only result and mark skipped
  if (full === null) {
    const nullScores: Scores = { faithfulness: 0, informativeness: 0, sensationalism_removed: 0 };
    return {
      row,
      titleOnly: { rewrite: titleOnlyRewrite, scores: nullScores, winner: "tie", reason: "baseline", usage: [a.usage] },
      levels: Object.fromEntries(LEVELS.map(lv => [lv, SKIPPED_CONDITION])) as Record<Level, Condition>,
      transcriptSkipped: true,
    };
  }

  const slices = makelevels(full);

  // accumulate title-only scores across all judge calls; we'll average them
  const toScoresSets: Scores[] = [];
  const levelConditions = {} as Record<Level, Condition>;

  for (const lv of LEVELS) {
    const excerpt = slices[lv];
    const b = await llm(
      REWRITE_MODEL, SYS_WITH_TRANSCRIPT,
      `Creator: ${row.creator}\nOriginal title: ${row.originalTitle}\n\nTranscript excerpt:\n${excerpt}`,
      60,
    );
    const contextRewrite = b.text;

    const { scoresTitleOnly, scoresContext, winner, reason, usage: judgeUsage } = await judge(
      row, excerpt, lv, titleOnlyRewrite, contextRewrite,
    );

    toScoresSets.push(scoresTitleOnly);
    levelConditions[lv] = { rewrite: contextRewrite, scores: scoresContext, winner, reason, usage: [b.usage, judgeUsage] };
  }

  const avgTitleOnlyScores: Scores = {
    faithfulness:           toScoresSets.reduce((s, x) => s + x.faithfulness,           0) / toScoresSets.length,
    informativeness:        toScoresSets.reduce((s, x) => s + x.informativeness,        0) / toScoresSets.length,
    sensationalism_removed: toScoresSets.reduce((s, x) => s + x.sensationalism_removed, 0) / toScoresSets.length,
  };

  return {
    row,
    titleOnly: { rewrite: titleOnlyRewrite, scores: avgTitleOnlyScores, winner: "tie", reason: "baseline", usage: [a.usage] },
    levels: levelConditions,
    transcriptSkipped: false,
  };
}

// ── concurrency + cost ───────────────────────────────────────────────────────

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
    }),
  );
  return out;
}

function costOf(usages: Usage[]): number {
  return usages.reduce((sum, u) => {
    const p = PRICING[u.model];
    return p ? sum + (u.input / 1e6) * p.in + (u.output / 1e6) * p.out : sum;
  }, 0);
}

function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / (xs.length || 1); }

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const datasetPath = process.argv[2] ?? join(HERE, "dataset.jsonl");
  const rows: Row[] = readFileSync(datasetPath, "utf8")
    .split("\n").map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));

  if (rows.length === 0) {
    console.error("dataset.jsonl is empty — add entries first.");
    process.exit(1);
  }

  console.log(`\nRunning eval on ${rows.length} video(s)  rewrite=${REWRITE_MODEL}  judge=${JUDGE_MODEL}\n`);

  const results = await mapLimit(rows, CONCURRENCY, evalRow);

  // ── per-item output ────────────────────────────────────────────────────────
  const skipped = results.filter(r => r.transcriptSkipped);
  for (const r of results) {
    console.log(`\n▶  ${r.row.creator} — "${r.row.originalTitle}"  [${r.row.videoId}]${r.transcriptSkipped ? "  ⚠ no transcript" : ""}`);
    console.log(`   A (title-only) : ${r.titleOnly.rewrite}`);
    if (!r.transcriptSkipped) {
      for (const lv of LEVELS) {
        const c = r.levels[lv];
        const mark = c.winner === "context" ? "✓ context wins" : c.winner === "title_only" ? "✗ title-only" : "= tie";
        const fg = (c.scores?.faithfulness ?? 0) - (r.titleOnly.scores?.faithfulness ?? 0);
        console.log(`   ${lv.padEnd(10)}: ${c.rewrite}`);
        console.log(`              ${mark}  faith ${r.titleOnly.scores?.faithfulness.toFixed(1)}→${c.scores?.faithfulness.toFixed(1)} (${fg >= 0 ? "+" : ""}${fg.toFixed(1)})  "${c.reason}"`);
      }
    }
  }

  // ── aggregate (skipped rows excluded) ─────────────────────────────────────
  const scored = results.filter(r => !r.transcriptSkipped);
  const n = scored.length;
  const toFaithAll = scored.map(r => r.titleOnly.scores?.faithfulness ?? 0);

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`AGGREGATE  (${n} scored, ${skipped.length} skipped — no transcript)\n`);

  for (const lv of LEVELS) {
    const wins    = scored.filter(r => r.levels[lv].winner === "context").length;
    const losses  = scored.filter(r => r.levels[lv].winner === "title_only").length;
    const netRate = (wins - losses) / n;
    const faithContext   = scored.map(r => r.levels[lv].scores?.faithfulness ?? 0);
    const faithGain      = mean(faithContext) - mean(toFaithAll);
    const justified = netRate >= VERDICT.minNetWinRate && faithGain >= VERDICT.minFaithfulnessGain;
    console.log(`  ${lv.padEnd(10)}  wins ${wins}/${n}  net ${(netRate * 100).toFixed(0).padStart(4)}%  faith gain ${faithGain >= 0 ? "+" : ""}${faithGain.toFixed(2)}  ${justified ? "✅ justified" : "⚠️  not yet"}`);
  }

  // ── cost ───────────────────────────────────────────────────────────────────
  const allUsage    = [...results.flatMap(r => r.titleOnly.usage), ...results.flatMap(r => LEVELS.flatMap(lv => r.levels[lv].usage))];
  const rewriteCost = costOf(allUsage.filter(u => u.model === REWRITE_MODEL));
  const judgeCost   = costOf(allUsage.filter(u => u.model === JUDGE_MODEL));

  console.log("\nCOST");
  console.log(`  Haiku rewrites (this run)       : $${rewriteCost.toFixed(5)}`);
  console.log(`  Sonnet judge   (eval-only)      : $${judgeCost.toFixed(4)}`);
  console.log(`  TranscriptAPI                   : ~$0.001–0.002 / video (not counted here)`);
  console.log(`  Est. production cost per video  : ~$${(rewriteCost / n / (LEVELS.length + 1)).toFixed(5)} LLM + transcript`);
  console.log("══════════════════════════════════════════════════════════════\n");
}

main().catch(e => { console.error(e); process.exit(1); });
