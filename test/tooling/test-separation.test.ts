import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.ts';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };

/** Scripts que `test` y `check` ejecutan, expandiendo `npm run <nombre>` de forma transitiva. */
function expandScript(name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) {
    return [];
  }
  seen.add(name);
  const body = packageJson.scripts[name] ?? '';
  const nested = [...body.matchAll(/npm run ([\w:-]+)/g)].flatMap((match) =>
    expandScript(match[1] as string, seen),
  );
  return [body, ...nested];
}

describe('separación entre tests unitarios y de integración', () => {
  it('la configuración de vitest solo incluye test/ y no test-integration/', () => {
    const include = config.test?.include ?? [];
    expect(include.length).toBeGreaterThan(0);
    for (const pattern of include) {
      expect(pattern.startsWith('test/')).toBe(true);
      expect(pattern).not.toContain('test-integration');
    }
  });

  it('`npm test` y `npm run check` no invocan los tests de integración ni Docker', () => {
    for (const name of ['test', 'check']) {
      const commands = expandScript(name).join('\n');
      expect(commands).not.toMatch(/test:integration|integration-dynamodb|vitest\.integration/);
      expect(commands).not.toMatch(/docker/i);
    }
  });

  it('la suite de integración es un script aparte', () => {
    expect(packageJson.scripts['test:integration']).toBeDefined();
    expect(packageJson.scripts['test']).toBe('vitest run');
  });
});
