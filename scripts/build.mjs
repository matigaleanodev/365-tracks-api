// Empaqueta cada Lambda en un único index.mjs dentro de dist/<función>/.
import { rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist', { recursive: true, force: true });

const result = await build({
  entryPoints: {
    'api/index': 'src/api/handler.ts',
    'generate-daily-track/index': 'src/jobs/generate-daily-track-handler.ts',
    'sync-playlist/index': 'src/jobs/sync-playlist-handler.ts',
  },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  // El runtime de Lambda ya incluye el SDK v3.
  external: ['@aws-sdk/*'],
  metafile: true,
  logLevel: 'warning',
});

for (const [file, info] of Object.entries(result.metafile.outputs)) {
  if (file.endsWith('.mjs')) {
    console.log(`${file}  ${(info.bytes / 1024).toFixed(1)} KiB`);
  }
}
