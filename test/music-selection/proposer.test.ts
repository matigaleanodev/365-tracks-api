import { describe, expect, it, vi } from 'vitest';
import {
  buildInstructions,
  buildRequestInput,
  createOpenAiProposer,
  extractOutputText,
  ProposalResponseError,
  parseProposals,
} from '../../src/music-selection/proposer.ts';
import { getDiversityTargets } from '../../src/music-selection/diversity.ts';
import {
  composeDescription,
  reasonIdsFor,
  TRAIT_IDS,
} from '../../src/music-selection/editorial-vocabulary.ts';

const CRITERION = 'hidden-gem';
const REASON = 'gem-quality';
const TRAITS = ['mood-nocturnal', 'synths-enveloping', 'rhythm-steady'];
const COMPOSED = composeDescription(CRITERION, REASON, TRAITS) as string;

const candidate = (overrides: Record<string, unknown> = {}) => ({
  title: ' Blue Monday ',
  artist: 'New Order',
  releaseYear: 1983,
  reason: REASON,
  traits: TRAITS,
  ...overrides,
});

const request = {
  date: '2027-03-15',
  criterion: CRITERION,
  targets: getDiversityTargets('2027-03-15'),
  count: 6,
  rejected: [{ title: 'Creep', artist: 'Radiohead' }],
} as const;

const completed = (text: string) => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
});

describe('extractOutputText', () => {
  it('lee el texto de salida', () => {
    expect(extractOutputText(completed('{"a":1}'))).toBe('{"a":1}');
  });

  it.each([
    ['respuesta no objeto', 'x'],
    ['incompleta', { status: 'incomplete', output: [] }],
    ['rechazo del modelo', { status: 'completed', output: [{ content: [{ type: 'refusal' }] }] }],
    ['sin texto', { status: 'completed', output: [] }],
  ])('rechaza: %s', (_name, json) => {
    expect(() => extractOutputText(json)).toThrow(ProposalResponseError);
  });
});

describe('parseProposals', () => {
  it('normaliza espacios y compone la descripción localmente', () => {
    const text = JSON.stringify({ candidates: [candidate()] });
    expect(parseProposals(text, CRITERION)).toEqual([
      { title: 'Blue Monday', artist: 'New Order', releaseYear: 1983, description: COMPOSED },
    ]);
  });

  it('descarta los candidatos con forma inválida y conserva el resto', () => {
    const text = JSON.stringify({
      candidates: [
        candidate({ title: '' }),
        candidate({ releaseYear: '1983' }),
        candidate({ releaseYear: 1983.5 }),
        'texto',
        candidate({ title: 'Ok' }),
      ],
    });
    expect(parseProposals(text, CRITERION).map((p) => p.title)).toEqual(['Ok']);
  });

  it('el texto libre del modelo nunca llega a la selección (campo extra descartado)', () => {
    const free = 'Publicada en mil novecientos setenta y nueve, en marzo, a fines de los setenta.';
    const text = JSON.stringify({
      candidates: [
        candidate({ title: 'Libre', description: free }),
        candidate({ title: 'Conforme' }),
      ],
    });
    const result = parseProposals(text, CRITERION);
    expect(result.map((p) => p.title)).toEqual(['Conforme']);
    expect(JSON.stringify(result)).not.toMatch(/novecientos|marzo|setenta/);
  });

  it('un candidato solo con descripción libre (sin ids) falla la respuesta completa', () => {
    const text = JSON.stringify({
      candidates: [
        {
          title: 'X',
          artist: 'Y',
          releaseYear: 1979,
          description: 'Publicada en mil novecientos setenta y nueve, en marzo.',
        },
      ],
    });
    expect(() => parseProposals(text, CRITERION)).toThrow(ProposalResponseError);
  });

  it.each([
    ['motivo desconocido', { reason: 'inventado' }],
    ['motivo de otro criterio', { reason: 'classic-craft' }],
    ['motivo con prototipo', { reason: 'constructor' }],
    ['rasgo desconocido', { traits: ['mood-calm', 'inventado'] }],
    ['rasgos repetidos', { traits: ['mood-calm', 'mood-calm'] }],
    ['un solo rasgo', { traits: ['mood-calm'] }],
    ['demasiados rasgos', { traits: ['mood-calm', 'mood-warm', 'voice-harmonies', 'rhythm-slow'] }],
    ['rasgos sin lista', { traits: 'mood-calm' }],
    ['rasgo no texto', { traits: ['mood-calm', 7] }],
    ['campo extra', { extra: 'x' }],
  ])('descarta el candidato con %s', (_name, overrides) => {
    const text = JSON.stringify({ candidates: [candidate(overrides), candidate({ title: 'Ok' })] });
    expect(parseProposals(text, CRITERION).map((p) => p.title)).toEqual(['Ok']);
  });

  it('un candidato sin motivo o sin rasgos se descarta', () => {
    const noReason = { ...candidate(), reason: undefined };
    const noTraits = { ...candidate(), traits: undefined };
    const text = JSON.stringify({ candidates: [noReason, noTraits, candidate({ title: 'Ok' })] });
    expect(parseProposals(text, CRITERION).map((p) => p.title)).toEqual(['Ok']);
  });

  it.each([
    ['JSON inválido', 'no json'],
    ['sin candidates', '{}'],
    ['candidates vacío', '{"candidates":[]}'],
    ['ninguno válido', JSON.stringify({ candidates: [candidate({ title: '' })] })],
    ['motivo desconocido', JSON.stringify({ candidates: [candidate({ reason: 'x' })] })],
  ])('falla con %s', (_name, text) => {
    expect(() => parseProposals(text, CRITERION)).toThrow(ProposalResponseError);
  });
});

