import type { IsoDate } from '../shared/dates.ts';
import type { SpotifyTrack } from './index.ts';

/** Propuesta editorial que hay que resolver contra el catálogo real de Spotify. */
export interface MatchProposal {
  title: string;
  artist: string;
  releaseYear: number;
  /** Fecha completa de lanzamiento que el modelo afirma; solo se usa para efemérides. */
  releaseDate?: string | null;
}

export type MatchRejection =
  | 'no-results'
  | 'artist-mismatch'
  | 'title-mismatch'
  | 'wrong-version'
  | 'ambiguous'
  | 'year-mismatch'
  | 'anniversary-unverified';

export type MatchResult =
  { status: 'matched'; track: SpotifyTrack } | { status: 'rejected'; reason: MatchRejection };

export interface MatchOptions {
  /** Fecha editorial de la canción: las efemérides se verifican contra su mes y día. */
  editorialDate: IsoDate;
  requireAnniversary: boolean;
}

/** Diferencia de años tolerada entre lo que afirma el modelo y lo que informa Spotify. */
const YEAR_TOLERANCE = 1;

export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Compara nombres de artista sin artículo inicial ("The Beatles" = "Beatles"). */
export function normalizeArtist(value: string): string {
  return normalizeText(value).replace(/^the /, '');
}

/** Sufijos que no cambian la grabación: remasters, mono/stereo, versión de álbum o single. */
const NEUTRAL_SEGMENT =
  /^(?:\d{4} )?(?:digital )?re ?master(?:ed)?(?: (?:version|\d{4}))*$|^(?:mono|stereo)(?: (?:version|mix))?$|^(?:single|album|original|radio) (?:version|edit|mix)$|^\d{4} (?:mix|version)$/;

/** Título sin sufijos neutros ni acentos: la base para decidir si dos títulos son el mismo. */
export function coreTitle(title: string): string {
  const withoutBrackets = title.replace(/[([][^)\]]*[)\]]/g, (group) =>
    NEUTRAL_SEGMENT.test(normalizeText(group)) ? ' ' : group,
  );
  const [head = '', ...rest] = withoutBrackets.split(/\s[-–]\s/);
  const kept = rest.filter((segment) => !NEUTRAL_SEGMENT.test(normalizeText(segment)));
  return normalizeText([head, ...kept].join(' '));
}

const LIVE_ALBUM = /\b(?:live|en vivo|ao vivo)\b/;

function monthDay(date: string): string {
  return date.slice(5, 10);
}

/**
 * Decide si alguno de los resultados de Spotify es, sin dudas, la canción propuesta.
 * Las dudas se rechazan: es preferible pedir otra propuesta que guardar una coincidencia
 * incorrecta. Nada de esto envía datos de Spotify a ningún modelo; es comparación local.
 */
export function matchProposal(
  results: readonly SpotifyTrack[],
  proposal: MatchProposal,
  { editorialDate, requireAnniversary }: MatchOptions,
): MatchResult {
  const reject = (reason: MatchRejection): MatchResult => ({ status: 'rejected', reason });
  if (results.length === 0) return reject('no-results');

  const wantedTitle = coreTitle(proposal.title);
  const wantedArtist = normalizeArtist(proposal.artist);
  const wantsLive = LIVE_ALBUM.test(normalizeText(proposal.title));

  const sameArtist = results.filter((track) => normalizeArtist(track.artist) === wantedArtist);
  if (sameArtist.length === 0) return reject('artist-mismatch');

  const sameTitle = sameArtist.filter((track) => coreTitle(track.title) === wantedTitle);
  if (sameTitle.length === 0) {
    const extended = sameArtist.some((track) =>
      coreTitle(track.title).startsWith(`${wantedTitle} `),
    );
    return reject(extended ? 'wrong-version' : 'title-mismatch');
  }

  // Un álbum en vivo trae el mismo título de canción: se descarta salvo que se haya pedido.
  const studio = sameTitle.filter(
    (track) => wantsLive || !LIVE_ALBUM.test(normalizeText(track.album)),
  );
  if (studio.length === 0) return reject('wrong-version');

  if (new Set(studio.map((track) => track.artistId)).size > 1) return reject('ambiguous');

  const nearYear = studio.filter(
    (track) => Math.abs(track.releaseYear - proposal.releaseYear) <= YEAR_TOLERANCE,
  );
  if (nearYear.length === 0) return reject('year-mismatch');

  let candidates = nearYear;
  if (requireAnniversary) {
    const claimed = proposal.releaseDate;
    candidates = nearYear.filter(
      (track) =>
        typeof claimed === 'string' &&
        track.releaseDatePrecision === 'day' &&
        track.releaseDate === claimed &&
        monthDay(claimed) === monthDay(editorialDate) &&
        Number(claimed.slice(0, 4)) < Number(editorialDate.slice(0, 4)),
    );
    if (candidates.length === 0) return reject('anniversary-unverified');
  }

  // Misma grabación en varios lanzamientos: año exacto, luego álbum/single, luego el más antiguo.
  const rank = (track: SpotifyTrack) => [
    track.releaseYear === proposal.releaseYear ? 0 : 1,
    track.albumType === 'compilation' ? 1 : 0,
    track.releaseDate,
  ];
  const [best] = [...candidates].sort((a, b) => {
    const [ay, ac, ad] = rank(a) as [number, number, string];
    const [by, bc, bd] = rank(b) as [number, number, string];
    return ay - by || ac - bc || ad.localeCompare(bd);
  });
  return best ? { status: 'matched', track: best } : reject('no-results');
}
