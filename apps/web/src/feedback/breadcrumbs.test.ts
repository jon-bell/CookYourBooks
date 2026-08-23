import { beforeEach, describe, expect, it } from 'vitest';

import { clearBreadcrumbs, getBreadcrumbs, track, trackRoute } from './breadcrumbs.js';

describe('breadcrumbs', () => {
  beforeEach(() => {
    clearBreadcrumbs();
  });

  it('records routes and events in order', () => {
    trackRoute('/library');
    track('search', { q: 'salad' });
    trackRoute('/search?q=salad');

    const crumbs = getBreadcrumbs();
    expect(crumbs.map((c) => c.kind)).toEqual(['route', 'event', 'route']);
    expect(crumbs.map((c) => c.label)).toEqual(['/library', 'search', '/search?q=salad']);
    expect(crumbs[1]?.data).toEqual({ q: 'salad' });
  });

  it('collapses a repeated route so a re-render storm cannot flood the trail', () => {
    trackRoute('/library');
    trackRoute('/library');
    trackRoute('/library');
    expect(getBreadcrumbs()).toHaveLength(1);

    // A different route in between means the repeat is real navigation.
    trackRoute('/search');
    trackRoute('/library');
    expect(getBreadcrumbs()).toHaveLength(3);
  });

  it('caps the buffer, keeping the most recent entries', () => {
    for (let i = 0; i < 250; i += 1) track(`event-${i}`);
    const crumbs = getBreadcrumbs();
    expect(crumbs).toHaveLength(100);
    expect(crumbs[0]?.label).toBe('event-150');
    expect(crumbs[crumbs.length - 1]?.label).toBe('event-249');
  });

  it('normalizes whitespace and truncates long labels', () => {
    track(`  spaced\n\tout  ${'x'.repeat(200)}`);
    const label = getBreadcrumbs()[0]?.label ?? '';
    expect(label.startsWith('spaced out ')).toBe(true);
    expect(label.length).toBe(80);
  });

  it('ignores blank labels', () => {
    track('   ');
    expect(getBreadcrumbs()).toHaveLength(0);
  });

  it('returns a copy, so callers cannot mutate the buffer', () => {
    track('one');
    const crumbs = getBreadcrumbs() as unknown as { label: string }[];
    crumbs.push({ label: 'injected' });
    expect(getBreadcrumbs()).toHaveLength(1);
  });
});
