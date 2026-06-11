import { CliTokensSection } from '../settings/CliTokensSection.js';
import { SettingsLayout } from '../settings/SettingsTabs.js';

/**
 * CLI settings: personal access tokens for the `cyb` command-line tool.
 */
export function SettingsCliPage() {
  return (
    <SettingsLayout>
      <CliTokensSection />
    </SettingsLayout>
  );
}
