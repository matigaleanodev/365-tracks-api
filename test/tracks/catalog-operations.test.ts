import { describe, expect, it } from 'vitest';
import { listCatalog } from '../../src/tracks/catalog-list.ts';
import { removeTrack } from '../../src/tracks/maintenance.ts';
import { isPublicSomewhere, latestStartedDate } from '../../src/tracks/publication.ts';
import { readAllTracks } from '../../src/tracks/read-all.ts';
import { replaceTrack } from '../../src/tracks/replace-track.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';
import { fakeDynamo } from '../support/fake-dynamo.ts';
import { preparedTrack } from '../support/music.ts';

/** Entrada de carga manual (sin createdAt, que fija el sistema). */
function input(track: DailyTrack): Record<string, unknown> {
  return Object.fromEntries(Object.entries(track).filter(([key]) => key !== 'createdAt'));
}

// 2027-02-28 10:00 UTC: Kiritimati (UTC+14) ya vive el 2027-03-01.
const BEFORE_KIRITIMATI = new Date('2027-02-28T09:59:59Z');
const KIRITIMATI_STARTED = new Date('2027-02-28T10:00:00Z');

describe('fecha pública en alguna zona', () => {
  it('una fecha es pública desde las 00:00 de UTC+14 (10:00 UTC del día anterior)', () => {
    expect(latestStartedDate(BEFORE_KIRITIMATI)).toBe('2027-02-28');
    expect(latestStartedDate(KIRITIMATI_STARTED)).toBe('2027-03-01');
    expect(isPublicSomewhere('2027-03-01', BEFORE_KIRITIMATI)).toBe(false);
    expect(isPublicSomewhere('2027-03-01', KIRITIMATI_STARTED)).toBe(true);
  });

  it('nada anterior al lanzamiento cuenta como publicado', () => {
    expect(isPublicSomewhere('2026-12-31', new Date('2027-06-01T00:00:00Z'))).toBe(false);
  });
});

describe('listado del catálogo', () => {
  it('ordena por fecha y distingue publicadas, preparadas, incompletas y huecos', async () => {
    const dynamo = fakeDynamo();
    await dynamo.repository.create(preparedTrack('2027-01-03', 3));
    await dynamo.repository.create(preparedTrack('2027-01-01', 1));
    dynamo.items.set('TRACK|2027-01-04', {
      pk: 'TRACK',
      ...preparedTrack('2027-01-04', 4, { description: undefined }),
    });

    const { entries, gaps } = await listCatalog(
      dynamo.repository,
      new Date('2027-01-01T12:00:00Z'),
    );

    expect(entries.map((e) => [e.date, e.status])).toEqual([
      ['2027-01-01', 'published'],
      ['2027-01-03', 'prepared'],
      ['2027-01-04', 'incomplete'],
    ]);
    expect(entries[0]).toMatchObject({
      title: 'Title 1',
      artist: 'Artist 1',
      spotifyTrackId: preparedTrack('2027-01-01', 1).spotifyTrackId,
      missingFields: [],
    });
    expect(entries[0]?.description).toBeTypeOf('string');
    expect(entries[2]?.missingFields).toEqual(['description']);
    expect(gaps).toEqual(['2027-01-02']);
  });

  it('sin canciones no hay huecos ni entradas', async () => {
    expect(await listCatalog(fakeDynamo().repository, new Date())).toEqual({
      entries: [],
      gaps: [],
    });
  });
});

describe('baja protegida', () => {
  it('no borra una fecha que ya empezó en UTC+14', async () => {
    const dynamo = fakeDynamo();
    await dynamo.repository.create(preparedTrack('2027-03-01', 1));

    expect(
      await removeTrack(dynamo.client, dynamo.table, '2027-03-01', { now: KIRITIMATI_STARTED }),
    ).toBe('published');
    expect(dynamo.items.has('TRACK|2027-03-01')).toBe(true);

    expect(
      await removeTrack(dynamo.client, dynamo.table, '2027-03-01', { now: BEFORE_KIRITIMATI }),
    ).toBe('removed');
  });
});

