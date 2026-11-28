import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveStackConfig } from '../../infra/config.ts';

const noContext = () => undefined;

describe('resolveStackConfig', () => {
  it('usa defaults seguros sin configuración', () => {
    expect(resolveStackConfig(noContext, {})).toEqual({
      corsAllowedOrigins: [],
      publishTime: { hour: 0, minute: 0 },
      scheduleEnabled: false,
      playlistSyncTime: { hour: 12, minute: 30 },
      playlistScheduleEnabled: false,
    });
  });

  it('lee variables de entorno', () => {
    const config = resolveStackConfig(noContext, {
      CORS_ALLOWED_ORIGINS: 'http://localhost:4200, https://365tracks.example',
      PUBLISH_TIME_UTC: '06:30',
      SCHEDULE_ENABLED: 'true',
      PLAYLIST_SYNC_TIME_UTC: '13:15',
      PLAYLIST_SCHEDULE_ENABLED: 'true',
    });
    expect(config).toEqual({
      corsAllowedOrigins: ['http://localhost:4200', 'https://365tracks.example'],
      publishTime: { hour: 6, minute: 30 },
      scheduleEnabled: true,
      playlistSyncTime: { hour: 13, minute: 15 },
      playlistScheduleEnabled: true,
    });
  });

  it('el contexto tiene prioridad sobre el entorno', () => {
    const context = (key: string) => (key === 'publishTimeUtc' ? '12:00' : undefined);
    expect(resolveStackConfig(context, { PUBLISH_TIME_UTC: '06:30' }).publishTime).toEqual({
      hour: 12,
      minute: 0,
    });
  });

  it('el contexto en false gana sobre un entorno heredado en true', () => {
    const context = (key: string) =>
      ({ scheduleEnabled: 'false', playlistScheduleEnabled: 'false' })[key];
    const config = resolveStackConfig(context, {
      SCHEDULE_ENABLED: 'true',
      PLAYLIST_SCHEDULE_ENABLED: 'true',
    });
    expect(config.scheduleEnabled).toBe(false);
    expect(config.playlistScheduleEnabled).toBe(false);
  });

  it('cada flag se resuelve de forma independiente', () => {
    const only = (key: string) => (k: string) => {
      if (k === key) return 'true';
      return k === 'scheduleEnabled' || k === 'playlistScheduleEnabled' ? 'false' : undefined;
    };
    const daily = resolveStackConfig(only('scheduleEnabled'), {});
    expect([daily.scheduleEnabled, daily.playlistScheduleEnabled]).toEqual([true, false]);
    const playlist = resolveStackConfig(only('playlistScheduleEnabled'), {});
    expect([playlist.scheduleEnabled, playlist.playlistScheduleEnabled]).toEqual([false, true]);
  });

  it.each(['TRUE', 'True', '1', 'yes', '', ' '])(
    'rechaza el valor booleano %j en el contexto',
    (value) => {
      const context = (key: string) => (key === 'scheduleEnabled' ? value : undefined);
      expect(() => resolveStackConfig(context, {})).toThrow(/boolean/);
      const playlist = (key: string) => (key === 'playlistScheduleEnabled' ? value : undefined);
      expect(() => resolveStackConfig(playlist, {})).toThrow(/boolean/);
    },
  );

  it.each([
    [{ PUBLISH_TIME_UTC: '24:00' }, /publish time/],
    [{ SCHEDULE_ENABLED: 'TRUE' }, /boolean/],
    [{ PLAYLIST_SCHEDULE_ENABLED: '1' }, /boolean/],
    [{ PLAYLIST_SCHEDULE_ENABLED: '' }, /boolean/],
    [{ PLAYLIST_SYNC_TIME_UTC: '00:00' }, /12:00 UTC or later/],
    [{ PUBLISH_TIME_UTC: '6:30' }, /publish time/],
    [{ SCHEDULE_ENABLED: 'yes' }, /boolean/],
    [{ PLAYLIST_SCHEDULE_ENABLED: 'yes' }, /boolean/],
    [{ PLAYLIST_SYNC_TIME_UTC: '11:59' }, /12:00 UTC or later/],
    [{ PLAYLIST_SYNC_TIME_UTC: '9:00' }, /playlist sync time/],
    [{ CORS_ALLOWED_ORIGINS: 'https://site.example/' }, /CORS origin/],
    [{ CORS_ALLOWED_ORIGINS: 'site.example' }, /CORS origin/],
    [{ CORS_ALLOWED_ORIGINS: '*' }, /wildcard/],
    [{ CORS_ALLOWED_ORIGINS: 'http://localhost:4200,*' }, /wildcard/],
    [{ CORS_ALLOWED_ORIGINS: 'http://365tracks.example' }, /https/],
    [{ CORS_ALLOWED_ORIGINS: 'ftp://localhost' }, /https/],
  ])('rechaza configuración inválida %j', (env, message) => {
    expect(() => resolveStackConfig(noContext, env)).toThrow(message);
  });
});

