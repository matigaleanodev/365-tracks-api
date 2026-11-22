import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCatalog, CatalogFileError } from '../../src/diagnostics/catalog-file.ts';
import { runPreviewCli, type PreviewCliDeps } from '../../src/diagnostics/preview-cli.ts';
import { parsePreviewArgs } from '../../src/diagnostics/preview-config.ts';
import { preparedTrack } from '../support/music.ts';
import { candidateOf, scripted, song, world } from '../support/http-fakes.ts';

const SECRETS = {
  SPOTIFY_CLIENT_ID: 'cli-id-5f3a91c2',
  SPOTIFY_CLIENT_SECRET: 'cli-secret-77d0be41',
  OPENAI_API_KEY: 'sk-cli-key-c8e21aa9',
  OPENAI_MODEL: 'cli-model',
};

function harness(overrides: Partial<PreviewCliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const fetchSpy = vi.fn<typeof fetch>(() => Promise.reject(new Error('network must not be used')));
  const deps: PreviewCliDeps = {
    env: {},
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    fetch: fetchSpy,
    sleep: () => Promise.resolve(),
    ...overrides,
  };
  return { deps, fetchSpy, stdout: () => out.join(''), stderr: () => err.join('') };
}

afterEach(() => vi.unstubAllGlobals());

describe('puerta de red del CLI', () => {
  it('sin --live ni --simulate no llama a la red, explica qué falta y sale con 1', async () => {
    const h = harness({ env: SECRETS });
    const code = await runPreviewCli(['--date=2027-01-01'], h.deps);
    expect(code).toBe(1);
    expect(h.stderr()).toContain('--simulate');
    expect(h.stderr()).toContain('--live');
    expect(h.fetchSpy).not.toHaveBeenCalled();
    expect(h.stdout()).toBe('');
  });

  it('--live sin las cuatro variables falla antes de cualquier llamada y nombra solo las faltantes', async () => {
    const h = harness({ env: { SPOTIFY_CLIENT_ID: SECRETS.SPOTIFY_CLIENT_ID, OPENAI_MODEL: 'm' } });
    const code = await runPreviewCli(['--live'], h.deps);
    expect(code).toBe(1);
    expect(h.stderr()).toContain('SPOTIFY_CLIENT_SECRET');
    expect(h.stderr()).toContain('OPENAI_API_KEY');
    expect(h.stderr()).not.toContain(SECRETS.SPOTIFY_CLIENT_ID);
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });

  it('--simulate no usa la red real ni lee credenciales', async () => {
    const globalFetch = vi.fn(() => Promise.reject(new Error('global fetch must not be used')));
    vi.stubGlobal('fetch', globalFetch);
    const h = harness({ env: SECRETS, fetch: undefined as never });
    const code = await runPreviewCli(['--date=2027-01-01', '--simulate'], h.deps);
    expect(code).toBe(0);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(h.stdout()).toContain('SIMULADO');
    expect(h.stdout()).toContain('Elegida:');
    for (const value of Object.values(SECRETS))
      expect(h.stdout() + h.stderr()).not.toContain(value);
  });

  it('--live y --simulate juntos es un error', async () => {
    const h = harness();
    expect(await runPreviewCli(['--live', '--simulate'], h.deps)).toBe(1);
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });

  it('--live con las variables usa el fetch inyectado y nunca imprime las credenciales', async () => {
    const a = song(1);
    const simulated = world([a], scripted([{ candidates: [candidateOf(a)] }]));
    const h = harness({ env: SECRETS, fetch: simulated.fetch });
    const code = await runPreviewCli(['--live', '--json'], h.deps);
    expect(code).toBe(0);
    const report = JSON.parse(h.stdout()) as { mode: string; samples: { status: string }[] };
    expect(report.mode).toBe('live');
    expect(report.samples[0]?.status).toBe('selected');
    for (const value of Object.values(SECRETS))
      expect(h.stdout() + h.stderr()).not.toContain(value);
    // Las credenciales viajan solo hacia sus servicios.
    const headers = simulated.requests.map((r) => `${r.host}`);
    expect(headers).toContain('accounts.spotify.com');
  });

  it('un rechazo de credenciales de Spotify se informa sin cuerpos crudos ni secretos', async () => {
    const leaky = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: 'invalid_client', echo: SECRETS.SPOTIFY_CLIENT_SECRET }),
          {
            status: 401,
          },
        ),
      ),
    );
    const h = harness({ env: SECRETS, fetch: leaky });
    const code = await runPreviewCli(['--live'], h.deps);
    expect(code).toBe(1);
    expect(h.stdout()).toContain('Error (');
    for (const value of Object.values(SECRETS))
      expect(h.stdout() + h.stderr()).not.toContain(value);
    expect(h.stdout()).not.toContain('echo');
  });

  it('sin selección válida sale con 2', async () => {
    const simulated = world([song(1)], () => ({ text: 'no json' }));
    const h = harness({ env: SECRETS, fetch: simulated.fetch });
    expect(await runPreviewCli(['--live'], h.deps)).toBe(2);
    expect(h.stdout()).toContain('Sin selección válida');
  });
});

