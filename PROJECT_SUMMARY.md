# De-Clickbait — Project Summary & Handoff

*A portable recap of a working session. Drop this into a new chat on your personal account to pick up where you left off.*

---

## What this is

A browser extension that rewrites clickbait YouTube titles into plain, accurate ones **on the subscriptions feed** (the decision point — not the individual video page, where the title no longer matters). The rewrite is produced by an LLM reasoning over the video's **transcript**, because clickbait is a *title-vs-content mismatch*: you can't detect a broken promise without knowing what the video actually delivers.

Goal is a free tool + a sharp resume/portfolio piece, run under a hard **$150/month** budget. Not a business — the category is free-or-$1 and has a free incumbent (DeArrow).

---

## Why now — the competitive gap (the thesis)

Three things exist in the viewer-side space, and none is what we're building:

- **DeArrow** — the closest, but **community-voted, not AI.** Its weakness is exactly what I hit when I tried it: **half or more of videos are untagged.** That's the structural flaw of crowdsourcing — coverage is bounded by human effort, someone has to submit *and* vote on each video, so new uploads and anything below viral are simply blank. There's no systematic coverage of the firehose.
- **Clickbait Remover for YouTube** — purely cosmetic (reformats ALL-CAPS, swaps thumbnails for frames). No understanding of content.
- **IsThisClickbait** — AI, but an on-demand "analyze this one video" side panel, not a passive feed-wide rewriter.

Meanwhile every *AI* "YouTube title" tool on the market (VeeFly, vidIQ, TubeBuddy, Writesonic, Optimo, Hootsuite) is **creator-side and points the wrong way** — they generate *more* click-worthy/curiosity-driven titles to maximize clicks.

**So the open slot is: DeArrow's passive, browse-everywhere UX, but with AI-generated rewrites instead of crowdsourced ones — and no voting.** As of this writing, nobody appears to have shipped it. Confirming that "nobody's made this" is the current decision point.

Why AI is the right call over voting: an LLM has no cold-start. It can proactively process *any* video, bounded only by cost — not by whether a human bothered to submit it. That directly fixes DeArrow's "half untagged" problem on the videos that actually matter.

---

## How much ground would $150/mo actually cover?

The economics hinge on one fact: **you pay per *unique* video, once, and serve the cached rewrite to every user.** Cost is decoupled from views and from user count. $150 ≈ **~21,000 unique videos/month** processed (≈ $0.005 transcript + ~$0.0006 batched Haiku rewrite per video).

The instinct that 21k is "not bad for an American/English audience consuming mostly the same top-creator content" is **correct, and it's the crux of the whole project's viability.** Rough back-of-envelope:

- YouTube consumption is a steep power law. A mainstream English/American audience heavily overlaps — everyone's subscriptions feed is dominated by the same tier of big creators (mainstream news, big podcasts, top gaming/commentary/tech).
- The top ~1,000–1,500 English channels collectively upload on the order of **~15–25k new videos/month**. So 21k/month roughly equals **the entire monthly output of that whole top tier** — the exact videos most users actually see.
- Because you **prioritize by popularity** (process highest-view/top-channel videos first), the 21k you cover are the *head* of the distribution, not a random sample. So effective feed coverage runs much higher than "21k ÷ all of YouTube" would imply — plausibly **a rough 60–80% of a typical mainstream user's feed flipped**, with the misses being long-tail niche subscriptions that, by definition, few users share.
- **Counterintuitive payoff: a focused, overlapping audience is the *best* case, not the worst.** The more your users watch the same creators, the higher your cache-hit rate, the cheaper per-user, the better the coverage. The thing that breaks the economics is a globally sprawling userbase with zero overlap (all long tail). A tight American-mainstream niche is ideal.
- Net: this should **comfortably beat DeArrow's coverage on the videos that matter**, because you systematically cover the popularity head instead of waiting for volunteers.

