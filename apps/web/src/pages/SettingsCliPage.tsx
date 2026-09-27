import { useState } from 'react';

import { CliSetupSection } from '../settings/CliSetupSection.js';
import { CliTokensSection } from '../settings/CliTokensSection.js';
import { SettingsLayout } from '../settings/SettingsTabs.js';

/**
 * CLI settings: personal access tokens for the `cyb` command-line tool, and
 * copy-paste setup instructions (a just-created token flows into the login
 * command).
 */
export function SettingsCliPage() {
  const [token, setToken] = useState<string | undefined>();
  return (
    <SettingsLayout>
      <div className="space-y-6">
        <CliTokensSection onIssued={setToken} />
        <CliSetupSection token={token} />
      </div>
    </SettingsLayout>
  );
}
