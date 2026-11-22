import type { IsoDate } from '../shared/dates.ts';

export interface DiversityTargets {
  decade: string;
  region: string;
  genre: string;
}

const DECADES = ['1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s', '1950s'];
const REGIONS = [
  'English-speaking world (US, UK, Ireland, Canada, Australia)',
  'Spanish-language music (Latin America and Spain)',
  'Brazil and Portuguese-language music',
  'Continental Europe outside English (French, Italian, German, Nordic and others)',
  'Africa and the Caribbean',
  'Asia and the Middle East',
  'Global folk and traditional music, any region',
];
const GENRES = [
  'rock',
  'pop',
  'soul, funk or R&B',
  'jazz',
  'hip-hop',
  'electronic or dance',
  'folk or singer-songwriter',
  'blues',
  'reggae or dub',
  'latin or tropical',
  'punk or new wave',
];

const DAY_MS = 86_400_000;

const pick = (list: readonly string[], index: number): string => list[index % list.length] ?? '';

/**
 * Objetivos blandos para alternar décadas, regiones/idiomas y géneros. Salen solo de la fecha
 * (pasos coprimos con el tamaño de cada lista): son una rotación editorial propia, así que no
 * hace falta enviarle al modelo el historial del catálogo, que viene de Spotify.
 */
export function getDiversityTargets(date: IsoDate): DiversityTargets {
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
  return {
    decade: pick(DECADES, day * 3),
    region: pick(REGIONS, day * 2),
    genre: pick(GENRES, day * 4),
  };
}
