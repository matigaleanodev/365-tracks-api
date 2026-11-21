import type { IsoDate } from '../shared/dates.ts';
import type { SpotifyClient } from '../spotify/index.ts';
import { matchProposal } from '../spotify/matching.ts';
import { findDescriptionIssues } from '../tracks/description.ts';
import { readAllTracks } from '../tracks/read-all.ts';
import type { TrackRepository } from '../tracks/repository.ts';
import {
  DEFAULT_CRITERIA_WEIGHTS,
  rankCriteria,
  type CriteriaWeights,
  type EditorialCriterion,
} from './criteria.ts';
import { getDiversityTargets } from './diversity.ts';
import type { MusicSelector, TrackSelection } from './index.ts';
import {
  ProposalResponseError,
  type RejectedProposal,
  type SongProposal,
  type SongProposer,
} from './proposer.ts';
import { buildHistory, DEFAULT_ARTIST_COOLDOWN_DAYS, findViolation } from './rules.ts';
import { recordingKeyOf } from './recording-key.ts';

export interface EditorialSelectorOptions {
  proposer: SongProposer;
  spotify: SpotifyClient;
  /** Solo se lee: el selector no escribe; guarda `generateDailyTrack`. */
  repository: Pick<TrackRepository, 'list'>;
  weights?: CriteriaWeights;
  artistCooldownDays?: number;
  /** Candidatos que se piden al modelo por ronda. */
  candidatesPerRound?: number;
  /** Rondas con el mismo criterio antes de pasar al siguiente de mayor déficit. */
  maxRoundsPerCriterion?: number;
  /** Criterios que se prueban como máximo (acota el costo de OpenAI por fecha). */
  maxCriteriaTried?: number;
}

/**
 * No se encontró una canción válida dentro de los límites. El mensaje solo lleva la fecha y
 * conteos por motivo: nunca títulos ni artistas, porque puede terminar en logs y la canción
 * aún es futura.
 */
export class SelectionFailedError extends Error {
  readonly reasons: Readonly<Record<string, number>>;

  constructor(date: IsoDate, reasons: Record<string, number>) {
    const summary = Object.entries(reasons)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(', ');
    super(`No valid song could be selected for ${date} (${summary || 'no candidates'})`);
    this.name = 'SelectionFailedError';
    this.reasons = reasons;
  }
}

/**
 * Selector editorial. El modelo solo propone candidatos a partir de instrucciones editoriales;
 * Spotify resuelve la canción real y todas las validaciones (coincidencia, duplicados, artistas,
 * descripción) son locales. Nada obtenido de Spotify se envía al modelo.
 */
export function createEditorialSelector({
  proposer,
  spotify,
  repository,
  weights = DEFAULT_CRITERIA_WEIGHTS,
  artistCooldownDays = DEFAULT_ARTIST_COOLDOWN_DAYS,
  candidatesPerRound = 6,
  maxRoundsPerCriterion = 2,
  maxCriteriaTried = 3,
}: EditorialSelectorOptions): MusicSelector {
  return {
    async select(date): Promise<TrackSelection> {
      const tracks = await readAllTracks(repository);
      const history = buildHistory(tracks);
      const criteria = rankCriteria(tracks, weights).slice(0, maxCriteriaTried);
      const targets = getDiversityTargets(date);

      const reasons: Record<string, number> = {};
      const tally = (reason: string) => {
        reasons[reason] = (reasons[reason] ?? 0) + 1;
      };
      const considered: RejectedProposal[] = [];
      const seen = new Set<string>();

      const evaluate = async (
        proposal: SongProposal,
        criterion: EditorialCriterion,
      ): Promise<TrackSelection | null> => {
        const discard = (reason: string) => {
          tally(reason);
          return null;
        };
        // Primero lo que no cuesta una llamada a Spotify.
        if (
          findDescriptionIssues(proposal.description, {
            allowedYears: [proposal.releaseYear],
            forbidMonths: true,
          }).length > 0
        ) {
          return discard('invalid-description');
        }

        const results = await spotify.searchTracks({
          title: proposal.title,
          artist: proposal.artist,
        });
        const match = matchProposal(results, proposal, {
          editorialDate: date,
          requireAnniversary: criterion === 'music-anniversary',
        });
        if (match.status === 'rejected') return discard(match.reason);

        const violation = findViolation(match.track, date, history, artistCooldownDays);
        if (violation !== null) return discard(violation);

        // El año que se menciona debe ser el verificado en Spotify, no solo el que dijo el modelo.
        if (
          findDescriptionIssues(proposal.description, {
            allowedYears: [match.track.releaseYear],
            forbidMonths: true,
          }).length > 0
        ) {
          return discard('invalid-description');
        }
        return {
          spotifyTrackId: match.track.id,
          selectionCriterion: criterion,
          description: proposal.description.trim(),
        };
      };

      for (const criterion of criteria) {
        for (let round = 0; round < maxRoundsPerCriterion; round += 1) {
          let proposals: SongProposal[];
          try {
            proposals = await proposer.propose({
              date,
              criterion,
              targets,
              count: candidatesPerRound,
              rejected: [...considered],
            });
          } catch (error) {
            // Una respuesta inservible cuenta como ronda perdida; un fallo de red/cuota no.
            if (error instanceof ProposalResponseError) {
              tally('invalid-response');
              continue;
            }
            throw error;
          }

          for (const proposal of proposals) {
            const key = recordingKeyOf(proposal.title, proposal.artist);
            if (seen.has(key)) continue;
            seen.add(key);
            considered.push({ title: proposal.title, artist: proposal.artist });

            const selection = await evaluate(proposal, criterion);
            if (selection !== null) return selection;
          }
        }
      }
      throw new SelectionFailedError(date, reasons);
    },
  };
}
