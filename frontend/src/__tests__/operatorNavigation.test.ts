import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, NAV_ITEMS, detectGroup } from '../utils/operatorNavigation';

describe('operator navigation model', () => {
  it('separates operator, builder, and admin surfaces', () => {
    expect(NAV_GROUPS.map(group => group.id)).toEqual(['operator', 'builder', 'admin']);
    expect(NAV_GROUPS.find(group => group.id === 'operator')?.pages).toEqual([
      '/my-tasks',
      '/monitor',
      '/cases',
      '/people',
      '/roles',
      '/documents',
    ]);
    expect(NAV_GROUPS.find(group => group.id === 'builder')?.pages).toContain('/editor');
    expect(NAV_GROUPS.find(group => group.id === 'admin')?.pages).toEqual(expect.arrayContaining([
      '/health',
      '/agents',
      '/messages',
      '/eventlog',
      '/event-monitor',
    ]));
  });

  it('has labels for every routed navigation page', () => {
    for (const group of NAV_GROUPS) {
      expect(group.labelKey).toMatch(/^nav\./);
      expect(group.fallback.length).toBeGreaterThan(0);
      for (const page of group.pages) {
        expect(NAV_ITEMS[page]).toBeDefined();
        expect(NAV_ITEMS[page].labelKey).toMatch(/^nav\./);
        expect(NAV_ITEMS[page].fallback.length).toBeGreaterThan(0);
      }
    }
  });

  it('routes known pages to their UX layer', () => {
    expect(detectGroup('/my-tasks')).toBe('operator');
    expect(detectGroup('/cases/active')).toBe('operator');
    expect(detectGroup('/editor/lead-qualification')).toBe('builder');
    expect(detectGroup('/messages')).toBe('admin');
  });

  it('defaults unknown pages to the operator surface', () => {
    expect(detectGroup('/')).toBe('operator');
    expect(detectGroup('/unknown')).toBe('operator');
  });
});
