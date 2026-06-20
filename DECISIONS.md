# De-Clickbait — Phase 0 Decisions

## What we tested

33 real YouTube videos. 30 scored (3 skipped — geo-blocked/no transcript). Three transcript context levels, Haiku 4.5 rewriter, Sonnet 4.6 blind judge.

## Eval results

| Context | Net win rate | Faithfulness gain | Call |
|---|---|---|---|
| words_1000 | 70% | +0.44 | ✅ justified |
| **words_3000** | **80%** | **+0.64** | ✅ **winner** |
| half (~4000w cap) | 53% | +0.41 | ✅ but most hallucinations |

## Decisions

**Use `words_3000` on Haiku 4.5.** Best win rate, best faithfulness, fewest hallucinations. The "half" level underperforms because it picks up mid-video tangents that contradict the intro/thesis, causing the model to write titles about tangential content.

**Keep Haiku 4.5, don't upgrade to Sonnet 4.6.** Sonnet costs 3× more per token and ~2.4× more per video end-to-end. That cuts monthly video coverage from ~16,100 to ~6,850 on the same $150 budget — for a model that lost to Haiku in the eval.

**Inject current date into the rewrite prompt.** Fixes "I/O 2024"-style hallucinations where the model defaults to its training-data year associations. One line: `Today's date: {ISO date}`. Done.

**Report title button (future feature).** The extension will include a "report bad title" button that surfaces rewrite errors to a human review queue. Most-reported titles get a manual cache override. This is the correction path for edge cases without requiring a model upgrade.

## Production config

```
Transcript provider : Supadata ($0.005/video, 1 req/sec, 1-day cache)
Rewrite model       : claude-haiku-4-5 via Batch API (50% off async)
Context level       : words_3000 (first 3,000 words)
Cost per video      : ~$0.005 transcript + ~$0.0003 batched Haiku = ~$0.0053
Videos at $150/mo   : ~28,000 (after ~$0 transcript amortized across users)
```

## What's next

Build Phase 1:
1. **Backend** — DynamoDB (cache) + SQS (queue) + Lambda worker (transcript → rewrite → cache write) + API Gateway (lookup endpoint)
2. **Extension** — Firefox Manifest V3, MutationObserver title/thumbnail swap, hits the API on feed load
