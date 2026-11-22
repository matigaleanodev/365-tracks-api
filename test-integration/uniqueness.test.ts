import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ARTISTS_PARTITION,
  CLAIMS_PARTITION,
  DynamoTrackRepository,
  TRACKS_PARTITION,
} from '../src/tracks/dynamo-repository.ts';
import { createDocClient, interceptSend, snapshotTable } from './support/aws.ts';
import {
  BASE_DATE,
  COOLDOWN,
  addDays,
  claimKeysOf,
  putClaim,
  track,
  useTables,
} from './support/fixtures.ts';

const newTable = useTables();
const extraClients: DynamoDBDocumentClient[] = [];
afterAll(() => extraClients.forEach((client) => client.destroy()));

/** Un repositorio con su PROPIO cliente (sockets y estado distintos), como un proceso aparte. */
function separateRepository(tableName: string) {
  const client = createDocClient();
  extraClients.push(client);
  return new DynamoTrackRepository(client, tableName);
}

const partition = (items: Record<string, unknown>[], pk: string) =>
  items.filter((item) => item.pk === pk);

describe('unicidad con DynamoDB Local', () => {
  it('1. varias escrituras a la vez para la misma fecha: gana una y no quedan reservas de las demás', async () => {
    const { client, tableName } = await newTable();
    for (let round = 0; round < 5; round += 1) {
      const date = addDays(BASE_DATE, round * 200);
      const contenders = [1, 2, 3, 4].map((k) => track(date, round * 10 + k));
      const results = await Promise.all(
        contenders.map((value) => separateRepository(tableName).create(value)),
      );
      expect(results.filter((r) => r === 'created')).toHaveLength(1);
      expect(results.filter((r) => r === 'already-exists')).toHaveLength(3);
      const winner = contenders[results.indexOf('created')]!;
      const stored = await new DynamoTrackRepository(client, tableName).getByDate(date);
      expect(stored?.spotifyTrackId).toBe(winner.spotifyTrackId);
    }
    const items = await snapshotTable(client, tableName);
    // Cinco fechas ganadoras: 5 TRACK, 2 reservas por canción y 1 registro por artista (sin ID).
    expect(partition(items, TRACKS_PARTITION)).toHaveLength(5);
    expect(partition(items, CLAIMS_PARTITION)).toHaveLength(10);
    expect(partition(items, ARTISTS_PARTITION)).toHaveLength(5);
  });

  it('2. el mismo Spotify Track ID en fechas distintas', async () => {
    const { client, tableName } = await newTable();
    const first = track(BASE_DATE, 1);
    const second = track(addDays(BASE_DATE, 100), 2, { spotifyTrackId: first.spotifyTrackId });
    const repo = new DynamoTrackRepository(client, tableName);
    expect(await repo.create(first)).toBe('created');
    expect(await repo.create(second)).toBe('duplicate-track');
    expect(await repo.getByDate(second.date)).toBeNull();

    // Y a la vez, con una tabla nueva y clientes separados.
    const concurrent = await newTable();
    const results = await Promise.all([
      separateRepository(concurrent.tableName).create(first),
      separateRepository(concurrent.tableName).create(second),
    ]);
    expect([...results].sort()).toEqual(['created', 'duplicate-track']);
    const items = await snapshotTable(concurrent.client, concurrent.tableName);
    expect(partition(items, TRACKS_PARTITION)).toHaveLength(1);
    expect(partition(items, CLAIMS_PARTITION)).toHaveLength(2);
  });

  it('3. distintos Track IDs para la misma grabación (título base + artista)', async () => {
    const { client, tableName } = await newTable();
    const original = track(BASE_DATE, 1, { title: 'Song Name', artist: 'The Same Artist' });
    const remaster = track(addDays(BASE_DATE, 100), 2, {
      title: 'Song Name - Remastered 2011',
      artist: 'Same Artist',
    });
    const repo = new DynamoTrackRepository(client, tableName);
    expect(await repo.create(original)).toBe('created');
    expect(await repo.create(remaster)).toBe('duplicate-recording');
    expect(await repo.getByDate(remaster.date)).toBeNull();

    const concurrent = await newTable();
    const results = await Promise.all([
      separateRepository(concurrent.tableName).create(original),
      separateRepository(concurrent.tableName).create(remaster),
    ]);
    expect([...results].sort()).toEqual(['created', 'duplicate-recording']);
    const items = await snapshotTable(concurrent.client, concurrent.tableName);
    expect(partition(items, TRACKS_PARTITION)).toHaveLength(1);
    // El perdedor no dejó su reserva de ID ni tocó el registro del artista.
    expect(partition(items, CLAIMS_PARTITION)).toHaveLength(2);
    expect(partition(items, ARTISTS_PARTITION).every((item) => item.version === 1)).toBe(true);
  });

  it('4. mismo artista con menos de 60 días de separación', async () => {
    const { client, tableName } = await newTable();
    const repo = new DynamoTrackRepository(client, tableName);
    const a = track(BASE_DATE, 1, { artist: 'Prolific Band' });
    const b = track(addDays(BASE_DATE, 30), 2, { artist: 'Prolific Band' });
    expect(await repo.create(a)).toBe('created');
    expect(await repo.create(b)).toBe('artist-cooldown');
    expect(await repo.getByDate(b.date)).toBeNull();

    // Seis fechas separadas 10 días, todas dentro de la misma ventana de 60: solo una prospera.
    const race = await newTable();
    const contenders = [0, 1, 2, 3, 4, 5].map((k) =>
      track(addDays(BASE_DATE, k * 10), 10 + k, { artist: 'Prolific Band' }),
    );
    const results = await Promise.all(
      contenders.map((value) => separateRepository(race.tableName).create(value)),
    );
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(results.filter((r) => r === 'artist-cooldown')).toHaveLength(5);
    const items = await snapshotTable(race.client, race.tableName);
    expect(partition(items, TRACKS_PARTITION)).toHaveLength(1);
    expect(partition(items, CLAIMS_PARTITION)).toHaveLength(2);
    const artist = partition(items, ARTISTS_PARTITION)[0]!;
    expect(artist.version).toBe(1);
    expect(artist.dates).toEqual([contenders[results.indexOf('created')]!.date]);
  });

  it('5. mismo artista identificado por nombre en una canción y por Spotify Artist ID en otra', async () => {
    const artistId = 'artist00000000000000AA';
    const { client, tableName } = await newTable();
    const repo = new DynamoTrackRepository(client, tableName);

    // Carga antigua sin ID y nueva con ID y el mismo nombre: comparten la clave de nombre.
    const byName = track(BASE_DATE, 1, { artist: 'Nombre Compartido' });
    const withId = track(addDays(BASE_DATE, 30), 2, {
      artist: 'nombre compartido',
      spotifyArtistId: artistId,
    });
    expect(await repo.create(byName)).toBe('created');
    expect(await repo.create(withId)).toBe('artist-cooldown');

    // Mismo ID con otra grafía del nombre: comparten la clave de ID.
    const second = await newTable();
    const secondRepo = new DynamoTrackRepository(second.client, second.tableName);
    const named = track(BASE_DATE, 3, { artist: 'Grafía Uno', spotifyArtistId: artistId });
    const respelled = track(addDays(BASE_DATE, 30), 4, {
      artist: 'Grafía Dos',
      spotifyArtistId: artistId,
    });
    expect(await secondRepo.create(named)).toBe('created');
    expect(await secondRepo.create(respelled)).toBe('artist-cooldown');
    // Otro artista (nombre e ID distintos) no se ve afectado.
    const other = track(addDays(BASE_DATE, 30), 5, {
      artist: 'Otro Artista',
      spotifyArtistId: 'artist00000000000000BB',
    });
    expect(await secondRepo.create(other)).toBe('created');

    // En paralelo, con clientes separados: solo una de las dos.
    const race = await newTable();
    const results = await Promise.all([
      separateRepository(race.tableName).create(named),
      separateRepository(race.tableName).create(respelled),
    ]);
    expect([...results].sort()).toEqual(['artist-cooldown', 'created']);

    // En paralelo: una canción solo con nombre y otra con el mismo artista y Spotify Artist ID.
    const mixed = await newTable();
    const nameOnly = track(BASE_DATE, 6, { artist: 'Mismo Artista' });
    const idToo = track(addDays(BASE_DATE, 30), 7, {
      artist: 'mismo artista',
      spotifyArtistId: artistId,
    });
    const mixedResults = await Promise.all([
      separateRepository(mixed.tableName).create(nameOnly),
      separateRepository(mixed.tableName).create(idToo),
    ]);
    expect([...mixedResults].sort()).toEqual(['artist-cooldown', 'created']);
    const winner = mixedResults[0] === 'created' ? nameOnly : idToo;
    const loser = winner === nameOnly ? idToo : nameOnly;
    const mixedItems = await snapshotTable(mixed.client, mixed.tableName);
    expect(partition(mixedItems, TRACKS_PARTITION).map((item) => item.date)).toEqual([winner.date]);
    expect(
      partition(mixedItems, CLAIMS_PARTITION)
        .map((item) => item.date)
        .sort(),
    ).toEqual(Object.values(claimKeysOf(winner)).sort());
    expect(partition(mixedItems, ARTISTS_PARTITION).every((a) => a.version === 1)).toBe(true);
    expect(
      await new DynamoTrackRepository(mixed.client, mixed.tableName).getByDate(loser.date),
    ).toBeNull();
  });

  it('6. exactamente 60 días de separación es válido (el límite es < 60); 59 no', async () => {
    expect(COOLDOWN).toBe(60);
    const { client, tableName } = await newTable();
    const repo = new DynamoTrackRepository(client, tableName);
    const anchor = addDays(BASE_DATE, 200);
    expect(await repo.create(track(anchor, 1, { artist: 'Limite' }))).toBe('created');
    expect(await repo.create(track(addDays(anchor, 59), 2, { artist: 'Limite' }))).toBe(
      'artist-cooldown',
    );
    expect(await repo.create(track(addDays(anchor, 60), 3, { artist: 'Limite' }))).toBe('created');
    // Hacia atrás: la regla es simétrica.
    expect(await repo.create(track(addDays(anchor, -59), 4, { artist: 'Limite' }))).toBe(
      'artist-cooldown',
    );
    expect(await repo.create(track(addDays(anchor, -60), 5, { artist: 'Limite' }))).toBe('created');
  });

  it('7. canciones distintas del mismo artista separadas más de 60 días', async () => {
    const { client, tableName } = await newTable();
    const repo = new DynamoTrackRepository(client, tableName);
    const dates = [0, 61, 122, 300, 700].map((offset) => addDays(BASE_DATE, offset));
    for (const [index, date] of dates.entries()) {
      expect(await repo.create(track(date, index + 1, { artist: 'Fondo de Catalogo' }))).toBe(
        'created',
      );
    }
    const items = await snapshotTable(client, tableName);
    const artist = partition(items, ARTISTS_PARTITION)[0]!;
    expect(artist.dates).toEqual(dates);
    expect(artist.version).toBe(5);
  });

  it('8. una transacción que falla no deja registros parciales', async () => {
    const { client, tableName } = await newTable();
    const repo = new DynamoTrackRepository(client, tableName);
    const seed = track(BASE_DATE, 1, {
      artist: 'Semilla',
      spotifyArtistId: 'artist00000000000000AA',
    });
    expect(await repo.create(seed)).toBe('created');
    const before = await snapshotTable(client, tableName);

    // Mismo ID, artista nuevo (el fallo está en la 2.ª condición de la transacción).
    const dupId = track(addDays(BASE_DATE, 100), 2, {
      spotifyTrackId: seed.spotifyTrackId,
      artist: 'Nuevo',
      spotifyArtistId: 'artist00000000000000BB',
    });
    expect(await repo.create(dupId)).toBe('duplicate-track');
    // Misma grabación con otro ID y otro ID de artista (fallo en la 3.ª condición).
    const dupRecording = track(addDays(BASE_DATE, 100), 3, {
      title: seed.title,
      artist: seed.artist,
      spotifyArtistId: 'artist00000000000000CC',
    });
    expect(await repo.create(dupRecording)).toBe('duplicate-recording');
    // Misma fecha (fallo en la 1.ª condición).
    expect(await repo.create(track(BASE_DATE, 4))).toBe('already-exists');
    expect(await snapshotTable(client, tableName)).toEqual(before);

    // Error permanente real: un ítem de más de 400 KB hace fallar toda la transacción.
    const huge = track(addDays(BASE_DATE, 200), 5, { description: 'x'.repeat(450_000) });
    const log = interceptSend(client);
    await expect(repo.create(huge)).rejects.toMatchObject({ name: 'ValidationException' });
    expect(log.errors.length).toBeGreaterThan(0);
    expect(await snapshotTable(client, tableName)).toEqual(before);
  });

  it('9. tras una cancelación transaccional se relee y se reevalúa', async () => {
    const artist = 'Artista Disputado';
    // A) El competidor está a 70 días: la víctima reintenta y termina creando.
    const a = await newTable();
    const victimClient = createDocClient();
    extraClients.push(victimClient);
    const competitor = separateRepository(a.tableName);
    const log = interceptSend(victimClient, async (command, current) => {
      const alreadyTried = current.sent.some((sent) => sent instanceof TransactWriteCommand);
      if (command instanceof TransactWriteCommand && !alreadyTried) {
        // Escritura competidora REAL: cambia la versión del registro del artista.
        expect(await competitor.create(track(addDays(BASE_DATE, 70), 20, { artist }))).toBe(
          'created',
        );
      }
    });
    const victim = new DynamoTrackRepository(victimClient, a.tableName);
    expect(await victim.create(track(BASE_DATE, 21, { artist }))).toBe('created');
    const transactions = log.sent.filter((command) => command instanceof TransactWriteCommand);
    expect(transactions).toHaveLength(2);
    const canceled = log.errors[0];
    expect(canceled).toBeInstanceOf(TransactionCanceledException);
    expect(
      (canceled as TransactionCanceledException).CancellationReasons?.map((r) => r.Code),
    ).toEqual(['None', 'None', 'None', 'ConditionalCheckFailed']);
    // La segunda vuelta releyó el registro del artista (2 lecturas de ARTIST en total).
    const artistReads = log.sent.filter(
      (command) => command instanceof GetCommand && command.input.Key?.pk === ARTISTS_PARTITION,
    );
    expect(artistReads).toHaveLength(2);
    const artistItem = partition(await snapshotTable(a.client, a.tableName), ARTISTS_PARTITION)[0]!;
    expect([...(artistItem.dates as string[])].sort()).toEqual([BASE_DATE, addDays(BASE_DATE, 70)]);
    expect(artistItem.version).toBe(2);

    // B) El competidor está a 30 días: al reevaluar la víctima ve el intervalo y no crea nada.
    const b = await newTable();
    const clientB = createDocClient();
    extraClients.push(clientB);
    const competitorB = separateRepository(b.tableName);
    let injected = false;
    interceptSend(clientB, async (command) => {
      if (command instanceof TransactWriteCommand && !injected) {
        injected = true;
        await competitorB.create(track(addDays(BASE_DATE, 30), 30, { artist }));
      }
    });
    const victimB = new DynamoTrackRepository(clientB, b.tableName);
    expect(await victimB.create(track(BASE_DATE, 31, { artist }))).toBe('artist-cooldown');
    const items = await snapshotTable(b.client, b.tableName);
    expect(partition(items, TRACKS_PARTITION)).toHaveLength(1);
    expect(partition(items, CLAIMS_PARTITION)).toHaveLength(2);
    expect(await victimB.getByDate(BASE_DATE)).toBeNull();
  });

  it('10. las reservas existentes impiden volver a usar una canción', async () => {
    const { client, tableName } = await newTable();
    const repo = new DynamoTrackRepository(client, tableName);
    const original = track(BASE_DATE, 1);
    expect(await repo.create(original)).toBe('created');
    const sameId = track(addDays(BASE_DATE, 100), 2, { spotifyTrackId: original.spotifyTrackId });
    const sameRecording = track(addDays(BASE_DATE, 100), 3, {
      title: original.title,
      artist: original.artist,
    });
    expect(await repo.create(sameId)).toBe('duplicate-track');
    expect(await repo.create(sameRecording)).toBe('duplicate-recording');

    // Una reserva sin canción (huérfana) sigue bloqueando hasta que el operador la repare.
    const blockedId = track(addDays(BASE_DATE, 300), 4);
    await putClaim(client, tableName, claimKeysOf(blockedId).id, '2026-01-01');
    expect(await repo.create(blockedId)).toBe('duplicate-track');
    const blockedRecording = track(addDays(BASE_DATE, 301), 5);
    await putClaim(client, tableName, claimKeysOf(blockedRecording).recording, '2026-01-02');
    expect(await repo.create(blockedRecording)).toBe('duplicate-recording');
    expect(await repo.getByDate(blockedId.date)).toBeNull();
    expect(await repo.getByDate(blockedRecording.date)).toBeNull();
  });
});
