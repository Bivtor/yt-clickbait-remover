var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// index.ts
var index_exports = {};
__export(index_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(index_exports);
var import_client_dynamodb = require("@aws-sdk/client-dynamodb");
var import_client_sqs = require("@aws-sdk/client-sqs");
var ddb = new import_client_dynamodb.DynamoDBClient({});
var sqs = new import_client_sqs.SQSClient({});
var TABLE = process.env.TABLE_NAME;
var QUEUE = process.env.QUEUE_URL;
var THUMB_QUEUE = process.env.THUMB_QUEUE_URL;
var FRAME_VERSION = process.env.FRAME_VERSION;
var MAX_THUMB_ATTEMPTS = 5;
var THUMB_COOLDOWN_MS = 30 * 60 * 1e3;
var HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
async function handleBatch(event) {
  let videos;
  try {
    videos = JSON.parse(event.body ?? "{}").videos ?? [];
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "invalid JSON body" }) };
  }
  if (!videos.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "videos array required" }) };
  }
  const results = {};
  const trueMisses = [];
  const thumbReenqueue = [];
  for (const batch of chunk(videos, 100)) {
    const res = await ddb.send(new import_client_dynamodb.BatchGetItemCommand({
      RequestItems: { [TABLE]: { Keys: batch.map((v) => ({ videoId: { S: v.videoId } })) } }
    }));
    const found = /* @__PURE__ */ new Set();
    for (const item of res.Responses?.[TABLE] ?? []) {
      const videoId = item.videoId.S;
      found.add(videoId);
      if (item.rewrittenTitle?.S) {
        results[videoId] = { rewrittenTitle: item.rewrittenTitle.S, status: "hit", thumbUrl: item.thumbUrl?.S };
      } else {
        results[videoId] = { rewrittenTitle: null, status: item.status?.S ?? "pending", thumbUrl: item.thumbUrl?.S };
      }
      const missingThumb = !item.thumbUrl?.S;
      const staleThumb = !!item.thumbUrl?.S && !!FRAME_VERSION && item.thumbVersion?.S !== FRAME_VERSION;
      if ((missingThumb || staleThumb) && item.thumbStatus?.S !== "unavailable") {
        const attempts = parseInt(item.thumbAttempts?.N ?? "0", 10);
        const lastEnq = parseInt(item.thumbEnqueuedAt?.N ?? "0", 10);
        if (attempts < MAX_THUMB_ATTEMPTS && Date.now() - lastEnq > THUMB_COOLDOWN_MS) {
          thumbReenqueue.push(videoId);
        }
      }
    }
    for (const v of batch) {
      if (!found.has(v.videoId)) {
        trueMisses.push(v);
        results[v.videoId] = { rewrittenTitle: null, status: "pending" };
      }
    }
  }
  if (trueMisses.length) {
    const unique = [...new Map(trueMisses.map((v) => [v.videoId, v])).values()];
    Promise.all(
      chunk(unique, 25).map(
        (batch) => ddb.send(new import_client_dynamodb.BatchWriteItemCommand({
          RequestItems: {
            [TABLE]: batch.map((v) => ({
              PutRequest: {
                Item: {
                  videoId: { S: v.videoId },
                  status: { S: "pending" },
                  originalTitle: { S: v.title },
                  creator: { S: v.creator },
                  enqueuedAt: { N: String(Date.now()) },
                  thumbAttempts: { N: "1" },
                  // this enqueue counts as attempt 1
                  thumbEnqueuedAt: { N: String(Date.now()) }
                }
              }
            }))
          }
        })).catch(() => {
        })
        // items may already exist; ignore
      )
    );
    Promise.all(
      chunk(unique, 10).map(
        (batch, batchIdx) => sqs.send(new import_client_sqs.SendMessageBatchCommand({
          QueueUrl: QUEUE,
          Entries: batch.map((v, i) => ({
            Id: String(batchIdx * 10 + i),
            MessageBody: JSON.stringify({ videoId: v.videoId, originalTitle: v.title, creator: v.creator })
          }))
        })).catch(() => {
        })
      )
    );
    Promise.all(
      chunk(unique, 10).map(
        (batch, batchIdx) => sqs.send(new import_client_sqs.SendMessageBatchCommand({
          QueueUrl: THUMB_QUEUE,
          Entries: batch.map((v, i) => ({
            Id: String(batchIdx * 10 + i),
            MessageBody: JSON.stringify({ videoId: v.videoId })
          }))
        })).catch(() => {
        })
      )
    );
  }
  if (thumbReenqueue.length) {
    const unique = [...new Set(thumbReenqueue)];
    Promise.all(unique.map(
      (videoId) => ddb.send(new import_client_dynamodb.UpdateItemCommand({
        TableName: TABLE,
        Key: { videoId: { S: videoId } },
        UpdateExpression: "SET thumbEnqueuedAt = :now ADD thumbAttempts :one",
        ExpressionAttributeValues: { ":now": { N: String(Date.now()) }, ":one": { N: "1" } }
      })).catch(() => {
      })
    ));
    Promise.all(
      chunk(unique, 10).map(
        (batch, batchIdx) => sqs.send(new import_client_sqs.SendMessageBatchCommand({
          QueueUrl: THUMB_QUEUE,
          Entries: batch.map((videoId, i) => ({
            Id: String(batchIdx * 10 + i),
            MessageBody: JSON.stringify({ videoId })
          }))
        })).catch(() => {
        })
      )
    );
  }
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ results }) };
}
async function handleSingle(event) {
  const videoId = event.pathParameters?.videoId;
  if (!videoId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "videoId required" }) };
  }
  const params = event.queryStringParameters ?? {};
  const originalTitle = params.title ? decodeURIComponent(params.title) : void 0;
  const creator = params.creator ? decodeURIComponent(params.creator) : void 0;
  const { Item } = await ddb.send(new import_client_dynamodb.GetItemCommand({
    TableName: TABLE,
    Key: { videoId: { S: videoId } }
  }));
  if (Item?.rewrittenTitle?.S) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ videoId, rewrittenTitle: Item.rewrittenTitle.S, status: "hit", thumbUrl: Item.thumbUrl?.S }) };
  }
  if (Item?.status?.S === "pending") {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ videoId, rewrittenTitle: null, status: "pending" }) };
  }
  if (originalTitle && creator) {
    try {
      await ddb.send(new import_client_dynamodb.PutItemCommand({
        TableName: TABLE,
        Item: {
          videoId: { S: videoId },
          status: { S: "pending" },
          originalTitle: { S: originalTitle },
          creator: { S: creator },
          enqueuedAt: { N: String(Date.now()) }
        },
        ConditionExpression: "attribute_not_exists(videoId)"
      }));
      await sqs.send(new import_client_sqs.SendMessageCommand({
        QueueUrl: QUEUE,
        MessageBody: JSON.stringify({ videoId, originalTitle, creator })
      }));
      await sqs.send(new import_client_sqs.SendMessageCommand({
        QueueUrl: THUMB_QUEUE,
        MessageBody: JSON.stringify({ videoId })
      }));
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
    }
  }
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ videoId, rewrittenTitle: null, status: "pending" }) };
}
var handler = async (event) => {
  if (event.requestContext.http.method === "POST") return handleBatch(event);
  return handleSingle(event);
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
//# sourceMappingURL=index.js.map
