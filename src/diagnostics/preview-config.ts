import { isIsoDate, type IsoDate } from '../shared/dates.ts';
import { PUBLICATION_START_DATE } from '../tracks/publication.ts';

export const MAX_SAMPLES = 10;
export const DEFAULT_BUDGET_MS = 180_000;

export type PreviewMode = 'live' | 'simulate';

export interface PreviewOptions {
  date: IsoDate;
  count: number;
  catalogPath: string | undefined;
  budgetMs: number;
  json: boolean;
  /** Sin modo explícito no se hace ninguna llamada de red. */
  mode: PreviewMode | undefined;
  help: boolean;
}

export type ParseResult = { ok: true; options: PreviewOptions } | { ok: false; error: string };

const BOOLEAN_FLAGS = new Set(['--json', '--live', '--simulate', '--help']);

function parseInteger(flag: string, value: string, min: number, max: number): number | string {
  if (!/^\d+$/.test(value)) return `${flag} must be an integer`;
  const number = Number(value);
  return number >= min && number <= max ? number : `${flag} must be between ${min} and ${max}`;
}

/** Solo acepta la forma `--flag=valor`: es lo que reenvía `npm run preview:selection -- ...`. */
export function parsePreviewArgs(argv: readonly string[]): ParseResult {
  const options: PreviewOptions = {
    date: PUBLICATION_START_DATE,
    count: 1,
    catalogPath: undefined,
    budgetMs: DEFAULT_BUDGET_MS,
    json: false,
    mode: undefined,
    help: false,
  };
  let live = false;
  let simulate = false;

  for (const arg of argv) {
    if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === '--json') options.json = true;
      if (arg === '--live') live = true;
      if (arg === '--simulate') simulate = true;
      if (arg === '--help') options.help = true;
      continue;
    }
    const separator = arg.indexOf('=');
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    const value = separator === -1 ? '' : arg.slice(separator + 1);
    if (flag === '--date') {
      if (!isIsoDate(value)) return { ok: false, error: '--date must be a valid YYYY-MM-DD date' };
      options.date = value;
    } else if (flag === '--count') {
      const parsed = parseInteger('--count', value, 1, MAX_SAMPLES);
      if (typeof parsed === 'string') return { ok: false, error: parsed };
      options.count = parsed;
    } else if (flag === '--budget-ms') {
      const parsed = parseInteger('--budget-ms', value, 1, 3_600_000);
      if (typeof parsed === 'string') return { ok: false, error: parsed };
      options.budgetMs = parsed;
    } else if (flag === '--catalog') {
      if (value === '')
        return { ok: false, error: '--catalog needs a file path (--catalog=<file.json>)' };
      options.catalogPath = value;
    } else {
      return { ok: false, error: `Unknown or malformed argument: ${flag}` };
    }
  }

  if (live && simulate) return { ok: false, error: '--live and --simulate are mutually exclusive' };
  if (live) options.mode = 'live';
  if (simulate) options.mode = 'simulate';
  return { ok: true, options };
}

export interface PreviewCredentials {
  spotifyClientId: string;
  spotifyClientSecret: string;
  openAiApiKey: string;
  openAiModel: string;
}

export const CREDENTIAL_VARIABLES = [
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
] as const;

/** Credenciales solo desde variables de entorno. Devuelve los nombres faltantes, nunca valores. */
export function readCredentials(
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; credentials: PreviewCredentials } | { ok: false; missing: string[] } {
  const missing = CREDENTIAL_VARIABLES.filter((name) => !env[name]?.trim());
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    credentials: {
      spotifyClientId: (env.SPOTIFY_CLIENT_ID as string).trim(),
      spotifyClientSecret: (env.SPOTIFY_CLIENT_SECRET as string).trim(),
      openAiApiKey: (env.OPENAI_API_KEY as string).trim(),
      openAiModel: (env.OPENAI_MODEL as string).trim(),
    },
  };
}

export const USAGE = `Uso: npm run preview:selection -- [--date=YYYY-MM-DD] [--count=N] [--simulate | --live] [opciones]

Recorre el camino real de selección (OpenAI propone, Spotify resuelve, reglas locales validan)
sobre un catálogo local en memoria. No guarda ni publica nada.

Modo (obligatorio, sin él no se hace ninguna llamada de red):
  --simulate        respuestas HTTP simuladas y deterministas; no usa red ni credenciales
  --live            llama a OpenAI y Spotify de verdad (requiere autorización explícita)

Opciones:
  --date=YYYY-MM-DD fecha a preparar (por defecto ${PUBLICATION_START_DATE})
  --count=N         fechas consecutivas, acumuladas en memoria (1 a ${MAX_SAMPLES}, por defecto 1)
  --catalog=FILE    catálogo local: arreglo JSON de canciones preparadas (por defecto vacío)
  --budget-ms=N     presupuesto de tiempo por fecha (por defecto ${DEFAULT_BUDGET_MS})
  --json            informe en JSON
  --help            esta ayuda

Variables de entorno para --live: ${CREDENTIAL_VARIABLES.join(', ')}; opcional CRITERIA_WEIGHTS.
Salida: 0 todas seleccionadas, 2 alguna sin selección válida, 1 error.
`;
