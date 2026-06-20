import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const videoId = event.pathParameters?.videoId;
  if (!videoId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "videoId required" }) };
  }

  const params = event.queryStringParameters ?? {};
  const originalTitle = params.title ? decodeURIComponent(params.title) : undefined;
  const creator       = params.creator ? decodeURIComponent(params.creator) : undefined;

  const { Item } = await ddb.send(new GetItemCommand({
    TableName: process.env.TABLE_NAME!,
    Key: { videoId: { S: videoId } },
  }));

  // Cache hit — return the stored rewrite
  if (Item?.rewrittenTitle?.S) {
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ videoId, rewrittenTitle: Item.rewrittenTitle.S, status: "hit" }),
    };
  }

  // Already in flight — don't re-enqueue
  if (Item?.status?.S === "pending") {
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ videoId, rewrittenTitle: null, status: "pending" }),
    };
  }

  // Cache miss with enough info to process — mark pending and enqueue
  if (originalTitle && creator) {
    try {
      // Conditional write: only if item doesn't already exist (race-condition guard)
      await ddb.send(new PutItemCommand({
        TableName: process.env.TABLE_NAME!,
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
        QueueUrl:    process.env.QUEUE_URL!,
        MessageBody: JSON.stringify({ videoId, originalTitle, creator }),
      }));
    } catch (err: any) {
      // ConditionalCheckFailedException = another request already enqueued it, fine
      if (err.name !== "ConditionalCheckFailedException") throw err;
    }
  }

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ videoId, rewrittenTitle: null, status: "pending" }),
  };
};