describe('orígenes CORS', () => {
  const origins = (value: string) =>
    resolveStackConfig(noContext, { CORS_ALLOWED_ORIGINS: value }).corsAllowedOrigins;

  it('acepta localhost por http y el dominio definitivo por https', () => {
    expect(origins('http://localhost:4200,https://365tracks.example')).toEqual([
      'http://localhost:4200',
      'https://365tracks.example',
    ]);
    expect(origins('http://127.0.0.1:4200')).toEqual(['http://127.0.0.1:4200']);
  });

  it('ignora espacios, entradas vacías y duplicados', () => {
    expect(origins(' http://localhost:4200 ,, http://localhost:4200 ')).toEqual([
      'http://localhost:4200',
    ]);
  });

  it('una lista vacía deja la API sin CORS', () => {
    expect(origins('')).toEqual([]);
  });

  describe('workflow de despliegue', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/deploy.yml', import.meta.url),
      'utf8',
    );
    const config = JSON.parse(
      readFileSync(new URL('../../deploy/production.json', import.meta.url), 'utf8'),
    ) as {
      corsAllowedOrigins: string[];
      scheduleEnabled: boolean;
      playlistScheduleEnabled: boolean;
    };

    it('se dispara al integrar en main y admite ejecución manual sin inputs', () => {
      expect(workflow).toMatch(
        /^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/m,
      );
      expect(workflow).not.toContain('inputs');
      expect(workflow).toContain("github.ref == 'refs/heads/main'");
    });

    it('la configuración versionada es válida y deja apagadas las automatizaciones editoriales', () => {
      const resolved = resolveStackConfig(
        (key) =>
          ({
            corsAllowedOrigins: config.corsAllowedOrigins.join(','),
            scheduleEnabled: String(config.scheduleEnabled),
            playlistScheduleEnabled: String(config.playlistScheduleEnabled),
          })[key],
        {},
      );
      // Producción solo acepta el dominio público del frontend.
      expect(resolved.corsAllowedOrigins).toEqual(['https://daywave.matiasgaleano.dev']);
      // Activarlas es una decisión explícita (cambio revisado en este archivo), no un default.
      expect(config.scheduleEnabled).toBe(false);
      expect(config.playlistScheduleEnabled).toBe(false);
    });

    it('lee CORS y Schedulers del archivo y los pasa a CDK como contexto', () => {
      expect(workflow).toContain('config=deploy/production.json');
      expect(workflow).toContain('-c "scheduleEnabled=$SCHEDULE_ENABLED_INPUT"');
      expect(workflow).toContain('-c "playlistScheduleEnabled=$PLAYLIST_SCHEDULE_ENABLED_INPUT"');
      expect(workflow).toContain(
        'npx cdk synth Tracks365ApiStack "${schedule_context[@]}" --quiet --no-lookups',
      );
      expect(workflow).toContain(
        'unset PUBLISH_TIME_UTC SCHEDULE_ENABLED PLAYLIST_SCHEDULE_ENABLED PLAYLIST_SYNC_TIME_UTC',
      );
      // El estado se verifica antes de crear el change set, y el deploy reutiliza el ensamblado verificado.
      const read = workflow.indexOf('config=deploy/production.json');
      const synth = workflow.indexOf('npx cdk synth Tracks365ApiStack');
      const check = workflow.indexOf('no coincide con scheduleEnabled');
      const deploy = workflow.indexOf('npx cdk deploy Tracks365ApiStack --app cdk.out');
      expect(read).toBeGreaterThan(-1);
      expect(synth).toBeGreaterThan(read);
      expect(check).toBeGreaterThan(synth);
      expect(deploy).toBeGreaterThan(check);
    });

    it('un plan sin cambios termina en verde y no ejecuta nada', () => {
      expect(workflow).toContain('echo "noop=true" >> "$GITHUB_OUTPUT"');
      expect(workflow).toContain(
        "if: github.ref == 'refs/heads/main' && needs.plan.outputs.noop == 'false'",
      );
    });

    it('publica la release solo después de ejecutar el change set y sin pisar una existente', () => {
      const release = workflow.slice(workflow.indexOf('\n  release:'));
      expect(release).toContain('needs: [plan, execute]');
      expect(release).toContain("needs.execute.result == 'success'");
      expect(release).toContain("needs.plan.outputs.noop == 'true'");
      expect(release).toContain('contents: write');
      expect(release).toContain('gh release view "$tag"');
      expect(release).toContain('--target "$GITHUB_SHA"');
    });
  });
});
