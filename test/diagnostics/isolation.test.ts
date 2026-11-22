import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = resolve(ROOT, 'scripts/preview-selection.ts');

/** Rutas (relativas a la raíz) que el preview no puede alcanzar ni indirectamente. */
const FORBIDDEN_FILES = [
  'src/config/parameters.ts',
  'src/tracks/dynamo-repository.ts',
  'src/tracks/create-repository.ts',
  'src/spotify/playlist-client.ts',
];
const FORBIDDEN_PREFIXES = ['src/playlist/', 'src/jobs/'];
const FORBIDDEN_PACKAGES = [/^@aws-sdk\//, /^aws-cdk/, /^constructs$/];

const IMPORT_PATTERN =
  /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Recorre el grafo de imports estáticos y dinámicos con literal a partir del script. */
function walk(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = (match[1] ?? match[2] ?? match[3]) as string;
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier);
        expect(existsSync(target), `${relative(ROOT, file)} imports missing ${specifier}`).toBe(
          true,
        );
        pending.push(target);
      } else {
        packages.add(specifier);
      }
    }
  }
  return { files: [...files].map((file) => relative(ROOT, file)), packages: [...packages] };
}

describe('aislamiento estructural del preview', () => {
  const graph = walk(ENTRY);

  it('recorre el grafo real (el módulo del preview y la orquestación de selección)', () => {
    expect(graph.files).toContain('scripts/preview-selection.ts');
    expect(graph.files).toContain('src/diagnostics/preview-cli.ts');
    expect(graph.files).toContain('src/tracks/generate-daily-track.ts');
    expect(graph.files).toContain('src/music-selection/selector.ts');
  });

  it('no alcanza AWS, Parameter Store, DynamoDB, playlists ni los handlers de jobs', () => {
    const forbidden = graph.files.filter(
      (file) =>
        FORBIDDEN_FILES.includes(file) ||
        FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix)),
    );
    expect(forbidden).toEqual([]);
  });

  it('no depende de paquetes de AWS', () => {
    const forbidden = graph.packages.filter((name) =>
      FORBIDDEN_PACKAGES.some((rx) => rx.test(name)),
    );
    expect(forbidden).toEqual([]);
    expect(graph.packages).toEqual([]);
  });

  it('el recorrido detecta una dependencia prohibida si existiera (control del propio test)', () => {
    const control = walk(resolve(ROOT, 'src/jobs/dependencies.ts'));
    expect(control.packages.some((name) => name.startsWith('@aws-sdk/'))).toBe(true);
  });
});
