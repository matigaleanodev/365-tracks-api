import { describe, expect, it } from 'vitest';
import type { ReplenishOutcome } from '../../src/tracks/catalog.ts';
import {
  classifyCatalogHealth,
  RUNWAY_LOW_DAYS,
  type CatalogHealthInput,
} from '../../src/tracks/catalog-health.ts';

const FROM = '2027-01-01';
const TO = '2027-01-30';
const dayOf = (n: number) => `2027-01-${String(n).padStart(2, '0')}`;
const days = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, i) => dayOf(first + i));

const report = (overrides: Partial<CatalogHealthInput> = {}): CatalogHealthInput => ({
  from: FROM,
  to: TO,
  created: [],
  incomplete: [],
  deferred: [],
  budgetExhausted: false,
  stillMissing: [],
  outcomes: [],
  ...overrides,
});

describe('classifyCatalogHealth', () => {
  it('catálogo completo: nada faltaba', () => {
    expect(classifyCatalogHealth(report())).toEqual({
      status: 'catalog-complete',
      incompleteCount: 0,
      missingCount: 0,
      preparedAhead: 30,
      runwayLow: false,
    });
  });

  it('progressed: creó al menos una fecha', () => {
    const outcomes: ReplenishOutcome[] = [{ date: dayOf(30), status: 'created' }];
    const health = classifyCatalogHealth(
      report({ created: [dayOf(30)], outcomes, stillMissing: days(28, 29) }),
    );
    expect(health.status).toBe('progressed');
    expect(health.preparedAhead).toBe(27);
    expect(health.missingCount).toBe(2);
  });

  it('progressed también cuando el tiempo se agotó a mitad de una fecha tras crear otras', () => {
    const health = classifyCatalogHealth(
      report({
        created: [dayOf(1)],
        budgetExhausted: true,
        deferred: days(2, 30),
        stillMissing: days(2, 30),
      }),
    );
    expect(health.status).toBe('progressed');
    expect(health.preparedAhead).toBe(1);
    expect(health.runwayLow).toBe(true);
  });

  it('stalled-no-time: caso intencional, todo diferido sin cortar ninguna fecha', () => {
    const health = classifyCatalogHealth(
      report({ deferred: days(1, 30), stillMissing: days(1, 30) }),
    );
    expect(health).toEqual({
      status: 'stalled-no-time',
      incompleteCount: 0,
      missingCount: 30,
      preparedAhead: 0,
      runwayLow: true,
    });
  });

  it('stalled-budget-exhausted: el tiempo se agotó sin completar ninguna fecha', () => {
    const health = classifyCatalogHealth(
      report({ budgetExhausted: true, deferred: days(1, 30), stillMissing: days(1, 30) }),
    );
    expect(health.status).toBe('stalled-budget-exhausted');
  });

  it('failed: una fecha falló y las siguientes se omitieron', () => {
    const outcomes: ReplenishOutcome[] = [
      { date: dayOf(1), status: 'failed', error: 'x' },
      { date: dayOf(2), status: 'skipped' },
    ];
    const health = classifyCatalogHealth(report({ outcomes, stillMissing: days(1, 2) }));
    expect(health.status).toBe('failed');
    expect(health.missingCount).toBe(2);
  });

  it('un fallo tiene precedencia aunque antes se hayan creado fechas', () => {
    const outcomes: ReplenishOutcome[] = [
      { date: dayOf(1), status: 'created' },
      { date: dayOf(2), status: 'failed', error: 'x' },
    ];
    const health = classifyCatalogHealth(
      report({ created: [dayOf(1)], outcomes, stillMissing: [dayOf(2)] }),
    );
    expect(health.status).toBe('failed');
    expect(health.preparedAhead).toBe(1);
  });

  it('las fechas incompletas cortan el margen y se cuentan aparte', () => {
    const health = classifyCatalogHealth(report({ incomplete: [dayOf(10)] }));
    expect(health.status).toBe('catalog-complete');
    expect(health.incompleteCount).toBe(1);
    expect(health.preparedAhead).toBe(9);
    expect(health.runwayLow).toBe(false);
  });

  it('runwayLow se activa justo por debajo del umbral', () => {
    const at = classifyCatalogHealth(report({ incomplete: [dayOf(RUNWAY_LOW_DAYS + 1)] }));
    const below = classifyCatalogHealth(report({ incomplete: [dayOf(RUNWAY_LOW_DAYS)] }));
    expect(at.preparedAhead).toBe(RUNWAY_LOW_DAYS);
    expect(at.runwayLow).toBe(false);
    expect(below.preparedAhead).toBe(RUNWAY_LOW_DAYS - 1);
    expect(below.runwayLow).toBe(true);
  });

  it('un hueco lejano no reduce el margen consecutivo del inicio', () => {
    const health = classifyCatalogHealth(report({ stillMissing: [dayOf(30)] }));
    expect(health.preparedAhead).toBe(29);
  });

  it('ventana vacía: sin margen', () => {
    const health = classifyCatalogHealth(report({ from: '', to: '' }));
    expect(health.preparedAhead).toBe(0);
    expect(health.runwayLow).toBe(true);
  });
});
