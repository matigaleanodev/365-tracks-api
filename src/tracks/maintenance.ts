import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { DEFAULT_ARTIST_COOLDOWN_DAYS } from '../music-selection/rules.ts';
import type { IsoDate } from '../shared/dates.ts';
import { artistControlKeys } from './artist-key.ts';
import {
  ARTISTS_PARTITION,
  CLAIMS_PARTITION,
  idClaimKey,
  recordingClaimKey,
  TRACKS_PARTITION,
} from './dynamo-repository.ts';
import { isPublicSomewhere } from './publication.ts';
import type { DailyTrack } from './types.ts';

/**
 * Operaciones de mantenimiento sobre los registros de control (`CLAIM` y `ARTIST`). Son para el
 * operador, con un perfil autorizado y con los escritores del catálogo detenidos (schedules
 * deshabilitados): no están expuestas a ninguna Lambda.
 */

const DAY_MS = 86_400_000;
const daysBetween = (a: IsoDate, b: IsoDate) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;

export interface ReindexReport {
  tracks: number;
  /** Registros de control creados o completados (en dry-run o bloqueado, los que se crearían). */
  written: number;
  /** Inconsistencias legibles; cualquiera de ellas bloquea toda escritura. */
  conflicts: string[];
  /** Registros de artista sin fechas que ninguna canción produce: no reservan nada, no bloquean. */
  emptyArtistRecords: string[];
  /** Hay conflictos: no se escribió nada, ni siquiera con `write: true`. */
  blocked: boolean;
}

/** Claves largas (p. ej. `namehash#...`) acortadas para que el informe sea legible. */
const short = (key: string) => (key.length > 60 ? `${key.slice(0, 60)}…` : key);

/** Lee una partición completa con consistencia fuerte, siguiendo `LastEvaluatedKey`. */
async function readPartition(
  client: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const { Items = [], LastEvaluatedKey } = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ConsistentRead: true,
        ...(startKey && { ExclusiveStartKey: startKey }),
      }),
    );
    items.push(...Items);
    startKey = LastEvaluatedKey;
  } while (startKey);
  return items;
}

/** Hallazgo reparable con una operación sobre un registro de control (nunca sobre `TRACK`). */
export type ControlFinding =
  | { kind: 'orphan-claim'; key: string; heldBy: IsoDate; reason: string }
  | { kind: 'legacy-artist'; key: string; version: number; dates: IsoDate[] }
  | {
      kind: 'orphan-artist-dates';
      key: string;
      version: number;
      dates: IsoDate[];
      validDates: IsoDate[];
    };

/** Resultado estructurado de la auditoría de la tabla (instantánea con lecturas consistentes). */
export interface ControlAudit {
  tracks: number;
  /** Todas las inconsistencias, legibles; cualquiera bloquea la escritura de `reindex`. */
  conflicts: string[];
  /** Registros de artista vacíos sin canción que los produzca: no bloquean. */
  emptyArtistRecords: string[];
  /** Reservas que faltan (fecha titular = primera canción que deriva la clave). */
  missingClaims: { key: string; trackDate: IsoDate }[];
  /** Registros de artista ausentes o sin alguna de sus fechas válidas. */
  staleArtists: {
    key: string;
    dates: IsoDate[];
    current: { dates: IsoDate[]; version: number } | undefined;
  }[];
  /** Lo que `planControlRepair` puede corregir. */
  findings: ControlFinding[];
  /** Lo que requiere decisión humana (`remove`, edición editorial): nunca se autocorrige. */
  unresolved: string[];
}

/**
 * Audita la propia tabla (TRACK, CLAIM y ARTIST) con lecturas consistentes y paginadas, y deriva
 * de las canciones qué reservas y artistas deben existir. No escribe.
 *
 * IMPORTANTE: es una instantánea. TODOS los escritores deben estar detenidos mientras corre
 * (schedules de reposición, `load-track`, scripts de catálogo).
 */
