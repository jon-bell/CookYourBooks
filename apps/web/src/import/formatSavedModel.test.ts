import { describe, expect, it } from 'vitest';

import { formatSavedModel } from './savedModelFormat.js';

describe('formatSavedModel', () => {
  it('labels gemini models by provider (single endpoint)', () => {
    expect(
      formatSavedModel({ provider: 'gemini', endpoint: 'default', model: 'gemini-3.5-flash' }),
    ).toBe('gemini · gemini-3.5-flash');
  });

  it('labels OpenAI-compatible models by their endpoint slug', () => {
    expect(
      formatSavedModel({
        provider: 'openai-compatible',
        endpoint: 'openrouter',
        model: 'qwen3-vl',
      }),
    ).toBe('openrouter · qwen3-vl');
    expect(
      formatSavedModel({ provider: 'openai-compatible', endpoint: 'default', model: 'gpt-5.4' }),
    ).toBe('default · gpt-5.4');
  });

  it('prefers a user-supplied label', () => {
    expect(
      formatSavedModel({
        provider: 'openai-compatible',
        endpoint: 'openrouter',
        model: 'qwen3-vl',
        label: 'Qwen (cheap)',
      }),
    ).toBe('Qwen (cheap)');
    expect(
      formatSavedModel({
        provider: 'gemini',
        endpoint: 'default',
        model: 'gemini-3.5-flash',
        label: '   ',
      }),
    ).toBe('gemini · gemini-3.5-flash');
  });
});
