export interface StackConfig {
  /** Vacío = sin configuración CORS en API Gateway. Nunca incluye `*`. */
  corsAllowedOrigins: string[];
  /** Hora UTC de la reposición diaria del catálogo. */
  publishTime: { hour: number; minute: number };
  scheduleEnabled: boolean;
  /** Hora UTC de la sincronización de la playlist: nunca antes de las 12:00 (corte D+1). */
  playlistSyncTime: { hour: number; minute: number };
  /** Independiente de `scheduleEnabled`: cada proceso se habilita por separado. */
  playlistScheduleEnabled: boolean;
}

type ContextReader = (key: string) => unknown;

const PUBLISH_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Prioridad: contexto de CDK (-c clave=valor), luego variable de entorno, luego default. */
export function resolveStackConfig(
  readContext: ContextReader,
  env: NodeJS.ProcessEnv,
): StackConfig {
  const read = (contextKey: string, envKey: string): string | undefined => {
    const value = readContext(contextKey) ?? env[envKey];
    return value === undefined || value === null ? undefined : String(value).trim();
  };

  return {
    corsAllowedOrigins: parseOrigins(read('corsAllowedOrigins', 'CORS_ALLOWED_ORIGINS')),
    publishTime: parsePublishTime(read('publishTimeUtc', 'PUBLISH_TIME_UTC') ?? '00:00'),
    scheduleEnabled: parseBoolean(read('scheduleEnabled', 'SCHEDULE_ENABLED') ?? 'false'),
    playlistSyncTime: parsePlaylistSyncTime(
      read('playlistSyncTimeUtc', 'PLAYLIST_SYNC_TIME_UTC') ?? '12:30',
    ),
    playlistScheduleEnabled: parseBoolean(
      read('playlistScheduleEnabled', 'PLAYLIST_SCHEDULE_ENABLED') ?? 'false',
    ),
  };
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map(validateOrigin);
  return [...new Set(origins)];
}

/** El despliegue es productivo: sin `*` y con https, salvo localhost para desarrollo. */
function validateOrigin(origin: string): string {
  const invalid = (reason: string) => new Error(`Invalid CORS origin "${origin}": ${reason}`);
  if (origin === '*') {
    throw invalid('wildcard is not allowed, list each origin explicitly');
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw invalid('use scheme://host[:port] without path or trailing slash');
  }
  if (url.origin !== origin) {
    throw invalid('use scheme://host[:port] without path or trailing slash');
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw invalid('use https (http is only accepted for localhost)');
  }
  return origin;
}

function parsePublishTime(raw: string): StackConfig['publishTime'] {
  const match = PUBLISH_TIME_PATTERN.exec(raw);
  if (!match) {
    throw new Error(`Invalid publish time "${raw}": expected HH:mm in UTC (e.g. 00:05)`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * La playlist solo puede incorporar la canción de D a partir de las 12:00 UTC de D+1. Programar
 * antes sería inútil (no habría nada elegible) y engañoso, así que se rechaza al sintetizar.
 */
function parsePlaylistSyncTime(raw: string): StackConfig['playlistSyncTime'] {
  const match = PUBLISH_TIME_PATTERN.exec(raw);
  if (!match) {
    throw new Error(`Invalid playlist sync time "${raw}": expected HH:mm in UTC (e.g. 12:30)`);
  }
  const time = { hour: Number(match[1]), minute: Number(match[2]) };
  if (time.hour < 12) {
    throw new Error(
      `Invalid playlist sync time "${raw}": must be 12:00 UTC or later (end of day in UTC-12)`,
    );
  }
  return time;
}

function parseBoolean(raw: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`Invalid boolean "${raw}": expected true or false`);
}
