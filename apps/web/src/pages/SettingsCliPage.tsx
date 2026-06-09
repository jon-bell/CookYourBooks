import { SettingsLayout } from '../settings/SettingsTabs.js';
import { CliTokensSection } from '../settings/CliTokensSection.js';

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
