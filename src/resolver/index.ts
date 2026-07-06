import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  BatchGetItemCommand,
  BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});
const TABLE = process.env.TABLE_NAME!;
const QUEUE = process.env.QUEUE_URL!;
const THUMB_QUEUE = process.env.THUMB_QUEUE_URL!;
// Current frame-selection heuristic version. Items whose stored thumbVersion differs are
// re-enqueued (lazily, as viewed) so a heuristic change re-extracts old thumbnails.
const FRAME_VERSION = process.env.FRAME_VERSION;

// Thumbnail self-heal: an item can exist (title done) but have no thumbUrl yet —
// either it predates the thumb pipeline or an earlier extraction failed (e.g. proxy
// outage). The resolver re-enqueues a thumb job for such items when viewed, bounded so
// we don't spam a permanently-unextractable video (live/age-restricted/deleted).
const MAX_THUMB_ATTEMPTS = 5;
const THUMB_COOLDOWN_MS  = 30 * 60 * 1000;   // >= worst-case in-flight (3 SQS retries) + slack

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Abuse guard: a request full of bogus 11-char-looking IDs would enqueue an LLM title job +
// a proxy thumb job for each novel one (the real cost vector). Only accept strings that match
// YouTube's videoId shape, and cap how many we'll process per request. A garbage POST then
// costs at most one cheap BatchGetItem, never a fan-out of workers.
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_VIDEOS_PER_REQUEST = 200;
// Client-supplied title/creator become LLM prompt content and shared-cache data, so cap
// their size (real YouTube titles are <=100 chars; a multi-KB "title" is abuse) — the
// worker independently re-fetches the authoritative title via oEmbed before rewriting.
const MAX_TITLE_LEN = 300;
const MAX_CREATOR_LEN = 100;
const isValidVideoId = (id: unknown): id is string =>
  typeof id === "string" && VIDEO_ID_RE.test(id);
const clip = (s: unknown, max: number): string =>
  typeof s === "string" ? s.slice(0, max) : "";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── POST /titles — batch lookup (what the extension calls) ────────────────────

interface VideoInput { videoId: string; title: string; creator: string }
interface VideoResult { rewrittenTitle: string | null; status: string; thumbUrl?: string }

