import type { Route } from '@middy/http-router';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getEditorialDate, isIsoDate } from '../shared/dates.ts';
import type { TrackRepository } from '../tracks/repository.ts';
import type { TrackListResponse, TrackResponse } from './contracts.ts';
import { invalidDate, trackNotFound } from './errors.ts';
import { jsonResponse } from './http.ts';
import { encodeCursor, parseListQuery } from './pagination.ts';

export interface ApiDependencies {
  repository: TrackRepository;
  now: () => Date;
}

type ApiRoute = Route<APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2>;

/** Rutas explícitas; deben coincidir con las declaradas en API Gateway (infra). */
export function createRoutes({ repository, now }: ApiDependencies): ApiRoute[] {
  const respondWithTrack = async (date: string): Promise<APIGatewayProxyStructuredResultV2> => {
    const track = await repository.getByDate(date);
    if (!track) {
      throw trackNotFound(date);
    }
    const body: TrackResponse = { data: track };
    return jsonResponse(200, body);
  };

  return [
    {
      method: 'GET',
      path: '/api/tracks/today',
      handler: () => respondWithTrack(getEditorialDate(now())),
    },
    {
      method: 'GET',
      path: '/api/tracks/{date}',
      handler: (event: APIGatewayProxyEventV2) => {
        const date = event.pathParameters?.date;
        if (date === undefined || !isIsoDate(date)) {
          throw invalidDate();
        }
        return respondWithTrack(date);
      },
    },
    {
      method: 'GET',
      path: '/api/tracks',
      handler: async (event: APIGatewayProxyEventV2) => {
        const { limit, before } = parseListQuery(event.queryStringParameters);
        const page = await repository.list(before === undefined ? { limit } : { limit, before });
        const last = page.items.at(-1);
        const body: TrackListResponse = {
          data: page.items,
          pagination: {
            limit,
            nextCursor: page.hasMore && last ? encodeCursor(last.date) : null,
          },
        };
        return jsonResponse(200, body);
      },
    },
  ];
}
