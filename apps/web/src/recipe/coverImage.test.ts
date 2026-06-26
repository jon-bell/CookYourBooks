import { describe, expect, it } from 'vitest';

import { coverObjectKey } from './coverImage.js';

// prepareCoverImage relies on canvas / createImageBitmap, which the Node test
// environment lacks — it's exercised manually + in e2e. The content-addressing
// (coverObjectKey) is pure crypto and is the part worth pinning here.
describe('coverObjectKey', () => {
  const bytes = new TextEncoder().encode('cover-bytes').buffer;

  it('builds a content-addressed key under the prefix', async () => {
    const key = await coverObjectKey('u1/recipes', 'r1', bytes, 'webp');
    expect(key).toMatch(/^u1\/recipes\/r1-[0-9a-f]{8}\.webp$/);
  });

  it('is deterministic for the same bytes and changes with them', async () => {
    const a = await coverObjectKey('u1/recipes', 'r1', bytes, 'webp');
    const b = await coverObjectKey('u1/recipes', 'r1', bytes, 'webp');
    const c = await coverObjectKey('u1/recipes', 'r1', new Uint8Array([1, 2, 3]).buffer, 'webp');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
