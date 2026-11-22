import { describe, expect, it } from 'vitest';
import {
  createTimeBudget,
  SELECTION_SAFETY_MARGIN_MS,
  TimeBudgetExhaustedError,
} from '../../src/shared/time-budget.ts';

function setup(deadlineMs = 100_000, reserveMs = 20_000) {
  let clock = 0;
  const budget = createTimeBudget({ deadlineMs, reserveMs, now: () => clock });
  return { budget, advance: (ms: number) => (clock += ms) };
}

describe('createTimeBudget', () => {
  it('remainingMs cuenta hasta el límite duro, sin descontar la reserva', () => {
    const { budget, advance } = setup();
    expect(budget.remainingMs()).toBe(100_000);
    advance(30_000);
    expect(budget.remainingMs()).toBe(70_000);
  });

  it('ensure acepta lo que entra justo antes de la reserva', () => {
    const { budget } = setup();
    expect(() => budget.ensure(80_000, 'op')).not.toThrow();
  });

  it('ensure rechaza lo que invade la reserva', () => {
    const { budget } = setup();
    expect(() => budget.ensure(80_001, 'op')).toThrow(TimeBudgetExhaustedError);
  });

  it('useReserve: false permite usar la reserva pero no pasar el límite', () => {
    const { budget, advance } = setup();
    advance(85_000);
    expect(() => budget.ensure(0, 'op')).toThrow(TimeBudgetExhaustedError);
    expect(() => budget.ensure(15_000, 'persist', { useReserve: false })).not.toThrow();
    expect(() => budget.ensure(15_001, 'persist', { useReserve: false })).toThrow(
      TimeBudgetExhaustedError,
    );
  });

  it('con el reloj pasado del límite ensure(0) también falla', () => {
    const { budget, advance } = setup(10_000, 0);
    advance(10_001);
    expect(() => budget.ensure(0, 'op')).toThrow(TimeBudgetExhaustedError);
  });

  it('el error lleva nombre, operación y milisegundos, nada más', () => {
    const { budget } = setup(1_000, 0);
    let caught: unknown;
    try {
      budget.ensure(5_000, 'OpenAI proposal');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TimeBudgetExhaustedError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('TimeBudgetExhaustedError');
    expect((caught as Error).message).toBe(
      'Time budget exhausted before OpenAI proposal: needs 5000 ms, 1000 ms available',
    );
  });

  it('el margen de seguridad es de 20 s', () => {
    expect(SELECTION_SAFETY_MARGIN_MS).toBe(20_000);
  });
});
