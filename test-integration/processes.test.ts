import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DynamoTrackRepository } from '../src/tracks/dynamo-repository.ts';
import type { CreateTrackResult } from '../src/tracks/repository.ts';
import type { DailyTrack } from '../src/tracks/types.ts';
import { snapshotTable } from './support/aws.ts';
import { BASE_DATE, addDays, track, useTables } from './support/fixtures.ts';

const WORKER = fileURLToPath(new URL('./support/create-worker.ts', import.meta.url));
const STEP_TIMEOUT_MS = 30_000;

type Worker = ChildProcessByStdio<Writable, Readable, null>;

const withTimeout = <T>(promise: Promise<T>, what: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), STEP_TIMEOUT_MS),
    ),
  ]);

/**
 * Lanza un proceso node real por canción. Todos avisan READY y esperan GO: la barrera se libera
 * recién cuando los dos procesos están listos, así las dos transacciones salen casi a la vez.
 */
async function createInSeparateProcesses(
  tableName: string,
  tracks: DailyTrack[],
): Promise<CreateTrackResult[]> {
  const workers: Worker[] = tracks.map((value) =>
    spawn(process.execPath, [WORKER, tableName, JSON.stringify(value)], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'inherit'],
    }),
  );
  try {
    const readers = workers.map((worker) => createInterface({ input: worker.stdout }));
    const iterators = readers.map((reader) => reader[Symbol.asyncIterator]());
    const exits = workers.map(
      (worker) => new Promise<number | null>((resolve) => worker.once('exit', resolve)),
    );
    const next = async (index: number, what: string) => {
      const { value, done } = await withTimeout(iterators[index]!.next(), what);
      if (done) throw new Error(`Worker ${index} exited before ${what}`);
      return value as string;
    };
    for (const index of workers.keys()) expect(await next(index, 'READY')).toBe('READY');
    for (const worker of workers) worker.stdin.write('GO\n');
    const results = await Promise.all(
      [...workers.keys()].map(async (index) => {
        const line = await next(index, 'RESULT');
        expect(line.startsWith('RESULT ')).toBe(true);
        return JSON.parse(line.slice('RESULT '.length)) as CreateTrackResult;
      }),
    );
    expect(await withTimeout(Promise.all(exits), 'exit')).toEqual(workers.map(() => 0));
    return results;
  } finally {
    for (const worker of workers) worker.kill('SIGKILL');
  }
}

describe('concurrencia entre procesos node reales', () => {
  const newTable = useTables();

  it('1. dos procesos crean canciones para la misma fecha: solo una prospera', async () => {
    const { client, tableName } = await newTable();
    for (let round = 0; round < 3; round += 1) {
      const date = addDays(BASE_DATE, round * 200);
      const a = track(date, round * 10 + 1);
      const b = track(date, round * 10 + 2);
      const results = await createInSeparateProcesses(tableName, [a, b]);
      expect([...results].sort()).toEqual(['already-exists', 'created']);
      const winner = results[0] === 'created' ? a : b;
      const stored = await new DynamoTrackRepository(client, tableName).getByDate(date);
      expect(stored?.spotifyTrackId).toBe(winner.spotifyTrackId);
    }
    const items = await snapshotTable(client, tableName);
    expect(items.filter((item) => item.pk === 'TRACK')).toHaveLength(3);
    expect(items.filter((item) => item.pk === 'CLAIM')).toHaveLength(6);
    expect(items.filter((item) => item.pk === 'ARTIST')).toHaveLength(3);
  });

  it('dos procesos con el mismo artista a 30 días: solo una prospera', async () => {
    const { client, tableName } = await newTable();
    const a = track(BASE_DATE, 1, { artist: 'Artista Compartido' });
    const b = track(addDays(BASE_DATE, 30), 2, { artist: 'Artista Compartido' });
    const results = await createInSeparateProcesses(tableName, [a, b]);
    expect([...results].sort()).toEqual(['artist-cooldown', 'created']);
    const items = await snapshotTable(client, tableName);
    expect(items.filter((item) => item.pk === 'TRACK')).toHaveLength(1);
    expect(items.filter((item) => item.pk === 'CLAIM')).toHaveLength(2);
  });
});
