import { describe, expect, it } from 'vitest';
import { isSettingsTabActive } from './SettingsTabs.js';

describe('isSettingsTabActive', () => {
  it('is active only on an exact path match', () => {
    expect(isSettingsTabActive('/settings/llm', '/settings/llm')).toBe(true);
    expect(isSettingsTabActive('/settings/cli', '/settings/llm')).toBe(false);
    expect(isSettingsTabActive('/settings/conversions', '/settings/conversions')).toBe(true);
    expect(isSettingsTabActive('/settings/danger', '/settings/conversions')).toBe(false);
  });

  it('does not light any tab on the bare /settings redirect path', () => {
    // /settings redirects to /settings/llm; a tab only matches its own exact
    // path, so nothing is "active" during the redirect frame.
    expect(isSettingsTabActive('/settings', '/settings/llm')).toBe(false);
  });

  it('ignores deeper sub-paths (the tabs are flat siblings)', () => {
    expect(isSettingsTabActive('/settings/llm/extra', '/settings/llm')).toBe(false);
  });
});
