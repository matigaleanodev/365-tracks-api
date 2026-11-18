import { NotImplementedError } from '../shared/errors.ts';

export interface SpotifyTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  releaseYear: number;
  url: string;
  coverUrl?: string;
}

export interface SpotifyClient {
  getTrack(trackId: string): Promise<SpotifyTrack>;
}

export const notImplementedSpotifyClient: SpotifyClient = {
  getTrack: () => Promise.reject(new NotImplementedError('Spotify integration')),
};