async function handleBatch(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let videos: VideoInput[];
  try {
    videos = (JSON.parse(event.body ?? "{}").videos ?? []) as VideoInput[];
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "invalid JSON body" }) };
  }
  if (!Array.isArray(videos) || !videos.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "videos array required" }) };
  }
  // Drop anything that isn't a well-formed videoId, then cap the batch. Silently ignore the
  // rest (a legit page never sends malformed IDs; an abuser gets nothing enqueued).
  // Title/creator are clipped, never trusted at arbitrary length.
  videos = videos
    .filter(v => v && isValidVideoId(v.videoId))
    .slice(0, MAX_VIDEOS_PER_REQUEST)
    .map(v => ({
      videoId: v.videoId,
      title:   clip(v.title, MAX_TITLE_LEN),
      creator: clip(v.creator, MAX_CREATOR_LEN),
    }));
  if (!videos.length) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ results: {} }) };
  }

  const results: Record<string, VideoResult> = {};
  const trueMisses: VideoInput[] = [];
  const thumbReenqueue: string[] = [];   // existing items missing a thumbnail → self-heal

  // BatchGetItem reads up to 100 items per call
  for (const batch of chunk(videos, 100)) {
    // BatchGetItem may return partial results under throttling (UnprocessedKeys). Retry
    // those with backoff; anything STILL unread is "unknown", NOT a miss — treating it as
    // a miss would blind-Put a pending marker over a completed item and wipe its
    // rewrittenTitle/thumbUrl. Unknowns just report "pending" and get re-read next poll.
    let keys = batch.map(v => ({ videoId: { S: v.videoId } }));
    const items = [];
    for (let attempt = 0; attempt < 3 && keys.length; attempt++) {
      if (attempt > 0) await sleep(50 * 2 ** attempt);
      const res = await ddb.send(new BatchGetItemCommand({
        RequestItems: { [TABLE]: { Keys: keys } },
      }));
      items.push(...(res.Responses?.[TABLE] ?? []));
      keys = (res.UnprocessedKeys?.[TABLE]?.Keys ?? []) as typeof keys;
    }
    const unknown = new Set(keys.map(k => k.videoId.S!));

    const found = new Set<string>();
    for (const item of items) {
      const videoId = item.videoId.S!;
      found.add(videoId);
      if (item.rewrittenTitle?.S) {
        results[videoId] = { rewrittenTitle: item.rewrittenTitle.S, status: "hit", thumbUrl: item.thumbUrl?.S };
      } else {
        // Title already pending in flight — don't re-enqueue the title
        results[videoId] = { rewrittenTitle: null, status: item.status?.S ?? "pending", thumbUrl: item.thumbUrl?.S };
      }

      // Self-heal the thumbnail: re-enqueue a thumb job when the item has NO frame yet,
      // OR has one from an OLD heuristic version (FRAME_VERSION bumped → lazy re-extract
      // as viewed). Bounded by attempts + cooldown so permanent failures don't loop, and
      // skipped for "unavailable" items (age-gated/paid/removed) that can never yield a frame.
      const missingThumb = !item.thumbUrl?.S;
      const staleThumb   = !!item.thumbUrl?.S && !!FRAME_VERSION
                           && item.thumbVersion?.S !== FRAME_VERSION;
      if ((missingThumb || staleThumb) && item.thumbStatus?.S !== "unavailable") {
        const attempts = parseInt(item.thumbAttempts?.N ?? "0", 10);
        const lastEnq  = parseInt(item.thumbEnqueuedAt?.N ?? "0", 10);
        if (attempts < MAX_THUMB_ATTEMPTS && Date.now() - lastEnq > THUMB_COOLDOWN_MS) {
          thumbReenqueue.push(videoId);
        }
      }
    }

    // True misses: not in DynamoDB at all. Unknowns (unread after retries) are NOT
    // misses — report pending, don't enqueue, and let the next poll re-read them.
    for (const v of batch) {
      if (unknown.has(v.videoId)) {
        results[v.videoId] = { rewrittenTitle: null, status: "pending" };
      } else if (!found.has(v.videoId)) {
        trueMisses.push(v);
        results[v.videoId] = { rewrittenTitle: null, status: "pending" };
      }
    }
  }

  // Write pending markers + enqueue misses. These MUST be awaited before returning:
  // Lambda freezes the environment as soon as the handler resolves, so un-awaited
  // promises may run much later or never (lost enqueues, lost cooldown stamps →
  // duplicate proxy extractions). Costs ~tens of ms on a miss; hits skip this entirely.
  const pendingWrites: Promise<unknown>[] = [];
  if (trueMisses.length) {
    // Deduplicate (same videoId may appear in multiple page sections)
    const unique = [...new Map(trueMisses.map(v => [v.videoId, v])).values()];

    // BatchWriteItem — up to 25 per call
    pendingWrites.push(...
      chunk(unique, 25).map(batch =>
        ddb.send(new BatchWriteItemCommand({
          RequestItems: {
            [TABLE]: batch.map(v => ({
              PutRequest: {
                Item: {
                  videoId:        { S: v.videoId },
                  status:         { S: "pending" },
                  originalTitle:  { S: v.title },
                  creator:        { S: v.creator },
                  enqueuedAt:     { N: String(Date.now()) },
                  thumbAttempts:  { N: "1" },                  // this enqueue counts as attempt 1
                  thumbEnqueuedAt:{ N: String(Date.now()) },
                },
              },
            })),
          },
        })).catch(() => {}) // items may already exist; ignore
      )
    );

    // SQS SendMessageBatch — up to 10 per call (title queue)
    pendingWrites.push(...
      chunk(unique, 10).map((batch, batchIdx) =>
        sqs.send(new SendMessageBatchCommand({
          QueueUrl: QUEUE,
          Entries: batch.map((v, i) => ({
            Id: String(batchIdx * 10 + i),
            MessageBody: JSON.stringify({ videoId: v.videoId, originalTitle: v.title, creator: v.creator }),
          })),
        })).catch(() => {})
      )
    );

    // Thumbnail queue — separate worker, only needs the videoId
    pendingWrites.push(...
      chunk(unique, 10).map((batch, batchIdx) =>
        sqs.send(new SendMessageBatchCommand({
          QueueUrl: THUMB_QUEUE,
          Entries: batch.map((v, i) => ({
            Id: String(batchIdx * 10 + i),
            MessageBody: JSON.stringify({ videoId: v.videoId }),
          })),
        })).catch(() => {})
      )
    );
  }

  // ── Self-heal: re-enqueue thumb jobs for existing items that still lack a frame ──
  if (thumbReenqueue.length) {
    const unique = [...new Set(thumbReenqueue)];

    // Bump attempts + stamp the enqueue time (cooldown guard reads these next time).
    pendingWrites.push(...unique.map(videoId =>
      ddb.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: { videoId: { S: videoId } },
        UpdateExpression: "SET thumbEnqueuedAt = :now ADD thumbAttempts :one",
        ExpressionAttributeValues: { ":now": { N: String(Date.now()) }, ":one": { N: "1" } },
      })).catch(() => {})
    ));

    pendingWrites.push(...
      chunk(unique, 10).map((batch, batchIdx) =>
        sqs.send(new SendMessageBatchCommand({
          QueueUrl: THUMB_QUEUE,
          Entries: batch.map((videoId, i) => ({
            Id: String(batchIdx * 10 + i),
            MessageBody: JSON.stringify({ videoId }),
          })),
        })).catch(() => {})
      )
    );
  }

  await Promise.all(pendingWrites);
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ results }) };
}

