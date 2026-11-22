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

  it('el workflow de despliegue entrega el input a la síntesis', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/deploy.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain('cors_allowed_origins:');
    expect(workflow).toContain("default: 'http://localhost:4200'");
    expect(workflow).toContain('CORS_ALLOWED_ORIGINS: ${{ inputs.cors_allowed_origins }}');
  });

  describe('workflow de despliegue: Schedulers', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/deploy.yml', import.meta.url),
      'utf8',
    );

    it.each(['schedule_enabled', 'playlist_schedule_enabled'])(
      'el input %s es booleano, opcional y false por defecto',
      (name) => {
        const block = new RegExp(`^ {6}${name}:\\n(?: {8}.*\\n)+`, 'm').exec(workflow)?.[0];
        expect(block).toBeDefined();
        expect(block).toContain('type: boolean');
        expect(block).toContain('default: false');
        expect(block).toContain('required: false');
      },
    );

    it('pasa ambos estados a CDK como contexto, por entorno y sin interpolar en el script', () => {
      expect(workflow).toContain('SCHEDULE_ENABLED_INPUT: ${{ inputs.schedule_enabled }}');
      expect(workflow).toContain(
        'PLAYLIST_SCHEDULE_ENABLED_INPUT: ${{ inputs.playlist_schedule_enabled }}',
      );
      expect(workflow).toContain('-c "scheduleEnabled=$SCHEDULE_ENABLED_INPUT"');
      expect(workflow).toContain('-c "playlistScheduleEnabled=$PLAYLIST_SCHEDULE_ENABLED_INPUT"');
      expect(workflow).toContain(
        'npx cdk synth Tracks365ApiStack "${schedule_context[@]}" --quiet --no-lookups',
      );
      expect(workflow).toContain(
        'unset PUBLISH_TIME_UTC SCHEDULE_ENABLED PLAYLIST_SCHEDULE_ENABLED PLAYLIST_SYNC_TIME_UTC',
      );
      // El estado se verifica antes de crear el change set, y el deploy reutiliza el ensamblado verificado.
      const synth = workflow.indexOf('npx cdk synth Tracks365ApiStack');
      const check = workflow.indexOf('no coincide con schedule_enabled');
      const deploy = workflow.indexOf('npx cdk deploy Tracks365ApiStack --app cdk.out');
      expect(synth).toBeGreaterThan(-1);
      expect(check).toBeGreaterThan(synth);
      expect(deploy).toBeGreaterThan(check);
      expect(workflow.match(/\$\{\{ *inputs\.(schedule|playlist)/g)).toHaveLength(2);
    });
  });
});
