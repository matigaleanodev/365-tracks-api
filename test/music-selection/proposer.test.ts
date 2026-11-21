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
import { DESCRIPTION } from '../support/music.ts';

const candidate = (overrides: Record<string, unknown> = {}) => ({
  title: ' Blue Monday ',
  artist: 'New Order',
  releaseYear: 1983,
  releaseDate: null,
  description: DESCRIPTION,
  ...overrides,
});

const request = {
  date: '2027-03-15',
  criterion: 'hidden-gem',
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
  it('normaliza espacios y conserva los candidatos válidos', () => {
    const text = JSON.stringify({ candidates: [candidate()] });
    expect(parseProposals(text)).toEqual([
      {
        title: 'Blue Monday',
        artist: 'New Order',
        releaseYear: 1983,
        releaseDate: null,
        description: DESCRIPTION,
      },
    ]);
  });

  it('descarta los candidatos con forma inválida y conserva el resto', () => {
    const text = JSON.stringify({
      candidates: [
        candidate({ title: '' }),
        candidate({ releaseYear: '1983' }),
        candidate({ releaseYear: 1983.5 }),
        candidate({ releaseDate: '03/07/1983' }),
        candidate({ description: 7 }),
        'texto',
        candidate({ title: 'Ok' }),
      ],
    });
    expect(parseProposals(text).map((p) => p.title)).toEqual(['Ok']);
  });

  it.each([
    ['JSON inválido', 'no json'],
    ['sin candidates', '{}'],
    ['candidates vacío', '{"candidates":[]}'],
    ['ninguno válido', JSON.stringify({ candidates: [candidate({ title: '' })] })],
  ])('falla con %s', (_name, text) => {
    expect(() => parseProposals(text)).toThrow(ProposalResponseError);
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

  it('las instrucciones prohíben letras, citas e invenciones', () => {
    const text = buildInstructions('Spanish');
    expect(text).toContain('Spanish');
    expect(text).toMatch(/quotations, lyrics/);
    expect(text).toMatch(/Never invent/);
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