// ── GET /title/{videoId} — single lookup (kept for curl testing) ──────────────

async function handleSingle(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const videoId = event.pathParameters?.videoId;
  if (!isValidVideoId(videoId)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "valid videoId required" }) };
  }

  // NOTE: API Gateway v2 already URL-decodes queryStringParameters — decoding again
  // corrupts legit %xx sequences and throws URIError on a bare "%" in the title.
  const params = event.queryStringParameters ?? {};
  const originalTitle = params.title ? clip(params.title, MAX_TITLE_LEN) : undefined;
  const creator       = params.creator ? clip(params.creator, MAX_CREATOR_LEN) : undefined;

  const { Item } = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { videoId: { S: videoId } },
  }));

  if (Item?.rewrittenTitle?.S) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ videoId, rewrittenTitle: Item.rewrittenTitle.S, status: "hit", thumbUrl: Item.thumbUrl?.S }) };
  }
  if (Item?.status?.S === "pending") {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ videoId, rewrittenTitle: null, status: "pending" }) };
  }

  if (originalTitle && creator) {
    try {
      await ddb.send(new PutItemCommand({
        TableName: TABLE,
        Item: {
          videoId:      { S: videoId },
          status:       { S: "pending" },
          originalTitle:{ S: originalTitle },
          creator:      { S: creator },
          enqueuedAt:   { N: String(Date.now()) },
          // Same self-heal bookkeeping as the batch path — without these the next
          // batch view sees attempts=0/lastEnq=0 and immediately re-enqueues a
          // duplicate thumb extraction.
          thumbAttempts:  { N: "1" },
          thumbEnqueuedAt:{ N: String(Date.now()) },
        },
        ConditionExpression: "attribute_not_exists(videoId)",
      }));
      await sqs.send(new SendMessageCommand({
        QueueUrl: QUEUE,
        MessageBody: JSON.stringify({ videoId, originalTitle, creator }),
      }));
      await sqs.send(new SendMessageCommand({
        QueueUrl: THUMB_QUEUE,
        MessageBody: JSON.stringify({ videoId }),
      }));
    } catch (err: any) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
    }
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ videoId, rewrittenTitle: null, status: "pending" }) };
}

// ── Router ────────────────────────────────────────────────────────────────────

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  if (event.requestContext.http.method === "POST") return handleBatch(event);
  return handleSingle(event);
};
