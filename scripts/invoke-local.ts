import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { createApiHandler } from '../src/api/app.ts';
import { createTrackRepository } from '../src/tracks/create-repository.ts';

process.env.USE_DEV_FIXTURES ??= 'true';

// Uso: npm run invoke -- GET /api/tracks/today [--now=2027-01-10T12:00:00Z]
// `--now` fija el reloj del handler (solo local) para probar fechas sin esperar al día real.
const nowFlag = process.argv.find((arg) => arg.startsWith('--now='));
const clock = nowFlag ? new Date(nowFlag.slice('--now='.length)) : undefined;
if (clock && Number.isNaN(clock.getTime())) {
  throw new Error('--now must be an ISO 8601 instant, e.g. 2027-01-10T12:00:00Z');
}
const [method = 'GET', target = '/api/tracks/today'] = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith('--'));
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

const now = () => clock ?? new Date();
const handler = createApiHandler({
  repository: createTrackRepository(process.env, now()),
  now,
  // Las fixtures se generan alrededor de hoy: antes del lanzamiento la regla pública las ocultaría.
  ...(process.env.TRACKS_TABLE_NAME ? {} : { publicationStartDate: '1970-01-01' }),
});
const context = {
  awsRequestId: 'local-invoke',
  getRemainingTimeInMillis: () => 30_000,
} as unknown as Context;

const response = await handler(event, context);
console.log(JSON.stringify(response, null, 2));
