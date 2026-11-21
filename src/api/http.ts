import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/**
 * Lo que es público depende de la zona horaria y del instante: una respuesta no debe
 * reutilizarse entre visitantes ni anticipar fechas en otra zona. `private, no-cache` impide
 * caches compartidas y obliga a revalidar; un CDN futuro debe incluir `timezone` en su clave.
 */
const CACHE_CONTROL = 'private, no-cache';

export function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': CACHE_CONTROL,
    },
    body: JSON.stringify(body),
  };
}