*(All estimates are back-of-envelope with stated assumptions — channel counts and upload rates are illustrative, not measured. Worth validating against real subscription-feed data once there's a userbase.)*

---

## Architecture decisions locked in

- **Decouple read from write.** Feed load = batch cache read, **zero LLM calls**, instant title swaps for anything already done. Misses get enqueued and processed **async** by a worker. Spend is a dial you set, not a function of traffic. (You'll be *processing-bound, not money-bound* — feed is always a mix of flipped + original, popular-first.)
- **DB: DynamoDB on-demand**, single table, **PK = `videoId`** (the stable 11-char ID). *Not* caption+channel — titles are mutable and collide; that corrupts the cache. Kept the intent via a stored `channelId` + `originalTitleHash` so a creator editing a title is *detected* (hash mismatch → reprocess).
- **Transcripts: buy them, don't scrape (at first).** The official YouTube API doesn't expose transcripts at all, so everything's unofficial. Paid transcript APIs (e.g. Apify ~$0.005/video) absorb the proxy/ban-evasion pain. Build behind a provider interface with a **primary + backup + circuit breaker**.
- **Defer the scraper.** A centralized server scraper is the one path with both ban risk and an infra bill — skip it for v1.
- **Scale path (later): distributed client-side transcript harvesting.** The extension fetches transcripts from each user's own authenticated browser session via background `fetch()` (no clicking/navigating — just the calls the page already makes), politely (jitter, per-session caps, near-viewport only), and POSTs them back. No central IP to ban. Drops the transcript cost toward zero once traction makes it the binding constraint. Caveats: PO-token maintenance arms race, must throttle to protect the user's IP, validate contributions against poisoning, be transparent about it.
- **LLM: Claude Haiku 4.5 via the Batch API** (50% off, async worker makes batching free). ~$0.0006/video.
- **Thumbnails: client-side, no S3.** Point the `<img>` at YouTube's auto-sampled frames `i.ytimg.com/vi/{id}/{1,2,3}.jpg` (avoid `0.jpg`/`hqdefault.jpg` = the creator's clickbait thumb). Exact-timestamp frames need storyboard parsing — optional, not v1.
- **Bulletproofing:** AWS Budgets at 50/80/100% → email; a code-level monthly spend counter that trips a **kill switch** before the ceiling; CloudWatch alarms on transcript-provider outage (→ auto-failover + email), DLQ depth, LLM errors, and user-growth tiers; SQS DLQ; idempotent worker; extension **fails open** (backend down → original titles, YouTube never breaks).
- **Extension features:** title swap (MutationObserver, SPA-aware), translate-all toggle, per-channel allow/blocklist (client-side, free), thumbnail toggle, donate tip-jar (covers hosting at best, not income).

---

## The gate before building anything: Phase 0 eval

The make-or-break question isn't infra (all solved above) — it's **rewrite quality**, and specifically: **does a transcript-fed rewrite beat a title-only rewrite by enough to justify the transcript being the main cost?** If title-only is nearly as good, the whole ~$0.005/video transcript line gets deleted.

A runnable eval harness was built to answer exactly this:
- For each title, generate **both** rewrites (title-only on Haiku, title+transcript on Haiku).
- A **blind** Sonnet judge (randomized order) picks the better title for the real video and scores faithfulness / informativeness / sensationalism-removed.
- Aggregates **net win rate**, **faithfulness gain**, and **$ cost side-by-side**, then prints a hard verdict: transcripts justified only if B net-wins ≥20% *and* adds ≥0.40 faithfulness; else ship title-only and skip the cost.
- Seed dataset = 14 varied clickbait archetypes (curiosity gaps, health fear, finance vague-pronoun, listicles, get-rich, etc.) **plus 2 already-honest controls** to check the rewriter knows when to leave a good title alone. Transcripts deliberately expose mundane/disputed payoffs so the test is fair, not rigged for either side.

---

## Deliverables already produced

1. **SPEC.md** — full system spec (architecture + Mermaid diagrams, data model, worker strategy, cost model, resilience/failover, monitoring & alerting, future client-harvesting section, phased roadmap).
2. **BUILD_GUIDE.md** — agent-facing implementation doc (repo layout, API contracts, per-component build steps, SAM infra list, definition-of-done per phase).
3. **eval/dataset.jsonl** — 14-item seed eval set.
4. **eval/run-eval.ts** + **eval/package.json** — the title-only-vs-transcript A/B scoring script. Run with `ANTHROPIC_API_KEY` set, `npm install`, `npm run eval`.

---

## Where things stand / next steps

1. **Decide it's net-new** — confirm no AI viewer-side de-clickbaiter has shipped (current evidence: none has).
2. **Run the Phase 0 eval** — expand the dataset toward ~50 with *real* titles + their actual transcripts, then run it. This is an afternoon and it tells you whether transcripts are worth paying for *before* any backend exists.
3. If transcripts justify their cost → build Phase 1 (extension + resolve + DynamoDB + SQS worker + paid transcript API + Haiku batch + monitoring).
4. If title-only is close enough → ship a zero-transcript-cost v1 and revisit.
5. Distribution when ready: Show HN + privacy/de-Google subreddits (they already run SponsorBlock/DeArrow). Lead with the pitch "DeArrow without the voting, works on every video instantly," and have a crisp privacy answer ready (only videoId + public metadata, no user identifiers).