describe('reemplazo de una canción', () => {
  const now = BEFORE_KIRITIMATI;
  const run = (dynamo: ReturnType<typeof fakeDynamo>, raw: unknown, write: boolean, at = now) =>
    replaceTrack({
      client: dynamo.client,
      tableName: dynamo.table,
      repository: dynamo.repository,
      date: '2027-03-01',
      raw,
      now: at,
      write,
    });

  it('sin --write valida y compara sin escribir', async () => {
    const dynamo = fakeDynamo();
    await dynamo.repository.create(preparedTrack('2027-03-01', 1));
    const result = await run(dynamo, input(preparedTrack('2027-03-01', 2)), false);
    expect(result).toMatchObject({ status: 'valid', previous: { title: 'Title 1' } });
    expect((await dynamo.repository.getByDate('2027-03-01'))?.title).toBe('Title 1');
  });

  it('reemplaza y libera las reservas de la canción anterior', async () => {
    const dynamo = fakeDynamo();
    const old = preparedTrack('2027-03-01', 1);
    await dynamo.repository.create(old);
    const result = await run(dynamo, input(preparedTrack('2027-03-01', 2)), true);
    expect(result).toMatchObject({ status: 'replaced' });
    expect((await dynamo.repository.getByDate('2027-03-01'))?.title).toBe('Title 2');
    // La canción anterior queda disponible para otra fecha.
    expect(await dynamo.repository.create({ ...old, date: '2027-06-01' })).toBe('created');
  });

  it('rechaza una fecha ya pública, una fecha vacía y un archivo de otra fecha', async () => {
    const dynamo = fakeDynamo();
    await dynamo.repository.create(preparedTrack('2027-03-01', 1));
    const raw = input(preparedTrack('2027-03-01', 2));

    expect(await run(dynamo, raw, true, KIRITIMATI_STARTED)).toEqual({ status: 'published' });
    expect(await run(dynamo, input(preparedTrack('2027-03-02', 2)), true)).toMatchObject({
      status: 'invalid',
    });
    expect(
      await replaceTrack({
        client: dynamo.client,
        tableName: dynamo.table,
        repository: dynamo.repository,
        date: '2027-04-01',
        raw: input(preparedTrack('2027-04-01', 3)),
        now,
        write: true,
      }),
    ).toEqual({ status: 'not-found' });
    expect((await readAllTracks(dynamo.repository)).map((t) => t.title)).toEqual(['Title 1']);
  });

  it('si la nueva repite una canción de otra fecha, devuelve la anterior a su lugar', async () => {
    const dynamo = fakeDynamo();
    await dynamo.repository.create(preparedTrack('2027-03-01', 1));
    const other = preparedTrack('2027-05-01', 2);
    await dynamo.repository.create(other);

    const result = await run(dynamo, input({ ...other, date: '2027-03-01' }), true);

    expect(result).toMatchObject({ status: 'conflict', now: 'previous' });
    expect((await dynamo.repository.getByDate('2027-03-01'))?.title).toBe('Title 1');
    expect((await dynamo.repository.getByDate('2027-05-01'))?.title).toBe('Title 2');
  });

  it('un fallo ambiguo al guardar informa lo que realmente quedó en la fecha', async () => {
    const dynamo = fakeDynamo();
    await dynamo.repository.create(preparedTrack('2027-03-01', 1));
    const create = dynamo.repository.create.bind(dynamo.repository);
    let calls = 0;
    // La primera alta se escribe pero responde con error (timeout ambiguo).
    dynamo.repository.create = async (track) => {
      calls += 1;
      const result = await create(track);
      if (calls === 1) throw new Error('socket timeout');
      return result;
    };
    const result = await run(dynamo, input(preparedTrack('2027-03-01', 2)), true);
    expect(result).toMatchObject({ status: 'replaced' });
    expect((await dynamo.repository.getByDate('2027-03-01'))?.title).toBe('Title 2');
  });

  it('si el guardado y la restauración fallan, informa que la fecha quedó vacía', async () => {
    const dynamo = fakeDynamo();
    await dynamo.repository.create(preparedTrack('2027-03-01', 1));
    dynamo.repository.create = () => Promise.reject(new Error('throttled'));
    const result = await run(dynamo, input(preparedTrack('2027-03-01', 2)), true);
    expect(result).toMatchObject({ status: 'error', error: 'throttled', now: 'empty' });
  });

  it('con el mismo ID de Spotify, una restauración no se informa como reemplazo', async () => {
    const dynamo = fakeDynamo();
    const old = preparedTrack('2027-03-01', 1);
    await dynamo.repository.create(old);
    const create = dynamo.repository.create.bind(dynamo.repository);
    let calls = 0;
    // La nueva (misma canción, otra nota) falla sin escribirse; la anterior se restaura.
    dynamo.repository.create = (track) => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('throttled')) : create(track);
    };
    const raw = input({ ...old, description: `${old.description ?? ''} Nota corregida a mano.` });
    const result = await run(dynamo, raw, true);
    expect(result).toMatchObject({ status: 'error', now: 'previous' });
    expect((await dynamo.repository.getByDate('2027-03-01'))?.description).toBe(old.description);
  });

  it('un fallo de la baja informa qué quedó en la fecha', async () => {
    const dynamo = fakeDynamo();
    await dynamo.repository.create(preparedTrack('2027-03-01', 1));
    dynamo.transactions.mockImplementationOnce(() => {
      throw new Error('connection reset');
    });
    const result = await run(dynamo, input(preparedTrack('2027-03-01', 2)), true);
    expect(result).toMatchObject({ status: 'error', error: 'connection reset', now: 'previous' });
    expect((await dynamo.repository.getByDate('2027-03-01'))?.title).toBe('Title 1');
  });

  it('una nota inválida no toca la tabla', async () => {
    const dynamo = fakeDynamo();
    await dynamo.repository.create(preparedTrack('2027-03-01', 1));
    const writes = dynamo.transactions.mock.calls.length;
    const result = await run(
      dynamo,
      input(preparedTrack('2027-03-01', 2, { description: 'corta' })),
      true,
    );
    expect(result).toMatchObject({ status: 'invalid' });
    expect(dynamo.transactions.mock.calls.length).toBe(writes);
  });
});
