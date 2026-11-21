export interface StackConfig {
  /** Vacío = sin configuración CORS en API Gateway. */
  corsAllowedOrigins: string[];
  publishTime: { hour: number; minute: number };
  scheduleEnabled: boolean;
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
  };
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map((origin) => {
      if (origin === '*') {
        return origin;
      }
      try {
        const url = new URL(origin);
        if (url.origin !== origin) {
          throw new Error('not an origin');
        }
        return origin;
      } catch {
        throw new Error(
          `Invalid CORS origin "${origin}": use scheme://host[:port] without path or trailing slash`,
        );
      }
    });
}

function parsePublishTime(raw: string): StackConfig['publishTime'] {
  const match = PUBLISH_TIME_PATTERN.exec(raw);
  if (!match) {
    throw new Error(`Invalid publish time "${raw}": expected HH:mm in UTC (e.g. 00:05)`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function parseBoolean(raw: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`Invalid boolean "${raw}": expected true or false`);
}
