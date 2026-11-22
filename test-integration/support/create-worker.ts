import { createInterface } from 'node:readline';
import { DynamoTrackRepository } from '../../src/tracks/dynamo-repository.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';
import { createDocClient } from './aws.ts';

/**
 * Proceso hijo de la prueba de concurrencia entre procesos: crea su cliente y su repositorio, avisa
 * `READY`, espera `GO` por stdin (barrera) y entonces llama a `create`; imprime `RESULT <json>`.
 * Uso: node create-worker.ts <tabla> <json de la canción>
 */
const [tableName, trackJson] = process.argv.slice(2);
if (!tableName || !trackJson) throw new Error('Usage: create-worker.ts <table> <track json>');

const track = JSON.parse(trackJson) as DailyTrack;
const repository = new DynamoTrackRepository(createDocClient(), tableName);
// Calienta la conexión y las credenciales para que, tras la barrera, solo quede `create`.
await repository.getByDate('1999-01-01');

const lines = createInterface({ input: process.stdin });
console.log('READY');
for await (const line of lines) {
  if (line.trim() !== 'GO') continue;
  const result = await repository.create(track);
  console.log(`RESULT ${JSON.stringify(result)}`);
  lines.close();
  break;
}
process.exit(0);
