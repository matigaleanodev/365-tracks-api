import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { reindexControlRecords, removeTrack } from '../../src/tracks/maintenance.ts';
import { readAllTracks } from '../../src/tracks/read-all.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';
import { fakeDynamo } from '../support/fake-dynamo.ts';
import { preparedTrack, spotifyId } from '../support/music.ts';

/** Reloj fijo previo al lanzamiento: la baja rechaza fechas que ya empezaron en alguna zona. */
const BEFORE_LAUNCH = new Date('2026-12-01T00:00:00Z');

/** Catálogo anterior a las transacciones: solo existen los ítems TRACK. */
function legacy(tracks: DailyTrack[]) {
  const dynamo = fakeDynamo();
  for (const track of tracks) dynamo.items.set(`TRACK|${track.date}`, { pk: 'TRACK', ...track });
  return dynamo;
}

describe('catálogo anterior sin registros de control', () => {
  const first = preparedTrack('2027-01-01', 1, { artist: 'Band', title: 'Song A' });

  it('sin reindex la unicidad no lo cubre; con reindex sí, para ID, grabación y artista', async () => {
    const dynamo = legacy([first]);
    const reuse = preparedTrack('2027-07-01', 2, { spotifyTrackId: first.spotifyTrackId });
    // Reproduce el hueco: el TRACK legado no tiene reservas, la escritura nueva pasa.
    expect(await legacy([first]).repository.create(reuse)).toBe('created');

    const audit = await reindexControlRecords(dynamo.client, dynamo.table, { write: false });
    expect(audit).toMatchObject({ tracks: 1, conflicts: [], blocked: false });
    expect(audit.written).toBeGreaterThan(0);
    expect(dynamo.items.has(`CLAIM|id#${first.spotifyTrackId}`)).toBe(false); // dry-run no escribe

    await reindexControlRecords(dynamo.client, dynamo.table, { write: true });

    expect(await dynamo.repository.create(reuse)).toBe('duplicate-track');
    const sameRecording = preparedTrack('2027-07-02', 3, { artist: 'Band', title: 'Song A' });
    expect(await dynamo.repository.create(sameRecording)).toBe('duplicate-recording');
    const sameArtist = preparedTrack('2027-01-20', 4, { artist: 'Band', title: 'Other' });
    expect(await dynamo.repository.create(sameArtist)).toBe('artist-cooldown');
  });

  it('es idempotente y no pisa lo que ya existe', async () => {
    const dynamo = legacy([first]);
    await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    const again = await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    expect(again.written).toBe(0);
    expect(dynamo.items.get('ARTIST|name#band')?.version).toBe(1);
  });

  it('informa repeticiones ya existentes sin resolverlas, borrar ni escribir nada', async () => {
    const second = preparedTrack('2027-01-10', 2, { artist: 'Band', title: 'Song B' });
    const dup = preparedTrack('2027-06-01', 3, {
      spotifyTrackId: first.spotifyTrackId,
      artist: 'Other',
    });
    const dynamo = legacy([first, second, dup]);
    const report = await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    expect(report.conflicts.join('\n')).toMatch(/2027-06-01 repite/);
    expect(report.conflicts.join('\n')).toMatch(/menos de 60 días de 2027-01-01/);
    expect(dynamo.tracks()).toHaveLength(3);
    expect(report.blocked).toBe(true);
    // Con conflictos no se escribe nada, aunque se pida: ni reservas ni artistas.
    expect([...dynamo.items.keys()].filter((key) => !key.startsWith('TRACK'))).toEqual([]);
  });
});