export async function auditControlRecords(
  client: DynamoDBDocumentClient,
  tableName: string,
): Promise<ControlAudit> {
  const [trackItems, claimItems, artistItems] = await Promise.all([
    readPartition(client, tableName, TRACKS_PARTITION),
    readPartition(client, tableName, CLAIMS_PARTITION),
    readPartition(client, tableName, ARTISTS_PARTITION),
  ]);
  const tracks = (trackItems as unknown as (DailyTrack & { pk: string })[]).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const audit: ControlAudit = {
    tracks: tracks.length,
    conflicts: [],
    emptyArtistRecords: [],
    missingClaims: [],
    staleArtists: [],
    findings: [],
    unresolved: [],
  };
  const conflict = (message: string, unresolved = false) => {
    audit.conflicts.push(message);
    if (unresolved) audit.unresolved.push(message);
  };

  // Lo que las canciones exigen: clave -> fechas que la derivan (ascendentes; la primera es titular).
  const claimDerivers = new Map<string, IsoDate[]>();
  const artistDerivers = new Map<string, IsoDate[]>();
  for (const track of tracks) {
    for (const key of [
      idClaimKey(track.spotifyTrackId),
      recordingClaimKey(track.title, track.artist),
    ]) {
      const dates = claimDerivers.get(key) ?? [];
      if (dates[0]) {
        conflict(
          `${track.date} repite la canción o grabación de ${dates[0]} (${key.split('#')[0]})`,
          true,
        );
      }
      claimDerivers.set(key, [...dates, track.date]);
    }
    for (const key of artistControlKeys(track)) {
      const dates = artistDerivers.get(key) ?? [];
      const near = dates.find(
        (date) => daysBetween(date, track.date) < DEFAULT_ARTIST_COOLDOWN_DAYS,
      );
      if (near) {
        conflict(`${track.date} está a menos de 60 días de ${near} (mismo artista)`, true);
      }
      artistDerivers.set(key, [...dates, track.date]);
    }
  }

  const trackDates = new Set(tracks.map((track) => track.date));
  const existingClaims = new Set<string>();
  for (const item of claimItems) {
    const key = String(item.date);
    const heldBy = item.trackDate as IsoDate;
    const kind = key.split('#')[0];
    existingClaims.add(key);
    const derivers = claimDerivers.get(key) ?? [];
    const orphanReason = !trackDates.has(heldBy)
      ? 'no hay canción en esa fecha'
      : !derivers.includes(heldBy)
        ? 'esa canción no deriva la clave'
        : undefined;
    if (orphanReason) {
      conflict(`reserva huérfana (${kind}) a nombre de ${heldBy}: ${orphanReason}`);
      audit.findings.push({ kind: 'orphan-claim', key, heldBy, reason: orphanReason });
    }
    if (derivers[0] && derivers[0] !== heldBy) {
      // Si la fecha titular sí deriva la clave no es huérfana: requiere decisión editorial.
      conflict(
        `reserva (${kind}) a nombre de ${heldBy}, pero la clave la deriva la canción de ${derivers[0]}`,
        !orphanReason,
      );
    }
  }

  const existingArtists = new Map<string, { dates: IsoDate[]; version: number }>();
  for (const item of artistItems) {
    const key = String(item.date);
    const dates = (item.dates as IsoDate[] | undefined) ?? [];
    const version = item.version as number;
    existingArtists.set(key, { dates, version });
    const producers = artistDerivers.get(key);
    if (!producers && dates.length === 0) {
      // Queda así tras `removeTrack` de la última fecha del artista: inofensivo.
      audit.emptyArtistRecords.push(key);
      continue;
    }
    if (!producers) {
      conflict(
        `registro de artista ${short(key)} no lo produce ninguna canción (clave heredada u huérfana)`,
      );
      audit.findings.push({ kind: 'legacy-artist', key, version, dates });
      continue;
    }
    const invalid = dates.filter((d) => !producers.includes(d));
    for (const date of invalid) {
      conflict(
        `registro de artista ${short(key)} incluye ${date}, que no tiene canción que lo derive (fecha huérfana o incorrecta)`,
      );
    }
    if (invalid.length > 0) {
      audit.findings.push({
        kind: 'orphan-artist-dates',
        key,
        version,
        dates,
        validDates: dates.filter((d) => producers.includes(d)),
      });
    }
  }

  // Lo que falta: reservas ausentes y artistas sin alguna de sus fechas.
  audit.missingClaims = [...claimDerivers]
    .filter(([key]) => !existingClaims.has(key))
    .map(([key, dates]) => ({ key, trackDate: dates[0]! }));
  audit.staleArtists = [...artistDerivers]
    .map(([key, dates]) => ({ key, dates: [...dates].sort(), current: existingArtists.get(key) }))
    .filter(({ dates, current }) => !current || [...current.dates].sort().join() !== dates.join());
  return audit;
}

