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
var HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};
var handler = async (event) => {
  const videoId = event.pathParameters?.videoId;
  if (!videoId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "videoId required" }) };
  }
  const params = event.queryStringParameters ?? {};
  const originalTitle = params.title ? decodeURIComponent(params.title) : void 0;
  const creator = params.creator ? decodeURIComponent(params.creator) : void 0;
  const { Item } = await ddb.send(new import_client_dynamodb.GetItemCommand({
    TableName: process.env.TABLE_NAME,
    Key: { videoId: { S: videoId } }
  }));
  if (Item?.rewrittenTitle?.S) {
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ videoId, rewrittenTitle: Item.rewrittenTitle.S, status: "hit" })
    };
  }
  if (Item?.status?.S === "pending") {
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ videoId, rewrittenTitle: null, status: "pending" })
    };
  }
  if (originalTitle && creator) {
    try {
      await ddb.send(new import_client_dynamodb.PutItemCommand({
        TableName: process.env.TABLE_NAME,
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
        QueueUrl: process.env.QUEUE_URL,
        MessageBody: JSON.stringify({ videoId, originalTitle, creator })
      }));
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
    }
  }
  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ videoId, rewrittenTitle: null, status: "pending" })
  };
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
//# sourceMappingURL=index.js.map
