export type ConversionRulePriority = 'HOUSE' | 'RECIPE' | 'STANDARD';

export interface ConversionRule {
  readonly fromUnit: string;
  readonly toUnit: string;
  readonly factor: number; // value_in_to = value_in_from * factor
  readonly ingredientName?: string; // null/undefined = generic
  readonly priority: ConversionRulePriority;
}

export function conversionRule(params: {
  fromUnit: string;
  toUnit: string;
  factor: number;
  ingredientName?: string;
  priority: ConversionRulePriority;
}): ConversionRule {
  if (!Number.isFinite(params.factor) || params.factor <= 0) {
    throw new Error(`Invalid conversion factor: ${params.factor}`);
  }
  return {
    fromUnit: params.fromUnit,
    toUnit: params.toUnit,
    factor: params.factor,
    ingredientName: params.ingredientName,
    priority: params.priority,
  };
}