/**
 * Completa los registros de control de un catálogo anterior a las transacciones, o repara los que
 * falten, a partir de `auditControlRecords` (ver su advertencia: escritores detenidos).
 *
 * Conflictos (si hay alguno, NO escribe nada, ni con `write: true`):
 * 1. reserva cuya fecha titular difiere de la fecha de la canción que deriva esa clave;
 * 2. reserva huérfana: su fecha no tiene canción, o esa canción no deriva la clave;
 * 3. registro de artista con fechas sin canción que lo derive, o con fechas cuya clave ninguna
 *    canción produce (incluye claves heredadas); los vacíos (tras `removeTrack`) solo se listan;
 * 4. canciones repetidas (ID o grabación) o del mismo artista a menos de 60 días.
 * Sin conflictos escribe registro a registro con condición (`attribute_not_exists` / versión):
 * es idempotente y reanudable; tras un corte, repetirlo reconoce lo ya escrito y completa el resto.
 * Es solo para el operador: ninguna Lambda lo usa. No borra ni reasigna nada: para huérfanos y
 * claves heredadas ver `planControlRepair`; para repetidos reales, `removeTrack`.
 */
export async function reindexControlRecords(
  client: DynamoDBDocumentClient,
  tableName: string,
  { write }: { write: boolean },
): Promise<ReindexReport> {
  const audit = await auditControlRecords(client, tableName);
  const report: ReindexReport = {
    tracks: audit.tracks,
    written: audit.missingClaims.length + audit.staleArtists.length,
    conflicts: audit.conflicts,
    emptyArtistRecords: audit.emptyArtistRecords,
    blocked: audit.conflicts.length > 0,
  };
  if (report.blocked || !write) return report;

  report.written = 0;
  for (const { key, trackDate } of audit.missingClaims) {
    await put(
      client,
      tableName,
      { pk: CLAIMS_PARTITION, date: key, trackDate },
      { ConditionExpression: 'attribute_not_exists(pk)' },
    );
    report.written += 1;
  }
  for (const { key, dates, current } of audit.staleArtists) {
    await put(
      client,
      tableName,
      { pk: ARTISTS_PARTITION, date: key, dates, version: (current?.version ?? 0) + 1 },
      current
        ? {
            ConditionExpression: '#version = :version',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':version': current.version },
          }
        : { ConditionExpression: 'attribute_not_exists(pk)' },
    );
    report.written += 1;
  }
  return report;
}

/** Operación de reparación sobre un registro de control. Las condiciones las arma `apply`. */
export interface ControlRepairOp {
  action: 'delete' | 'put';
  pk: 'CLAIM' | 'ARTIST';
  key: string;
  reason: string;
  /** Estado de la auditoría: `trackDate` para reservas, `version` para artistas. */
  expect: { trackDate?: IsoDate; version?: number };
  /** Solo `put` sobre ARTIST: fechas válidas que se conservan. */
  dates?: IsoDate[];
}

export interface ControlRepairPlan {
  ops: ControlRepairOp[];
  unresolved: string[];
}

/** Tope de ítems de una transacción de DynamoDB: el plan se aplica en lotes de este tamaño. */
export const MAX_TRANSACTION_ITEMS = 100;

/**
 * Plan de reparación a partir de la auditoría: borra reservas huérfanas y registros de artista
 * heredados, y quita de un registro de artista las fechas sin canción. Solo CLAIM y ARTIST; los
 * repetidos entre canciones y las reservas de una fecha que sí deriva la clave quedan en
 * `unresolved` (hay que decidir con `remove` o una edición editorial).
 */
export function planControlRepair(audit: ControlAudit): ControlRepairPlan {
  const ops = audit.findings.map((finding): ControlRepairOp => {
    if (finding.kind === 'orphan-claim') {
      return {
        action: 'delete',
        pk: CLAIMS_PARTITION,
        key: finding.key,
        reason: `reserva huérfana a nombre de ${finding.heldBy}: ${finding.reason}`,
        expect: { trackDate: finding.heldBy },
      };
    }
    if (finding.kind === 'legacy-artist') {
      return {
        action: 'delete',
        pk: ARTISTS_PARTITION,
        key: finding.key,
        reason: 'registro de artista que ninguna canción produce (clave heredada)',
        expect: { version: finding.version },
      };
    }
    return {
      action: 'put',
      pk: ARTISTS_PARTITION,
      key: finding.key,
      reason: 'fechas sin canción que derive esta clave de artista',
      expect: { version: finding.version },
      dates: finding.validDates,
    };
  });
  return { ops, unresolved: [...audit.unresolved] };
}

