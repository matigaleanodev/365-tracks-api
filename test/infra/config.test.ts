import { describe, expect, it } from 'vitest';
import { resolveStackConfig } from '../../infra/config.ts';

const noContext = () => undefined;

describe('resolveStackConfig', () => {
  it('usa defaults seguros sin configuración', () => {
    expect(resolveStackConfig(noContext, {})).toEqual({
      corsAllowedOrigins: [],
      publishTime: { hour: 0, minute: 0 },
      scheduleEnabled: false,
    });
  });

  it('lee variables de entorno', () => {
    const config = resolveStackConfig(noContext, {
      CORS_ALLOWED_ORIGINS: 'http://localhost:4200, https://365tracks.example',
      PUBLISH_TIME_UTC: '06:30',
      SCHEDULE_ENABLED: 'true',
    });
    expect(config).toEqual({
      corsAllowedOrigins: ['http://localhost:4200', 'https://365tracks.example'],
      publishTime: { hour: 6, minute: 30 },
      scheduleEnabled: true,
    });
  });

  it('el contexto tiene prioridad sobre el entorno', () => {
    const context = (key: string) => (key === 'publishTimeUtc' ? '12:00' : undefined);
    expect(resolveStackConfig(context, { PUBLISH_TIME_UTC: '06:30' }).publishTime).toEqual({
      hour: 12,
      minute: 0,
    });
  });

  it.each([
    [{ PUBLISH_TIME_UTC: '24:00' }, /publish time/],
    [{ PUBLISH_TIME_UTC: '6:30' }, /publish time/],
    [{ SCHEDULE_ENABLED: 'yes' }, /boolean/],
    [{ CORS_ALLOWED_ORIGINS: 'https://site.example/' }, /CORS origin/],
    [{ CORS_ALLOWED_ORIGINS: 'site.example' }, /CORS origin/],
  ])('rechaza configuración inválida %j', (env, message) => {
    expect(() => resolveStackConfig(noContext, env)).toThrow(message);
  });
});
