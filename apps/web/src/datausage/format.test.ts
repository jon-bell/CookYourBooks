import { describe, expect, it } from 'vitest';
import {
  directionLabel,
  formatBytes,
  formatCount,
  formatDuration,
  phaseLabel,
} from './format.js';

describe('formatBytes', () => {
  it('formats whole bytes without decimals', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('scales to KB / MB / GB (binary)', () => {
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.00 GB');
  });

  it('drops decimals for large values within a unit', () => {
    expect(formatBytes(150 * 1024)).toBe('150 KB');
    expect(formatBytes(12 * 1024)).toBe('12.0 KB');
  });

  it('guards nullish and negatives', () => {
    expect(formatBytes(undefined as unknown as number)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
  });
});

describe('formatDuration', () => {
  it('keeps sub-second in ms', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(250)).toBe('250 ms');
    expect(formatDuration(999)).toBe('999 ms');
  });

  it('shows seconds for >= 1s', () => {
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(12_300)).toBe('12.3 s');
  });

  it('shows minutes and seconds for >= 60s', () => {
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });

  it('guards nullish', () => {
    expect(formatDuration(undefined as unknown as number)).toBe('0 ms');
  });
});

describe('formatCount', () => {
  it('thousands-separates', () => {
    expect(formatCount(1234567)).toBe((1234567).toLocaleString());
    expect(formatCount(0)).toBe('0');
  });
});

describe('directionLabel', () => {
  it('maps known directions and passes through unknowns', () => {
    expect(directionLabel('pull')).toBe('Pull (download)');
    expect(directionLabel('push')).toBe('Push (upload)');
    expect(directionLabel('mystery')).toBe('mystery');
  });
});

describe('phaseLabel', () => {
  it('maps known phases and passes through unknowns', () => {
    expect(phaseLabel('recipes')).toBe('Recipes');
    expect(phaseLabel('snapshot_bodies')).toBe('Snapshot bodies');
    expect(phaseLabel('total')).toBe('Total');
    expect(phaseLabel('weird')).toBe('weird');
  });
});