export class InvalidRepairPlanError extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Valida un plan (p. ej. leído de un archivo) de forma estricta; lanza `InvalidRepairPlanError`. */
export function parseControlRepairPlan(raw: unknown): ControlRepairPlan {
  const invalid = (message: string): never => {
    throw new InvalidRepairPlanError(`Plan inválido: ${message}`);
  };
  const plan = raw as Partial<ControlRepairPlan> | null;
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.ops)) invalid('falta `ops`');
  const { ops } = plan as ControlRepairPlan;
  const seen = new Set<string>();
  for (const op of ops) {
    const where = `${String(op?.pk)}|${String(op?.key)}`;
    if (op?.pk !== CLAIMS_PARTITION && op?.pk !== ARTISTS_PARTITION) {
      invalid(`${where}: solo se permiten CLAIM y ARTIST`);
    }
    if (typeof op.key !== 'string' || op.key === '') invalid(`${where}: clave vacía`);
    if (seen.has(where)) invalid(`${where}: operación repetida`);
    seen.add(where);
    if (op.action !== 'delete' && op.action !== 'put') invalid(`${where}: acción desconocida`);
    const version = op.expect?.version;
    const trackDate = op.expect?.trackDate;
    if (op.pk === CLAIMS_PARTITION) {
      if (op.action !== 'delete') invalid(`${where}: una reserva solo se borra`);
      if (typeof trackDate !== 'string' || !ISO_DATE.test(trackDate)) {
        invalid(`${where}: falta expect.trackDate`);
      }
    } else {
      if (!Number.isInteger(version)) invalid(`${where}: falta expect.version`);
      if (op.action === 'put') {
        const dates = op.dates;
        if (
          !Array.isArray(dates) ||
          dates.some((d) => typeof d !== 'string' || !ISO_DATE.test(d))
        ) {
          invalid(`${where}: fechas inválidas`);
        }
      }
    }
  }
  const unresolved = Array.isArray(plan?.unresolved)
    ? plan.unresolved.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { ops, unresolved };
}

export type ApplyRepairResult =
  | { status: 'applied'; applied: number; batches: number }
  | {
      status: 'control-changed';
      appliedBatches: number;
      appliedOps: number;
      /** Número (desde 1) del lote cuya condición falló. */
      failedBatch: number;
    };

/**
 * Aplica el plan revisado en lotes de a lo sumo MAX_TRANSACTION_ITEMS operaciones, en orden. Cada
 * lote es UNA transacción: todas sus condiciones (estado de la auditoría) o nada. Las operaciones
 * son independientes (claves distintas), así que un lote no depende de los anteriores.
 *
 * - Falla una condición (`ConditionalCheckFailed`): devuelve `control-changed` y se detiene en ese
 *   lote; los lotes anteriores quedan aplicados. Recuperación: auditar de nuevo y generar otro plan.
 * - Cualquier otro error (throttling, validación, red...) NO es un cambio de control: se lanza un
 *   Error que indica el lote y cuántos ya se aplicaron, con el error original en `cause`.
 * Nunca toca `TRACK`. Requiere `dynamodb:DeleteItem` en el perfil del operador.
 */
