import { describe, expect, it } from 'vitest';
import { createCollectionNote } from '../src/model/collectionNote.js';

describe('createCollectionNote', () => {
  it('mints an id, defaults the title to "Note", and defaults sortOrder', () => {
    const n = createCollectionNote({ collectionId: 'col-1', body: 'Some prose.' });
    expect(n.id).toMatch(/[0-9a-f-]{36}/);
    expect(n.title).toBe('Note');
    expect(n.body).toBe('Some prose.');
    expect(n.sortOrder).toBe(0);
    expect(n.collectionId).toBe('col-1');
  });

  it('honors explicit id / title / sortOrder', () => {
    const n = createCollectionNote({
      id: 'fixed',
      collectionId: 'col-1',
      title: '  Foreword  ',
      body: 'b',
      sortOrder: 3,
    });
    expect(n.id).toBe('fixed');
    expect(n.title).toBe('Foreword');
    expect(n.sortOrder).toBe(3);
  });

  it('allows a null collectionId (unfiled note)', () => {
    const n = createCollectionNote({ collectionId: null, body: 'b' });
    expect(n.collectionId).toBeNull();
  });

  it('defensively copies pageNumbers', () => {
    const src = [1, 2];
    const n = createCollectionNote({ collectionId: null, body: 'b', pageNumbers: src });
    expect(n.pageNumbers).toEqual([1, 2]);
    expect(n.pageNumbers).not.toBe(src);
  });
});
