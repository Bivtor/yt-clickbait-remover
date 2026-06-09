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
const CONCURRENCY   = 3;

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
  row:       Row;
  titleOnly: Condition;
  levels:    Record<Level, Condition>;
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
Rewrite the title to state plainly and accurately what the video really delivers, based on the transcript.
Rules: remove hype, curiosity gaps, ALL-CAPS, emoji, and any promise the content doesn't keep; prefer concrete specifics from the transcript; keep proper nouns; aim for ~6–8 words.
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

// ── Anthropic call ───────────────────────────────────────────────────────────

async function llm(
  model: string, system: string, user: string, maxTokens: number,
): Promise<{ text: string; usage: Usage }> {
  const msg = await client.messages.create({
    model, max_tokens: maxTokens, system,
    messages: [{ role: "user", content: user }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map(b => b.text).join("").trim();
  return { text, usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens, model } };
}

// ── transcript fetch + cache ─────────────────────────────────────────────────

// Supadata enforces 1 req/sec. This serializes concurrent cache-miss fetches.
let nextSupadataSlot = 0;
async function waitForSupadataSlot(): Promise<void> {
  const now  = Date.now();
  const wait = nextSupadataSlot - now;
  nextSupadataSlot = Math.max(now, nextSupadataSlot) + 1000;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

async function fetchTranscript(videoId: string): Promise<string> {
  const cacheDir  = join(HERE, "transcript-cache");
  const cachePath = join(cacheDir, `${videoId}.txt`);
  if (existsSync(cachePath)) {
    process.stdout.write(`  [cache] ${videoId}\n`);
    return readFileSync(cachePath, "utf8");
  }
  await waitForSupadataSlot();
  process.stdout.write(`  [fetch] ${videoId} … `);
  const resp = await fetch(
    `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true`,
    { headers: { "x-api-key": process.env.SUPADATA_API_KEY ?? "" } },
  );
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Supadata ${resp.status} for ${videoId}: ${body}`);
  }
  const data = await resp.json() as { content: string };
  const text = typeof data.content === "string" ? data.content : JSON.stringify(data.content);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, text);
  process.stdout.write(`${text.split(/\s+/).length} words cached\n`);
  return text;
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
    half:       words.slice(0, Math.floor(words.length / 2)).join(" "),
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

async function evalRow(row: Row): Promise<RowResult> {
  const full   = await fetchTranscript(row.videoId);
  const slices = makelevels(full);

  // A — title only
  const a = await llm(
    REWRITE_MODEL, SYS_TITLE_ONLY,
    `Creator: ${row.creator}\nOriginal title: ${row.originalTitle}`,
    60,
  );
  const titleOnlyRewrite = a.text;

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

  // average title-only scores across judges
  const avgTitleOnlyScores: Scores = {
    faithfulness:           toScoresSets.reduce((s, x) => s + x.faithfulness,           0) / toScoresSets.length,
    informativeness:        toScoresSets.reduce((s, x) => s + x.informativeness,        0) / toScoresSets.length,
    sensationalism_removed: toScoresSets.reduce((s, x) => s + x.sensationalism_removed, 0) / toScoresSets.length,
  };

  return {
    row,
    titleOnly: { rewrite: titleOnlyRewrite, scores: avgTitleOnlyScores, winner: "tie", reason: "baseline", usage: [a.usage] },
    levels: levelConditions,
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
  for (const r of results) {
    console.log(`\n▶  ${r.row.creator} — "${r.row.originalTitle}"  [${r.row.videoId}]`);
    console.log(`   A (title-only) : ${r.titleOnly.rewrite}`);
    for (const lv of LEVELS) {
      const c = r.levels[lv];
      const mark = c.winner === "context" ? "✓ context wins" : c.winner === "title_only" ? "✗ title-only" : "= tie";
      const fg = (c.scores?.faithfulness ?? 0) - (r.titleOnly.scores?.faithfulness ?? 0);
      console.log(`   ${lv.padEnd(10)}: ${c.rewrite}`);
      console.log(`              ${mark}  faith ${r.titleOnly.scores?.faithfulness.toFixed(1)}→${c.scores?.faithfulness.toFixed(1)} (${fg >= 0 ? "+" : ""}${fg.toFixed(1)})  "${c.reason}"`);
    }
  }

  // ── aggregate ──────────────────────────────────────────────────────────────
  const n = results.length;
  const toFaithAll = results.map(r => r.titleOnly.scores?.faithfulness ?? 0);

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("AGGREGATE\n");

  for (const lv of LEVELS) {
    const wins    = results.filter(r => r.levels[lv].winner === "context").length;
    const losses  = results.filter(r => r.levels[lv].winner === "title_only").length;
    const netRate = (wins - losses) / n;
    const faithContext   = results.map(r => r.levels[lv].scores?.faithfulness ?? 0);
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
  console.log(`  Supadata transcript API         : ~$0.001–0.005 / video (not counted here)`);
  console.log(`  Est. production cost per video  : ~$${(rewriteCost / n / (LEVELS.length + 1)).toFixed(5)} LLM + transcript`);
  console.log("══════════════════════════════════════════════════════════════\n");
}

main().catch(e => { console.error(e); process.exit(1); });
