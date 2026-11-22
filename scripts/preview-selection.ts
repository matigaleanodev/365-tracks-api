import { runPreviewCli } from '../src/diagnostics/preview-cli.ts';

// Uso: npm run preview:selection -- --date=2027-01-01 --simulate   (ver --help)
// Diagnóstico local: no guarda ni publica nada. Sin --live no hace llamadas de red.
process.exitCode = await runPreviewCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