export async function applyControlRepair(
  client: DynamoDBDocumentClient,
  tableName: string,
  rawPlan: ControlRepairPlan,
): Promise<ApplyRepairResult> {
  const { ops } = parseControlRepairPlan(rawPlan);

  const itemOf = (op: ControlRepairOp) => {
    const Key = { pk: op.pk, date: op.key };
    if (op.pk === CLAIMS_PARTITION) {
      return {
        Delete: {
          TableName: tableName,
          Key,
          ConditionExpression: 'trackDate = :heldBy',
          ExpressionAttributeValues: { ':heldBy': op.expect.trackDate },
        },
      };
    }
    const condition = {
      ConditionExpression: '#version = :version',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':version': op.expect.version },
    };
    if (op.action === 'delete') return { Delete: { TableName: tableName, Key, ...condition } };
    return {
      Put: {
        TableName: tableName,
        Item: { ...Key, dates: op.dates, version: op.expect.version! + 1 },
        ...condition,
      },
    };
  };

  const batches: ControlRepairOp[][] = [];
  for (let i = 0; i < ops.length; i += MAX_TRANSACTION_ITEMS) {
    batches.push(ops.slice(i, i + MAX_TRANSACTION_ITEMS));
  }
  let appliedOps = 0;
  for (const [index, batch] of batches.entries()) {
    try {
      await client.send(new TransactWriteCommand({ TransactItems: batch.map(itemOf) }));
    } catch (error) {
      // Por nombre además de instanceof: una copia duplicada del SDK no rompe la detección.
      const canceled =
        error instanceof TransactionCanceledException ||
        (error instanceof Error && error.name === 'TransactionCanceledException');
      const conditionFailed =
        canceled &&
        ((error as TransactionCanceledException).CancellationReasons ?? []).some(
          (reason) => reason.Code === 'ConditionalCheckFailed',
        );
      if (conditionFailed) {
        return {
          status: 'control-changed',
          appliedBatches: index,
          appliedOps,
          failedBatch: index + 1,
        };
      }
      throw new Error(
        `Repair batch ${index + 1} of ${batches.length} failed (${index} batches and ${appliedOps} operations already applied): ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    appliedOps += batch.length;
  }
  return { status: 'applied', applied: appliedOps, batches: batches.length };
}

async function put(
  client: DynamoDBDocumentClient,
  tableName: string,
  Item: Record<string, unknown>,
  condition: {
    ConditionExpression: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
  },
): Promise<void> {
  await client.send(
    new TransactWriteCommand({
      TransactItems: [{ Put: { TableName: tableName, Item, ...condition } }],
    }),
  );
}

/** `published`: la fecha ya empezó en alguna zona; no se borra nada. */
export type RemoveResult = 'removed' | 'not-found' | 'published';

/**
 * Baja de una fecha: borra la canción, sus reservas (solo si siguen a nombre de esa fecha) y quita
 * la fecha de los registros de artista, todo en una transacción. Así la fecha y la canción quedan
 * realmente libres. Es la única forma soportada de limpiar datos de prueba o corregir una fecha.
 * Requiere `dynamodb:DeleteItem` en el perfil del operador (no en los roles de las Lambdas).
 *
 * Solo para fechas que todavía no empezaron en ninguna zona (UTC+14): una canción que alguien ya
 * pudo ver no se borra ni se reemplaza por esta vía.
 */
export async function removeTrack(
  client: DynamoDBDocumentClient,
  tableName: string,
  date: IsoDate,
  { now = new Date() }: { now?: Date } = {},
): Promise<RemoveResult> {
  if (isPublicSomewhere(date, now)) return 'published';
  const read = async (pk: string, key: string) =>
    (
      await client.send(
        new GetCommand({ TableName: tableName, Key: { pk, date: key }, ConsistentRead: true }),
      )
    ).Item;
  const track = (await read(TRACKS_PARTITION, date)) as DailyTrack | undefined;
  if (!track) return 'not-found';

  const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> =
    [
      {
        Delete: {
          TableName: tableName,
          Key: { pk: TRACKS_PARTITION, date },
          ConditionExpression: 'spotifyTrackId = :id',
          ExpressionAttributeValues: { ':id': track.spotifyTrackId },
        },
      },
    ];
  for (const key of [
    idClaimKey(track.spotifyTrackId),
    recordingClaimKey(track.title, track.artist),
  ]) {
    const claim = await read(CLAIMS_PARTITION, key);
    // Una reserva de otra fecha (catálogo con repetidos) no se toca.
    if (claim?.trackDate === date) {
      items.push({
        Delete: {
          TableName: tableName,
          Key: { pk: CLAIMS_PARTITION, date: key },
          ConditionExpression: 'trackDate = :date',
          ExpressionAttributeValues: { ':date': date },
        },
      });
    }
  }
  for (const key of artistControlKeys(track)) {
    const artist = (await read(ARTISTS_PARTITION, key)) as
      { dates: IsoDate[]; version: number } | undefined;
    if (!artist?.dates.includes(date)) continue;
    items.push({
      Put: {
        TableName: tableName,
        Item: {
          pk: ARTISTS_PARTITION,
          date: key,
          dates: artist.dates.filter((d) => d !== date),
          version: artist.version + 1,
        },
        ConditionExpression: '#version = :version',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':version': artist.version },
      },
    });
  }
  try {
    await client.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      throw new Error(`Track ${date} changed while it was being removed; retry`, { cause: error });
    }
    throw error;
  }
  return 'removed';
}
