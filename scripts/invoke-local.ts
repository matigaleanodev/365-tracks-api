// Uso: npm run invoke -- GET /api/tracks/today
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { createApiHandler } from '../src/api/app.ts';
import { createTrackRepository } from '../src/tracks/create-repository.ts';

process.env.USE_DEV_FIXTURES ??= 'true';

const [method = 'GET', target = '/api/tracks/today'] = process.argv.slice(2);
const url = new URL(target, 'http://localhost');

const event = {
  version: '2.0',
  routeKey: '$default',
  rawPath: url.pathname,
  rawQueryString: url.search.slice(1),
  headers: {},
  queryStringParameters: url.search ? Object.fromEntries(url.searchParams) : undefined,
  requestContext: {
    requestId: 'local-invoke',
    http: { method: method.toUpperCase(), path: url.pathname },
  },
  isBase64Encoded: false,
} as unknown as APIGatewayProxyEventV2;

const handler = createApiHandler({
  repository: createTrackRepository(process.env, new Date()),
  now: () => new Date(),
});
const context = {
  awsRequestId: 'local-invoke',
  getRemainingTimeInMillis: () => 30_000,
} as unknown as Context;

const response = await handler(event, context);
console.log(JSON.stringify(response, null, 2));
