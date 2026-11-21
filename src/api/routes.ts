import type { Route } from '@middy/http-router';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { addDays, getLocalDate, isIsoDate, type IsoDate } from '../shared/dates.ts';
import { findIncompleteFields } from '../tracks/completeness.ts';
import { isPublishedDate, PUBLICATION_START_DATE } from '../tracks/publication.ts';
import type { TrackRepository } from '../tracks/repository.ts';
import type { DailyTrack } from '../tracks/types.ts';
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

/**
 * Páginas del repositorio que se recorren como máximo para completar una página pública cuando
 * hay registros incompletos intercalados. Acota el costo; si se agota, la página sale más corta
 * pero con un cursor válido que sigue avanzando, así que nunca hay bucles ni saltos.
 */
const MAX_SCAN_PAGES = 10;
/** Filas por lectura al buscar publicables: una racha de incompletas no vacía la página. */
const SCAN_PAGE_SIZE = 50;

/** Solo una canción completa puede ser pública; una incompleta equivale a "todavía no disponible". */
const isPublishable = (track: DailyTrack) => findIncompleteFields(track).length === 0;

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
    // Sin canción o incompleta: el mismo 404, sin revelar que existe un registro en preparación.
    if (!track || !isPublishable(track)) {
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
        let cursor: IsoDate = before !== undefined && before < tomorrow ? before : tomorrow;
        let items: DailyTrack[] = [];
        let more = true;
        for (
          let scanned = 0;
          scanned < MAX_SCAN_PAGES && items.length <= limit && more;
          scanned += 1
        ) {
          const page = await repository.list({ limit: SCAN_PAGE_SIZE, before: cursor });
          const last = page.items.at(-1);
          if (last === undefined) {
            more = false;
            break;
          }
          // Orden descendente: al aparecer una fecha previa al lanzamiento, el resto también lo es.
          const inRange = page.items.filter((track) => track.date >= publicationStartDate);
          items = items.concat(inRange.filter(isPublishable));
          more =
            page.hasMore &&
            inRange.length === page.items.length &&
            last.date > publicationStartDate;
          cursor = last.date;
        }
        // Se entrega como máximo `limit`; el cursor es la última fecha entregada si se recortó, o la
        // última revisada si no (así las incompletas descartadas no se vuelven a recorrer).
        if (items.length > limit) {
          items = items.slice(0, limit);
          more = true;
          cursor = (items.at(-1) as DailyTrack).date;
        }
        const body: TrackListResponse = {
          data: items.map(toPublicTrack),
          pagination: {
            limit,
            nextCursor: more ? encodeCursor(cursor) : null,
          },
        };
        return jsonResponse(200, body);
      },
    },
  ];
}