describe('baja de una fecha', () => {
  it('libera fecha, canción, grabación y artista: se puede volver a cargar y usar al artista', async () => {
    const dynamo = fakeDynamo();
    const test = preparedTrack('2099-12-31', 9, { artist: 'Test Band', title: 'Test Song' });
    expect(await dynamo.repository.create(test)).toBe('created');

    expect(await removeTrack(dynamo.client, dynamo.table, '2099-12-31')).toBe('removed');
    expect(await readAllTracks(dynamo.repository)).toEqual([]);
    expect([...dynamo.items.keys()].filter((key) => !key.startsWith('ARTIST'))).toEqual([]);
    expect(dynamo.items.get('ARTIST|name#test band')?.dates).toEqual([]);

    expect(await dynamo.repository.create(test)).toBe('created');
    await removeTrack(dynamo.client, dynamo.table, '2099-12-31');
    const sameArtist = preparedTrack('2099-12-31', 10, { artist: 'Test Band', title: 'Other' });
    expect(await dynamo.repository.create(sameArtist)).toBe('created');
  });

  it('una fecha inexistente no hace nada y las reservas de otra fecha no se tocan', async () => {
    const dynamo = fakeDynamo();
    expect(
      await removeTrack(dynamo.client, dynamo.table, '2027-01-01', { now: BEFORE_LAUNCH }),
    ).toBe('not-found');

    const first = preparedTrack('2027-01-01', 1);
    await dynamo.repository.create(first);
    // Catálogo con un repetido heredado: la fecha duplicada no es titular de la reserva.
    dynamo.items.set('TRACK|2027-09-01', {
      pk: 'TRACK',
      ...preparedTrack('2027-09-01', 2, { spotifyTrackId: first.spotifyTrackId, artist: 'Zed' }),
    });
    await removeTrack(dynamo.client, dynamo.table, '2027-09-01', { now: BEFORE_LAUNCH });
    expect(dynamo.items.get(`CLAIM|id#${first.spotifyTrackId}`)?.trackDate).toBe('2027-01-01');
    expect(dynamo.items.has('TRACK|2027-01-01')).toBe(true);
  });
});

describe('claves de control', () => {
  it('la clave de grabación tiene tamaño fijo aunque título y artista sean enormes', async () => {
    const dynamo = fakeDynamo();
    const huge = preparedTrack('2027-01-01', 1, {
      title: 'T'.repeat(600),
      artist: 'A'.repeat(600),
    });
    expect(await dynamo.repository.create(huge)).toBe('created');
    const claims = [...dynamo.items.keys()].filter((key) => key.startsWith('CLAIM|rec#'));
    expect(claims).toHaveLength(1);
    expect(claims[0]!.length).toBeLessThan(100);
    expect(spotifyId(1)).toBeTruthy();
  });
});

