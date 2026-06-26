import { describe, expect, it } from 'vitest';

import { shareAudience } from './shareAudience.js';

describe('shareAudience', () => {
  it('public collection → public, regardless of household sharing', () => {
    expect(shareAudience({ isPublic: true, takenDown: false, libraryShared: false })).toBe(
      'public',
    );
    expect(shareAudience({ isPublic: true, takenDown: false, libraryShared: true })).toBe('public');
  });

  it('taken-down collection never reads as public', () => {
    expect(shareAudience({ isPublic: true, takenDown: true, libraryShared: false })).toBe(
      'private',
    );
    expect(shareAudience({ isPublic: true, takenDown: true, libraryShared: true })).toBe(
      'household',
    );
  });

  it('household library sharing without public → household', () => {
    expect(shareAudience({ isPublic: false, takenDown: false, libraryShared: true })).toBe(
      'household',
    );
  });

  it('private collection, no sharing → private', () => {
    expect(shareAudience({ isPublic: false, takenDown: false, libraryShared: false })).toBe(
      'private',
    );
  });
});