describe('solicitud a OpenAI', () => {
  it('no incluye datos de Spotify: solo fecha, criterio, objetivos y lo ya descartado', () => {
    const input = JSON.parse(buildRequestInput(request)) as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual([
      'alreadyConsidered',
      'candidateCount',
      'criterion',
      'criterionBrief',
      'date',
      'softTargets',
    ]);
    expect(input.alreadyConsidered).toEqual([{ title: 'Creep', artist: 'Radiohead' }]);
  });

  it('las instrucciones prohíben inventar y no piden texto libre', () => {
    const text = buildInstructions();
    expect(text).toMatch(/Never invent/);
    expect(text).toMatch(/You do not write any description/);
  });

  it('envía store:false, salida estricta y la clave solo en el encabezado', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(completed(JSON.stringify({ candidates: [candidate()] })))),
      ),
    );
    const proposer = createOpenAiProposer({
      apiKey: 'sk-test-key',
      model: 'test-model',
      http: { fetch: fetchMock as unknown as typeof fetch, sleep: () => Promise.resolve() },
    });

    const result = await proposer.propose(request);

    expect(result).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test-key');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('sk-test-key');
    expect(body).toMatchObject({
      model: 'test-model',
      store: false,
      text: { format: { type: 'json_schema', strict: true } },
    });
  });

  it('el esquema enviado no tiene descripción libre: motivo y rasgos son enums cerrados', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(completed(JSON.stringify({ candidates: [candidate()] })))),
      ),
    );
    const proposer = createOpenAiProposer({
      apiKey: 'k',
      model: 'm',
      http: { fetch: fetchMock as unknown as typeof fetch, sleep: () => Promise.resolve() },
    });
    const [proposal] = await proposer.propose(request);
    expect(proposal?.description).toBe(COMPOSED);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      text: { format: { schema: Record<string, unknown> } };
    };
    const schema = body.text.format.schema as {
      properties: {
        candidates: {
          items: {
            additionalProperties: boolean;
            required: string[];
            properties: Record<
              string,
              { type: string; enum?: string[]; items?: { enum: string[] } }
            >;
          };
        };
      };
    };
    const item = schema.properties.candidates.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(['title', 'artist', 'releaseYear', 'reason', 'traits']);
    expect(Object.keys(item.properties)).not.toContain('description');
    expect(JSON.stringify(schema)).not.toMatch(/description/i);
    // Los únicos strings libres son título y artista; el resto son enums.
    expect(item.properties.reason?.enum).toEqual(reasonIdsFor(CRITERION));
    expect(item.properties.traits?.items?.enum).toEqual(TRAIT_IDS);
  });

  it('una respuesta inservible lanza ProposalResponseError', async () => {
    const proposer = createOpenAiProposer({
      apiKey: 'k',
      model: 'm',
      http: {
        fetch: (() =>
          Promise.resolve(new Response(JSON.stringify(completed('no json'))))) as typeof fetch,
      },
    });
    await expect(proposer.propose(request)).rejects.toBeInstanceOf(ProposalResponseError);
  });
});
