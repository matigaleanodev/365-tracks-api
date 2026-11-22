import { TRAIT_PHRASES, isTraitId } from '../music-selection/editorial-vocabulary.ts';
import type { PreviewRun, SampleReport } from './selection-preview.ts';

export interface PreviewSummary {
  selected: number;
  noSelection: number;
  errors: number;
  criteria: Record<string, number>;
  traits: { trait: string; count: number }[];
  repeatedPhrases: { phrase: string; count: number }[];
  distinctArtists: number;
  decades: Record<string, number>;
  rejectionReasons: Record<string, number>;
}

const REASON_SEPARATOR = ' Se destaca por ';

const bump = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

const sortedEntries = (counts: Record<string, number>) =>
  Object.entries(counts).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));

/** Resumen agregado de las muestras: sin cambiar pesos ni reglas, solo para ver tendencias. */
export function summarize(run: PreviewRun): PreviewSummary {
  const criteria: Record<string, number> = {};
  const traitCounts: Record<string, number> = {};
  const phraseCounts: Record<string, number> = {};
  const decades: Record<string, number> = {};
  const rejectionReasons: Record<string, number> = {};
  const artists = new Set<string>();

  for (const sample of run.samples) {
    for (const rejection of sample.rejections) bump(rejectionReasons, rejection.reason);
    if (sample.invalidResponses > 0) {
      rejectionReasons['invalid-response'] =
        (rejectionReasons['invalid-response'] ?? 0) + sample.invalidResponses;
    }
    const { selected } = sample;
    if (selected === undefined) continue;
    bump(criteria, selected.criterion);
    artists.add(selected.artist.toLowerCase());
    bump(decades, `${Math.floor(selected.releaseYear / 10) * 10}s`);
    for (const trait of selected.traits) {
      bump(traitCounts, trait);
      if (isTraitId(trait)) bump(phraseCounts, TRAIT_PHRASES[trait]);
    }
    const reasonSentence = selected.description.split(REASON_SEPARATOR)[0];
    if (reasonSentence) bump(phraseCounts, reasonSentence);
  }

  const count = (status: SampleReport['status']) =>
    run.samples.filter((sample) => sample.status === status).length;
  return {
    selected: count('selected'),
    noSelection: count('no-selection'),
    errors: count('error'),
    criteria,
    traits: sortedEntries(traitCounts).map(([trait, n]) => ({ trait, count: n })),
    repeatedPhrases: sortedEntries(phraseCounts)
      .filter(([, n]) => n > 1)
      .map(([phrase, n]) => ({ phrase, count: n })),
    distinctArtists: artists.size,
    decades,
    rejectionReasons,
  };
}

export function formatJson(run: PreviewRun): string {
  return `${JSON.stringify({ ...run, summary: summarize(run) }, null, 2)}\n`;
}

const list = (counts: Record<string, number>) =>
  sortedEntries(counts)
    .map(([key, n]) => `${key}=${n}`)
    .join(', ') || 'ninguno';

function formatSample(sample: SampleReport): string[] {
  const lines = [`== ${sample.date} ==`];
  const { selected } = sample;
  if (selected !== undefined) {
    lines.push(
      `Elegida: "${selected.title}" de ${selected.artist}`,
      `  Spotify: álbum "${selected.album}", año ${selected.releaseYear}, ${selected.spotifyUrl}`,
      `  Criterio: ${selected.criterion}`,
      `  Descripción: ${selected.description}`,
      `  Motivo: ${selected.reasonId ?? '-'}; rasgos: ${selected.traits.join(', ') || '-'}`,
    );
  } else if (sample.status === 'no-selection') {
    lines.push('Sin selección válida dentro de los límites de rondas y criterios.');
  } else if (sample.error) {
    lines.push(`Error (${sample.error.kind}): ${sample.error.message}`);
  }
  lines.push(
    `  Criterios probados: ${sample.criteriaTried.join(', ') || '-'}; rondas: ${sample.rounds}; ` +
      `respuestas inválidas del modelo: ${sample.invalidResponses}; ${sample.elapsedMs} ms`,
  );
  if (sample.rejections.length > 0) {
    lines.push('  Propuestas descartadas (propuesto por el modelo):');
    for (const r of sample.rejections) {
      lines.push(`    - "${r.title}" de ${r.artist} [${r.criterion}]: ${r.reason}`);
    }
  }
  return lines;
}

export function formatText(run: PreviewRun): string {
  const lines = [
    run.mode === 'simulate'
      ? 'PREVIEW DE SELECCIÓN (SIMULADO: sin red, datos ficticios)'
      : 'PREVIEW DE SELECCIÓN (LIVE: llamadas reales a OpenAI y Spotify)',
    `Desde ${run.startDate}, ${run.requested} fecha(s), catálogo local inicial: ${run.catalogSize} canción(es). No se guarda ni publica nada.`,
    '',
  ];
  for (const sample of run.samples) lines.push(...formatSample(sample), '');
  if (run.aborted) lines.push('La ejecución se cortó por un error: faltan muestras.', '');

  const summary = summarize(run);
  lines.push(
    'Resumen',
    `  Seleccionadas: ${summary.selected}; sin selección: ${summary.noSelection}; errores: ${summary.errors}`,
    `  Criterios: ${list(summary.criteria)}`,
    `  Rasgos: ${summary.traits.map((t) => `${t.trait}=${t.count}`).join(', ') || 'ninguno'}`,
    `  Frases repetidas: ${summary.repeatedPhrases.map((p) => `"${p.phrase}" x${p.count}`).join('; ') || 'ninguna'}`,
    `  Artistas distintos: ${summary.distinctArtists}`,
    `  Décadas: ${list(summary.decades)}`,
    `  Motivos de descarte: ${list(summary.rejectionReasons)}`,
    run.network.mode === 'simulated'
      ? `  Peticiones simuladas (sin red): ${run.network.requests} (${list(run.network.byHost)}); bloqueadas: ${run.network.blocked}`
      : `  Red real: ${run.network.requests} petición(es) (${list(run.network.byHost)}); bloqueadas: ${run.network.blocked}`,
  );
  return `${lines.join('\n')}\n`;
}
