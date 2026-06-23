import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  BatchGetItemCommand,
  BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});
const TABLE = process.env.TABLE_NAME!;
const QUEUE = process.env.QUEUE_URL!;

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

// ── POST /titles — batch lookup (what the extension calls) ────────────────────

interface VideoInput { videoId: string; title: string; creator: string }
interface VideoResult { rewrittenTitle: string | null; status: string }

async function handleBatch(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let videos: VideoInput[];
  try {
    videos = (JSON.parse(event.body ?? "{}").videos ?? []) as VideoInput[];
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "invalid JSON body" }) };
  }
  if (!videos.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "videos array required" }) };
  }

  const results: Record<string, VideoResult> = {};
  const trueMisses: VideoInput[] = [];

  // BatchGetItem reads up to 100 items per call
  for (const batch of chunk(videos, 100)) {
    const res = await ddb.send(new BatchGetItemCommand({
      RequestItems: { [TABLE]: { Keys: batch.map(v => ({ videoId: { S: v.videoId } })) } },
    }));

    const found = new Set<string>();
    for (const item of res.Responses?.[TABLE] ?? []) {
      const videoId = item.videoId.S!;
      found.add(videoId);
      if (item.rewrittenTitle?.S) {
        results[videoId] = { rewrittenTitle: item.rewrittenTitle.S, status: "hit" };
      } else {
        // Already pending in flight — don't re-enqueue
        results[videoId] = { rewrittenTitle: null, status: item.status?.S ?? "pending" };
      }
    }

    // True misses: not in DynamoDB at all
    for (const v of batch) {
      if (!found.has(v.videoId)) {
        trueMisses.push(v);
        results[v.videoId] = { rewrittenTitle: null, status: "pending" };
      }
    }
  }

  // Write pending markers + enqueue misses (fire-and-forget, don't block the response)
  if (trueMisses.length) {
    // Deduplicate (same videoId may appear in multiple page sections)
    const unique = [...new Map(trueMisses.map(v => [v.videoId, v])).values()];

    // BatchWriteItem — up to 25 per call
    Promise.all(
      chunk(unique, 25).map(batch =>
        ddb.send(new BatchWriteItemCommand({
          RequestItems: {
            [TABLE]: batch.map(v => ({
              PutRequest: {
                Item: {
                  videoId:      { S: v.videoId },
                  status:       { S: "pending" },
                  originalTitle:{ S: v.title },
                  creator:      { S: v.creator },
                  enqueuedAt:   { N: String(Date.now()) },
                },
              },
            })),
          },
        })).catch(() => {}) // items may already exist; ignore
      )
    );

    // SQS SendMessageBatch — up to 10 per call
    Promise.all(
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
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ results }) };
}

// ── GET /title/{videoId} — single lookup (kept for curl testing) ──────────────

async function handleSingle(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const videoId = event.pathParameters?.videoId;
  if (!videoId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "videoId required" }) };
  }

  const params = event.queryStringParameters ?? {};
  const originalTitle = params.title ? decodeURIComponent(params.title) : undefined;
  const creator       = params.creator ? decodeURIComponent(params.creator) : undefined;

  const { Item } = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { videoId: { S: videoId } },
  }));

  if (Item?.rewrittenTitle?.S) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ videoId, rewrittenTitle: Item.rewrittenTitle.S, status: "hit" }) };
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
        },
        ConditionExpression: "attribute_not_exists(videoId)",
      }));
      await sqs.send(new SendMessageCommand({
        QueueUrl: QUEUE,
        MessageBody: JSON.stringify({ videoId, originalTitle, creator }),
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