describe('auditoría de la propia tabla', () => {
  const first = preparedTrack('2027-01-01', 1, { artist: 'Band', title: 'Song A' });
  const written = (dynamo: ReturnType<typeof fakeDynamo>) =>
    [...dynamo.items.keys()].filter((key) => !key.startsWith('TRACK')).sort();

  it('lee TRACK, CLAIM y ARTIST con lectura consistente y paginada', async () => {
    const tracks = Array.from({ length: 5 }, (_, i) =>
      preparedTrack(`2027-0${i + 1}-01`, i + 1, { artist: `Artist ${i}` }),
    );
    const dynamo = fakeDynamo({ pageSize: 2 });
    for (const track of tracks) dynamo.items.set(`TRACK|${track.date}`, { pk: 'TRACK', ...track });
    const report = await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    expect(report.tracks).toBe(5);
    expect(report).toMatchObject({ conflicts: [], blocked: false, written: 15 });
    const audit = await reindexControlRecords(dynamo.client, dynamo.table, { write: false });
    expect(audit.written).toBe(0);
    expect(dynamo.queries.length).toBeGreaterThan(6); // paginó: más de un Query por partición
    expect(dynamo.queries.every((query) => query.ConsistentRead === true)).toBe(true);
    const partitions = new Set(
      dynamo.queries.map((query) => (query.ExpressionAttributeValues as { ':pk': string })[':pk']),
    );
    expect(partitions).toEqual(new Set(['TRACK', 'CLAIM', 'ARTIST']));
  });

  it('una reserva a nombre de otra fecha sin canción bloquea la canción que deriva la clave', async () => {
    const dynamo = legacy([first]);
    dynamo.items.set(`CLAIM|id#${first.spotifyTrackId}`, {
      pk: 'CLAIM',
      date: `id#${first.spotifyTrackId}`,
      trackDate: '2027-01-03',
    });
    const report = await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    const text = report.conflicts.join('\n');
    expect(report.blocked).toBe(true);
    expect(text).toMatch(/huérfana \(id\) a nombre de 2027-01-03: no hay canción en esa fecha/);
    expect(text).toMatch(
      /a nombre de 2027-01-03, pero la clave la deriva la canción de 2027-01-01/,
    );
    expect(written(dynamo)).toEqual([`CLAIM|id#${first.spotifyTrackId}`]); // solo la preexistente
    expect(dynamo.items.get(`CLAIM|id#${first.spotifyTrackId}`)?.trackDate).toBe('2027-01-03');
  });

  it('una reserva cuya fecha tiene otra canción también es huérfana', async () => {
    const other = preparedTrack('2027-02-01', 2);
    const dynamo = legacy([first, other]);
    dynamo.items.set(`CLAIM|id#${first.spotifyTrackId}`, {
      pk: 'CLAIM',
      date: `id#${first.spotifyTrackId}`,
      trackDate: '2027-02-01',
    });
    const report = await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    expect(report.conflicts.join('\n')).toMatch(/2027-02-01: esa canción no deriva la clave/);
    expect(report.blocked).toBe(true);
  });

  it('detecta fechas huérfanas y claves de artista que ninguna canción produce', async () => {
    const dynamo = legacy([first]);
    dynamo.items.set('ARTIST|name#band', {
      pk: 'ARTIST',
      date: 'name#band',
      dates: ['2027-01-01', '2027-03-03'],
      version: 2,
    });
    dynamo.items.set(`ARTIST|name#${'x'.repeat(500)}`, {
      pk: 'ARTIST',
      date: `name#${'x'.repeat(500)}`,
      dates: ['2027-01-01'],
      version: 1,
    });
    const report = await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    const text = report.conflicts.join('\n');
    expect(text).toMatch(/name#band incluye 2027-03-03.*huérfana o incorrecta/);
    expect(text).toMatch(/name#x+….*no lo produce ninguna canción/);
    expect(report.blocked).toBe(true);
    expect(dynamo.items.get('ARTIST|name#band')?.version).toBe(2);
    expect(dynamo.items.has(`CLAIM|id#${first.spotifyTrackId}`)).toBe(false);
  });

  it('un registro de artista vacío tras removeTrack no bloquea', async () => {
    const dynamo = fakeDynamo();
    await dynamo.repository.create(preparedTrack('2027-01-01', 1, { artist: 'Solo' }));
    await dynamo.repository.create(preparedTrack('2027-06-01', 2, { artist: 'Otro' }));
    await removeTrack(dynamo.client, dynamo.table, '2027-01-01', { now: BEFORE_LAUNCH });
    expect(dynamo.items.get('ARTIST|name#solo')?.dates).toEqual([]);

    const report = await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    expect(report).toMatchObject({ conflicts: [], blocked: false });
    expect(report.emptyArtistRecords).toEqual(['name#solo']);
    expect(report.written).toBe(0);
  });

  it.each([
    { name: 'durante las reservas', failAt: 4, seeded: false },
    { name: 'en el primer artista, con registro parcial', failAt: 7, seeded: true },
    { name: 'en el segundo artista, con registro parcial', failAt: 8, seeded: true },
    { name: 'en el segundo artista, sin registros previos', failAt: 8, seeded: false },
  ])('un corte $name se reanuda sin duplicados ni conflictos', async ({ failAt, seeded }) => {
    const tracks = [
      preparedTrack('2027-01-01', 1, { artist: 'Band' }),
      preparedTrack('2027-03-05', 2, { artist: 'Band' }),
      preparedTrack('2027-05-01', 3, { artist: 'Other' }),
    ];
    const dynamo = legacy(tracks);
    if (seeded) {
      dynamo.items.set('ARTIST|name#band', {
        pk: 'ARTIST',
        date: 'name#band',
        dates: ['2027-01-01'],
        version: 1,
      });
    }
    let writes = 0;
    const flaky = {
      send: (command: unknown) => {
        if (command instanceof TransactWriteCommand && (writes += 1) === failAt) {
          return Promise.reject(new Error('corte simulado'));
        }
        return dynamo.client.send(command as never);
      },
    } as unknown as DynamoDBDocumentClient;

    await expect(reindexControlRecords(flaky, dynamo.table, { write: true })).rejects.toThrow(
      'corte simulado',
    );

    const rerun = await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    expect(rerun).toMatchObject({ conflicts: [], blocked: false });
    // 6 reservas y 2 artistas por escribir; el corte dejó hechos failAt - 1.
    expect(rerun.written).toBe(8 - (failAt - 1));
    expect(written(dynamo)).toHaveLength(8);
    expect(dynamo.items.get('ARTIST|name#band')?.dates).toEqual(['2027-01-01', '2027-03-05']);
    expect(dynamo.items.get('ARTIST|name#band')?.version).toBe(seeded ? 2 : 1);
    expect(dynamo.items.get('ARTIST|name#other')?.dates).toEqual(['2027-05-01']);

    const third = await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    expect(third).toMatchObject({ written: 0, conflicts: [], blocked: false });
  });
});
