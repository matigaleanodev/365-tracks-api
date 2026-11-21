/**
 * Margen reservado al final de la invocación para que una selección ya terminada pueda validarse
 * y persistirse: escritura condicional transaccional en DynamoDB (con reintentos del SDK),
 * relectura del ganador si hubo conflicto y log final. Ninguna llamada externa de selección
 * (OpenAI, Spotify) puede empezar si no termina antes de este margen.
 */
export const SELECTION_SAFETY_MARGIN_MS = 20_000;

/**
 * El presupuesto de tiempo no alcanza para la operación pedida. El mensaje solo lleva la
 * descripción de la operación y milisegundos: nunca títulos, artistas ni consultas.
 */
export class TimeBudgetExhaustedError extends Error {
  readonly operation: string;

  constructor(operation: string, neededMs: number, availableMs: number) {
    super(
      `Time budget exhausted before ${operation}: needs ${Math.ceil(neededMs)} ms, ${Math.max(0, Math.floor(availableMs))} ms available`,
    );
    this.name = 'TimeBudgetExhaustedError';
    this.operation = operation;
  }
}

export interface TimeBudget {
  /** Milisegundos hasta el límite duro (sin descontar la reserva). */
  remainingMs(): number;
  /**
   * Lanza `TimeBudgetExhaustedError` si una operación de `operationMs` que empieza ahora no
   * termina antes del límite menos la reserva (o del límite, con `useReserve: false`).
   */
  ensure(operationMs: number, description: string, options?: { useReserve?: boolean }): void;
}

export interface TimeBudgetOptions {
  /** Instante absoluto (ms desde epoch según `now`) en que vence la invocación. */
  deadlineMs: number;
  /** Margen que las operaciones normales no pueden consumir. */
  reserveMs: number;
  now?: () => number;
}

export function createTimeBudget({
  deadlineMs,
  reserveMs,
  now = Date.now,
}: TimeBudgetOptions): TimeBudget {
  return {
    remainingMs: () => deadlineMs - now(),
    ensure(operationMs, description, { useReserve = true } = {}) {
      const available = deadlineMs - (useReserve ? reserveMs : 0) - now();
      if (operationMs > available) {
        throw new TimeBudgetExhaustedError(description, operationMs, available);
      }
    },
  };
}
