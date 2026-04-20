import { conversionRule, type ConversionRule } from './rules.js';

// Standard unit-to-unit conversions, ingredient-agnostic.
// Factor is multiplicative: fromValue * factor = toValue.
export const StandardConversions: readonly ConversionRule[] = [
  // Volume — metric
  conversionRule({ fromUnit: 'liter', toUnit: 'milliliter', factor: 1000, priority: 'STANDARD' }),
  conversionRule({ fromUnit: 'milliliter', toUnit: 'liter', factor: 0.001, priority: 'STANDARD' }),
  // Volume — US
  conversionRule({ fromUnit: 'tablespoon', toUnit: 'teaspoon', factor: 3, priority: 'STANDARD' }),
  conversionRule({ fromUnit: 'teaspoon', toUnit: 'tablespoon', factor: 1 / 3, priority: 'STANDARD' }),
  conversionRule({ fromUnit: 'cup', toUnit: 'tablespoon', factor: 16, priority: 'STANDARD' }),
  conversionRule({ fromUnit: 'tablespoon', toUnit: 'cup', factor: 1 / 16, priority: 'STANDARD' }),
  conversionRule({ fromUnit: 'cup', toUnit: 'fluid ounce', factor: 8, priority: 'STANDARD' }),
  conversionRule({ fromUnit: 'fluid ounce', toUnit: 'cup', factor: 1 / 8, priority: 'STANDARD' }),
  conversionRule({ fromUnit: 'pint', toUnit: 'cup', factor: 2, priority: 'STANDARD' }),
  conversionRule({ fromUnit: 'quart', toUnit: 'pint', factor: 2, priority: 'STANDARD' }),
  conversionRule({ fromUnit: 'gallon', toUnit: 'quart', factor: 4, priority: 'STANDARD' }),
  // Volume — cross-system (approximate)
  conversionRule({ fromUnit: 'cup', toUnit: 'milliliter', factor: 236.588, priority: 'STANDARD' }),
  conversionRule({ fromUnit: 'tablespoon', toUnit: 'milliliter', factor: 14.787, priority: 'STANDARD' }),
  conversionRule({ fromUnit: 'teaspoon', toUnit: 'milliliter', factor: 4.929, priority: 'STANDARD' }),
  // Weight — metric
  conversionRule({ fromUnit: 'kilogram', toUnit: 'gram', factor: 1000, priority: 'STANDARD' }),
  conversionRule({ fromUnit: 'gram', toUnit: 'kilogram', factor: 0.001, priority: 'STANDARD' }),
  // Weight — imperial
  conversionRule({ fromUnit: 'pound', toUnit: 'ounce', factor: 16, priority: 'STANDARD' }),
  conversionRule({ fromUnit: 'ounce', toUnit: 'pound', factor: 1 / 16, priority: 'STANDARD' }),
  // Weight — cross-system
  conversionRule({ fromUnit: 'ounce', toUnit: 'gram', factor: 28.3495, priority: 'STANDARD' }),
  conversionRule({ fromUnit: 'pound', toUnit: 'gram', factor: 453.592, priority: 'STANDARD' }),
  conversionRule({ fromUnit: 'gram', toUnit: 'ounce', factor: 1 / 28.3495, priority: 'STANDARD' }),
];