describe('argumentos y catálogo', () => {
  it('valida los argumentos', () => {
    expect(parsePreviewArgs(['--date=2027-02-30']).ok).toBe(false);
    expect(parsePreviewArgs(['--count=0']).ok).toBe(false);
    expect(parsePreviewArgs(['--count=11']).ok).toBe(false);
    expect(parsePreviewArgs(['--count=abc']).ok).toBe(false);
    expect(parsePreviewArgs(['--budget-ms=0']).ok).toBe(false);
    expect(parsePreviewArgs(['--catalog=']).ok).toBe(false);
    expect(parsePreviewArgs(['--nope']).ok).toBe(false);
    expect(parsePreviewArgs(['--date', '2027-01-01']).ok).toBe(false);
    const ok = parsePreviewArgs(['--date=2027-03-04', '--count=3', '--budget-ms=5000', '--json']);
    expect(ok).toMatchObject({
      ok: true,
      options: { date: '2027-03-04', count: 3, budgetMs: 5000, json: true, mode: undefined },
    });
  });

  it('CRITERIA_WEIGHTS con music-anniversary habilitado se rechaza', async () => {
    const weights = JSON.stringify({
      classic: 1,
      'hidden-gem': 1,
      'music-anniversary': 1,
      'genre-exploration': 1,
      'recent-release': 1,
      'cultural-date': 1,
    });
    const h = harness({ env: { CRITERIA_WEIGHTS: weights } });
    expect(await runPreviewCli(['--simulate'], h.deps)).toBe(1);
    expect(h.stderr()).toContain('music-anniversary');
  });

  it('valida el catálogo local: completo, una canción por fecha', () => {
    const good = preparedTrack('2026-12-01', 1);
    expect(parseCatalog([good])).toHaveLength(1);
    expect(() => parseCatalog({})).toThrow(CatalogFileError);
    expect(() => parseCatalog([{ ...good, description: undefined }])).toThrow(/incomplete/);
    expect(() => parseCatalog([good, { ...good, spotifyTrackId: 'x'.repeat(22) }])).toThrow(
      /duplicate date/,
    );
    expect(() => parseCatalog([{ ...good, coverUrl: 3 }])).toThrow(/coverUrl/);
  });

  it('--catalog siembra el repositorio en memoria y las reglas aplican', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'preview-catalog-'));
    const file = join(dir, 'catalog.json');
    const a = song(1);
    writeFileSync(file, JSON.stringify([preparedTrack('2026-12-20', 9, { artist: a.artist })]));
    const b = song(2);
    const simulated = world([a, b], scripted([{ candidates: [candidateOf(a), candidateOf(b)] }]));
    const h = harness({ env: SECRETS, fetch: simulated.fetch });
    const code = await runPreviewCli(['--live', `--catalog=${file}`, '--json'], h.deps);
    expect(code).toBe(0);
    const report = JSON.parse(h.stdout()) as {
      catalogSize: number;
      samples: { rejections: { reason: string }[] }[];
    };
    expect(report.catalogSize).toBe(1);
    expect(report.samples[0]?.rejections[0]?.reason).toBe('artist-cooldown');
  });

  it('un catálogo inexistente o con la fecha ocupada es un error de uso', async () => {
    const missing = harness();
    expect(await runPreviewCli(['--simulate', '--catalog=/no/existe.json'], missing.deps)).toBe(1);
    expect(missing.stderr()).toContain('could not be read');

    const taken = harness({
      loadCatalog: () => Promise.resolve([preparedTrack('2027-01-01', 1)]),
    });
    expect(await runPreviewCli(['--simulate', '--catalog=x.json'], taken.deps)).toBe(1);
    expect(taken.stderr()).toContain('already has a track for 2027-01-01');
  });
});

describe('salida simulada', () => {
  it('--simulate --count=3 informa tres fechas y un resumen', async () => {
    const h = harness();
    expect(await runPreviewCli(['--simulate', '--count=3'], h.deps)).toBe(0);
    const text = h.stdout();
    expect(text).toContain('== 2027-01-01 ==');
    expect(text).toContain('== 2027-01-03 ==');
    expect(text).toContain('Resumen');
    expect(text).toContain('artist-cooldown');
    expect(text).toContain('Peticiones simuladas (sin red):');
    expect(text).not.toContain('Red real');
  });

  it('en --live el resumen habla de red real y el JSON marca network.mode live', async () => {
    const a = song(1);
    const simulated = world([a], scripted([{ candidates: [candidateOf(a)] }]));
    const text = harness({ env: SECRETS, fetch: simulated.fetch });
    expect(await runPreviewCli(['--live'], text.deps)).toBe(0);
    expect(text.stdout()).toContain('Red real:');
    expect(text.stdout()).not.toContain('Peticiones simuladas');

    const again = world([a], scripted([{ candidates: [candidateOf(a)] }]));
    const json = harness({ env: SECRETS, fetch: again.fetch });
    await runPreviewCli(['--live', '--json'], json.deps);
    expect((JSON.parse(json.stdout()) as { network: { mode: string } }).network.mode).toBe('live');
  });

  it('--json produce JSON válido con resumen', async () => {
    const h = harness();
    expect(await runPreviewCli(['--simulate', '--json'], h.deps)).toBe(0);
    const report = JSON.parse(h.stdout()) as {
      summary: { selected: number };
      network: { blocked: number; mode: string };
    };
    expect(report.summary.selected).toBe(1);
    expect(report.network.blocked).toBe(0);
    expect(report.network.mode).toBe('simulated');
  });
});
