import type { Route } from '@middy/http-router';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { addDays, getLocalDate, isIsoDate, type IsoDate } from '../shared/dates.ts';
import { isPublishedDate, PUBLICATION_START_DATE } from '../tracks/publication.ts';
import type { TrackRepository } from '../tracks/repository.ts';
import { toPublicTrack, type TrackListResponse, type TrackResponse } from './contracts.ts';
import { invalidDate, trackNotFound } from './errors.ts';
import { jsonResponse } from './http.ts';
import { encodeCursor, parseListQuery } from './pagination.ts';
import { parseTimeZone } from './timezone.ts';

export interface ApiDependencies {
  repository: TrackRepository;
  now: () => Date;
  /** Primera fecha pública; solo se cambia en entornos locales con datos de desarrollo. */
  publicationStartDate?: IsoDate;
}

type ApiRoute = Route<APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2>;

/** Rutas explícitas; deben coincidir con las declaradas en API Gateway (infra). */
export function createRoutes({
  repository,
  now,
  publicationStartDate = PUBLICATION_START_DATE,
}: ApiDependencies): ApiRoute[] {
  const respondWithTrack = async (
    date: string,
    today: IsoDate,
  ): Promise<APIGatewayProxyStructuredResultV2> => {
    // Futuras (en la zona del visitante) o previas al lanzamiento: mismo 404 que una fecha sin
    // canción, sin consultar la tabla.
    if (!isPublishedDate(date, today, publicationStartDate)) {
      throw trackNotFound(date);
    }
    const track = await repository.getByDate(date);
    if (!track) {
      throw trackNotFound(date);
    }
    const body: TrackResponse = { data: toPublicTrack(track) };
    return jsonResponse(200, body);
  };

  return [
    {
      method: 'GET',
      path: '/api/tracks/today',
      handler: (event: APIGatewayProxyEventV2) => {
        const today = getLocalDate(now(), parseTimeZone(event.queryStringParameters));
        return respondWithTrack(today, today);
      },
    },
    {
      method: 'GET',
      path: '/api/tracks/{date}',
      handler: (event: APIGatewayProxyEventV2) => {
        const date = event.pathParameters?.date;
        if (date === undefined || !isIsoDate(date)) {
          throw invalidDate();
        }
        const timeZone = parseTimeZone(event.queryStringParameters);
        return respondWithTrack(date, getLocalDate(now(), timeZone));
      },
    },
    {
      method: 'GET',
      path: '/api/tracks',
      handler: async (event: APIGatewayProxyEventV2) => {
        const { limit, before } = parseListQuery(event.queryStringParameters);
        const timeZone = parseTimeZone(event.queryStringParameters);
        // `before` es exclusivo: el tope es mañana local (hoy incluido) aunque el cursor sea mayor.
        const tomorrow = addDays(getLocalDate(now(), timeZone), 1);
        const page = await repository.list({
          limit,
          before: before !== undefined && before < tomorrow ? before : tomorrow,
        });
        // Orden descendente: al aparecer una fecha previa al lanzamiento, el resto también lo es.
        const items = page.items.filter((track) => track.date >= publicationStartDate);
        const last = items.at(-1);
        const hasMore =
          page.hasMore &&
          items.length === page.items.length &&
          last !== undefined &&
          last.date > publicationStartDate;
        const body: TrackListResponse = {
          data: items.map(toPublicTrack),
          pagination: {
            limit,
            nextCursor: hasMore && last ? encodeCursor(last.date) : null,
          },
        };
        return jsonResponse(200, body);
      },
    },
  ];
}
