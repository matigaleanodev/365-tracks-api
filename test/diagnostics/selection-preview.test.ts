import { describe, expect, it } from 'vitest';
import { createGuardedFetch } from '../../src/diagnostics/guarded-fetch.ts';
import { summarize } from '../../src/diagnostics/report.ts';
import { exitCodeFor } from '../../src/diagnostics/selection-preview.ts';
import {
  DEFAULT_SIMULATED_SONGS,
  defaultOpenAiScenario,
  simId,
} from '../../src/diagnostics/simulated-world.ts';
import { EDITORIAL_CRITERIA } from '../../src/music-selection/criteria.ts';
import { parseProposals } from '../../src/music-selection/proposer.ts';
import { preparedTrack } from '../support/music.ts';
import { candidateOf, preview, scripted, song, world } from '../support/http-fakes.ts';

const ALLOWED_HOSTS = ['api.openai.com', 'api.spotify.com', 'accounts.spotify.com'];

describe('preview de selección con HTTP simulado', () => {
  it('una canción válida completa el recorrido y se informa con sus metadatos de Spotify', async () => {
    const a = song(1, { album: 'Álbum Uno', releaseYear: 1991 });
    const run = await preview(
      world(
        [a],
        scripted([
          {
            candidates: [candidateOf(a, { traits: ['mood-calm', 'rhythm-slow'] })],
          },
        ]),
      ),
    );

    const [sample] = run.samples;
    expect(sample?.status).toBe('selected');
    expect(sample?.selected).toMatchObject({
      title: a.title,
      artist: a.artist,
      album: 'Álbum Uno',
      releaseYear: 1991,
      spotifyTrackId: simId('sim', 1),
      spotifyUrl: `https://open.spotify.com/track/${simId('sim', 1)}`,
      traits: ['mood-calm', 'rhythm-slow'],
    });
    expect(sample?.selected?.description).toContain('Se destaca por');
    expect(sample?.rejections).toEqual([]);
    expect(exitCodeFor(run)).toBe(0);
  });

  it('descarta una propuesta inexistente y sigue con la siguiente', async () => {
    const a = song(1);
    const run = await preview(
      world(
        [a],
        scripted([
          {
            candidates: [
              { title: 'No Existe', artist: 'Nadie', releaseYear: 1990 },
              candidateOf(a),
            ],
          },
        ]),
      ),
    );
    const [sample] = run.samples;
    expect(sample?.status).toBe('selected');
    expect(sample?.rejections).toEqual([
      expect.objectContaining({ title: 'No Existe', artist: 'Nadie', reason: 'no-results' }),
    ]);
  });

  it('rechaza una grabación incorrecta (solo existe la versión en vivo)', async () => {
    const live = song(1, { album: 'Greatest Hits (Live at Somewhere)' });
    const other = song(2);
    const run = await preview(
      world([live, other], scripted([{ candidates: [candidateOf(live), candidateOf(other)] }])),
    );
    const [sample] = run.samples;
    expect(sample?.rejections.map((r) => r.reason)).toEqual(['wrong-version']);
    expect(sample?.selected?.title).toBe(other.title);
  });

  it('rechaza si el año propuesto no coincide con el de Spotify', async () => {
    const a = song(1, { releaseYear: 1990 });
    const b = song(2);
    const run = await preview(
      world(
        [a, b],
        scripted([{ candidates: [candidateOf(a, { releaseYear: 1975 }), candidateOf(b)] }]),
      ),
    );
    expect(run.samples[0]?.rejections.map((r) => r.reason)).toEqual(['year-mismatch']);
    expect(run.samples[0]?.selected?.title).toBe(b.title);
  });

  it('rechaza una canción ya utilizada en el catálogo local', async () => {
    const a = song(1);
    const b = song(2);
    const catalog = [
      // Mismo ID de Spotify que `a`, otro artista: duplicado por ID.
      preparedTrack('2026-06-01', 1, { spotifyTrackId: simId('sim', 1), artist: 'Otro Artista' }),
    ];
    const run = await preview(
      world([a, b], scripted([{ candidates: [candidateOf(a), candidateOf(b)] }])),
      { catalog },
    );
    expect(run.samples[0]?.rejections.map((r) => r.reason)).toEqual(['duplicate-track']);
    expect(run.samples[0]?.selected?.title).toBe(b.title);
  });

  it('rechaza un artista dentro de los 60 días del catálogo y lo acepta pasado ese plazo', async () => {
    const a = song(1);
    const b = song(2);
    const near = preparedTrack('2026-12-20', 7, { artist: a.artist, title: 'Otra de lo mismo' });
    const run = await preview(
      world([a, b], scripted([{ candidates: [candidateOf(a), candidateOf(b)] }])),
      { catalog: [near] },
    );
    expect(run.samples[0]?.rejections.map((r) => r.reason)).toEqual(['artist-cooldown']);

    const far = preparedTrack('2026-10-01', 7, { artist: a.artist, title: 'Otra de lo mismo' });
    const later = await preview(world([a], scripted([{ candidates: [candidateOf(a)] }])), {
      catalog: [far],
    });
    expect(later.samples[0]?.selected?.title).toBe(a.title);
  });

  it('una respuesta inválida de OpenAI pierde la ronda y termina sin selección (código 2)', async () => {
    const run = await preview(world([song(1)], () => ({ text: 'esto no es JSON' })));
    const [sample] = run.samples;
    expect(sample?.status).toBe('no-selection');
    expect(sample?.invalidResponses).toBeGreaterThan(0);
    expect(summarize(run).rejectionReasons['invalid-response']).toBe(sample?.invalidResponses);
    expect(exitCodeFor(run)).toBe(2);
  });

  it('Spotify 429 con Retry-After corto se reintenta esperando lo indicado', async () => {
    const a = song(1);
    const delays: number[] = [];
    const simulated = world([a], scripted([{ candidates: [candidateOf(a)] }]), ({ index }) =>
      index === 0 ? { status: 429, body: {}, headers: { 'retry-after': '2' } } : undefined,
    );
    const run = await preview(simulated, {
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(run.samples[0]?.status).toBe('selected');
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(2_000);
    const searches = simulated.requests.filter((r) => r.path === '/v1/search');
    expect(searches.length).toBeGreaterThanOrEqual(2);
  });

  it('Spotify 429 con Retry-After mayor al máximo no se espera: error sin reintentos', async () => {
    const a = song(1);
    const delays: number[] = [];
    const simulated = world([a], scripted([{ candidates: [candidateOf(a)] }]), ({ path }) =>
      path === '/v1/search'
        ? { status: 429, body: {}, headers: { 'retry-after': '3600' } }
        : undefined,
    );
    const run = await preview(simulated, {
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(run.samples[0]?.status).toBe('error');
    expect(run.samples[0]?.error?.kind).toBe('rate-limited');
    expect(delays).toEqual([]);
    expect(simulated.requests.filter((r) => r.path === '/v1/search')).toHaveLength(1);
    expect(exitCodeFor(run)).toBe(1);
  });

  it('OpenAI con cuota agotada (insufficient_quota) corta sin reintentar y sin volcar el cuerpo', async () => {
    const simulated = world([song(1)], () => ({
      http: {
        status: 429,
        body: { error: { code: 'insufficient_quota', message: 'detalle-crudo-que-no-debe-salir' } },
      },
    }));
    const run = await preview(simulated);
    const [sample] = run.samples;
    expect(sample?.status).toBe('error');
    expect(sample?.error?.kind).toBe('quota-exceeded');
    expect(JSON.stringify(run)).not.toContain('detalle-crudo-que-no-debe-salir');
    expect(simulated.requests.filter((r) => r.host === 'api.openai.com')).toHaveLength(1);
    expect(exitCodeFor(run)).toBe(1);
  });

  it('se agota el presupuesto temporal: error claro y ninguna llamada externa', async () => {
    const simulated = world([song(1)], scripted([{ candidates: [candidateOf(song(1))] }]));
    // Reloj fijo: con 10 s de presupuesto no entra ni el timeout de un intento (más la reserva).
    const run = await preview(simulated, { budgetMs: 10_000, now: () => 1_000_000 });
    expect(run.samples[0]?.status).toBe('error');
    expect(run.samples[0]?.error?.kind).toBe('time-budget-exhausted');
    expect(simulated.requests).toEqual([]);
    expect(exitCodeFor(run)).toBe(1);
  });

  it('el reloj del presupuesto corta una ejecución que avanza en el tiempo', async () => {
    const a = song(1);
    let clock = 0;
    const simulated = world([a], scripted([{ candidates: [candidateOf(a)] }]));
    const run = await preview(
      { ...simulated, fetch: (...args) => ((clock += 100_000), simulated.fetch(...args)) },
      { budgetMs: 150_000, now: () => clock },
    );
    // El token consume 100 s y ya no queda margen para la búsqueda.
    expect(run.samples[0]?.error?.kind).toBe('time-budget-exhausted');
  });

  it('varias muestras acumulan en memoria: cooldown entre fechas y resumen agregado', async () => {
    const simulated = world(DEFAULT_SIMULATED_SONGS, defaultOpenAiScenario());
    const run = await preview(simulated, { count: 3 });

    expect(run.samples.map((s) => s.status)).toEqual(['selected', 'selected', 'selected']);
    expect(run.samples.map((s) => s.date)).toEqual(['2027-01-01', '2027-01-02', '2027-01-03']);
    // La tercera muestra choca con el artista de la primera (acumulado en memoria).
    expect(run.samples[2]?.rejections.map((r) => r.reason)).toContain('artist-cooldown');

    const summary = summarize(run);
    expect(summary.selected).toBe(3);
    expect(summary.distinctArtists).toBe(3);
    expect(Object.values(summary.criteria).reduce((a, b) => a + b, 0)).toBe(3);
    expect(summary.rejectionReasons['artist-cooldown']).toBeGreaterThanOrEqual(1);
    expect(Object.keys(summary.decades).length).toBeGreaterThan(0);
  });

  it('un error corta la ejecución multi-muestra y lo marca', async () => {
    const run = await preview(
      world([song(1)], () => ({ http: { status: 401, body: {} } })),
      {
        count: 3,
      },
    );
    expect(run.samples).toHaveLength(1);
    expect(run.aborted).toBe(true);
  });

  it('identifica el criterio elegido y music-anniversary nunca se usa', async () => {
    const simulated = world(DEFAULT_SIMULATED_SONGS, defaultOpenAiScenario());
    const run = await preview(simulated, { count: 10 });

    for (const sample of run.samples) {
      expect(EDITORIAL_CRITERIA as readonly string[]).toContain(sample.selected?.criterion);
      expect(sample.criteriaTried).not.toContain('music-anniversary');
      expect(sample.rejections.map((r) => r.criterion)).not.toContain('music-anniversary');
    }
    const bodies = simulated.requests.filter((r) => r.host === 'api.openai.com').map((r) => r.body);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((body) => !body?.includes('music-anniversary'))).toBe(true);
  });

  it('no hay escrituras persistentes: solo hosts permitidos, sin playlists y sin datos de Spotify hacia OpenAI', async () => {
    const simulated = world(DEFAULT_SIMULATED_SONGS, defaultOpenAiScenario());
    const run = await preview(simulated, { count: 4 });

    expect(run.network.blocked).toBe(0);
    expect(simulated.requests.length).toBeGreaterThan(0);
    for (const request of simulated.requests) {
      expect(ALLOWED_HOSTS).toContain(request.host);
      expect(request.path).not.toContain('/playlists');
      if (request.method !== 'GET') {
        // Solo el token de Spotify y la propuesta de OpenAI son POST.
        const key = `${request.method} ${request.host}${request.path}`;
        expect([
          'POST accounts.spotify.com/api/token',
          'POST api.openai.com/v1/responses',
        ]).toContain(key);
      }
    }

    // Todo lo que solo Spotify conoce (IDs, álbumes, portadas, URLs) no puede viajar a OpenAI.
    const spotifyOnly = DEFAULT_SIMULATED_SONGS.flatMap((s, i) => [
      s.album,
      simId('sim', i + 1),
      simId('art', i + 1),
    ]).concat(['open.spotify.com', 'i.scdn.co', 'Bearer simulated-access-token']);
    const openAiBodies = simulated.requests.filter((r) => r.host === 'api.openai.com');
    expect(openAiBodies.length).toBeGreaterThan(0);
    for (const { body } of openAiBodies) {
      for (const secretOfSpotify of spotifyOnly) {
        expect(body).not.toContain(secretOfSpotify);
      }
    }
  });
});

describe('createGuardedFetch', () => {
  const ok = () => Promise.resolve(new Response('{}'));

  it('bloquea otros hosts, escrituras de playlists y rutas no previstas sin llamar al fetch interno', async () => {
    let calls = 0;
    const guard = createGuardedFetch(() => {
      calls += 1;
      return ok();
    });
    const attempts: [string, string][] = [
      ['POST', 'https://example.com/v1/responses'],
      ['POST', 'https://api.spotify.com/v1/playlists/abc/tracks'],
      ['PUT', 'https://api.spotify.com/v1/playlists/abc/tracks'],
      ['GET', 'https://api.spotify.com/v1/me'],
      ['GET', 'https://api.openai.com/v1/responses'],
      ['POST', 'http://api.openai.com/v1/responses'],
    ];
    for (const [method, url] of attempts) {
      await expect(guard.fetch(url, { method })).rejects.toThrow('Blocked request');
    }
    expect(calls).toBe(0);
    expect(guard.blocked).toHaveLength(attempts.length);
  });

  it('deja pasar solo las llamadas del camino de selección', async () => {
    const guard = createGuardedFetch(ok);
    await guard.fetch('https://api.openai.com/v1/responses', { method: 'POST' });
    await guard.fetch('https://accounts.spotify.com/api/token', { method: 'POST' });
    await guard.fetch('https://api.spotify.com/v1/search?q=x');
    await guard.fetch(`https://api.spotify.com/v1/tracks/${simId('sim', 1)}`);
    expect(guard.requests.map((r) => `${r.method} ${r.host}${r.path}`)).toEqual([
      'POST api.openai.com/v1/responses',
      'POST accounts.spotify.com/api/token',
      'GET api.spotify.com/v1/search',
      `GET api.spotify.com/v1/tracks/${simId('sim', 1)}`,
    ]);
  });
});

describe('ganchos de diagnóstico del proposer', () => {
  const text = JSON.stringify({
    candidates: [
      {
        title: 'A',
        artist: 'B',
        releaseYear: 1990,
        reason: 'classic-fresh',
        traits: ['mood-calm', 'rhythm-slow'],
      },
    ],
  });

  it('sin includeTraits la propuesta queda idéntica a la de producción', () => {
    const [proposal] = parseProposals(text, 'classic');
    expect(Object.keys(proposal as object).sort()).toEqual([
      'artist',
      'description',
      'releaseYear',
      'title',
    ]);
  });

  it('con includeTraits conserva motivo y rasgos', () => {
    const [proposal] = parseProposals(text, 'classic', { includeTraits: true });
    expect(proposal?.reasonId).toBe('classic-fresh');
    expect(proposal?.traits).toEqual(['mood-calm', 'rhythm-slow']);
  });
});
