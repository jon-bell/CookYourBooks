export interface ExactQuantity {
  readonly type: 'EXACT';
  readonly amount: number;
  readonly unit: string;
}

export interface FractionalQuantity {
  readonly type: 'FRACTIONAL';
  readonly whole: number;
  readonly numerator: number;
  readonly denominator: number;
  readonly unit: string;
}

export interface RangeQuantity {
  readonly type: 'RANGE';
  readonly min: number;
  readonly max: number;
  readonly unit: string;
}

export type Quantity = ExactQuantity | FractionalQuantity | RangeQuantity;

export function exact(amount: number, unit: string): ExactQuantity {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid exact amount: ${amount}`);
  }
  return { type: 'EXACT', amount, unit };
}

export function fractional(
  whole: number,
  numerator: number,
  denominator: number,
  unit: string,
): FractionalQuantity {
  if (whole < 0 || numerator < 0) throw new Error('Negative components not allowed');
  if (denominator <= 0) throw new Error('Denominator must be positive');
  if (numerator >= denominator && whole === 0 && numerator === 0) {
    // allow 0 0/1 = 0
  } else if (numerator >= denominator) {
    throw new Error(`Numerator ${numerator} must be < denominator ${denominator}`);
  }
  return { type: 'FRACTIONAL', whole, numerator, denominator, unit };
}

export function range(min: number, max: number, unit: string): RangeQuantity {
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('Non-finite range bounds');
  if (min < 0 || max < 0) throw new Error('Negative bounds not allowed');
  if (min > max) throw new Error(`Range min ${min} > max ${max}`);
  return { type: 'RANGE', min, max, unit };
}

export function quantityToNumber(q: Quantity): number {
  switch (q.type) {
    case 'EXACT':
      return q.amount;
    case 'FRACTIONAL':
      return q.whole + q.numerator / q.denominator;
    case 'RANGE':
      return (q.min + q.max) / 2;
  }
}

export function getUnit(q: Quantity): string {
  return q.unit;
}

export function scaleQuantity(q: Quantity, factor: number): Quantity {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`Invalid scale factor: ${factor}`);
  }
  switch (q.type) {
    case 'EXACT':
      return exact(q.amount * factor, q.unit);
    case 'FRACTIONAL': {
      const total = (q.whole + q.numerator / q.denominator) * factor;
      return exact(total, q.unit);
    }
    case 'RANGE':
      return range(q.min * factor, q.max * factor, q.unit);
  }
}

export function formatQuantity(q: Quantity): string {
  switch (q.type) {
    case 'EXACT':
      return `${formatNumber(q.amount)} ${q.unit}`.trim();
    case 'FRACTIONAL': {
      const parts: string[] = [];
      if (q.whole > 0) parts.push(String(q.whole));
      if (q.numerator > 0) parts.push(`${q.numerator}/${q.denominator}`);
      if (parts.length === 0) parts.push('0');
      return `${parts.join(' ')} ${q.unit}`.trim();
    }
    case 'RANGE':
      return `${formatNumber(q.min)}–${formatNumber(q.max)} ${q.unit}`.trim();
  }
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, '');
}
