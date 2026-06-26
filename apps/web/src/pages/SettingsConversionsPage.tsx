import { ConversionsSection } from '../settings/ConversionsSection.js';
import { SettingsLayout } from '../settings/SettingsTabs.js';

/**
 * Conversions settings: the user's personal (HOUSE) unit-conversion rules,
 * which layer over the app's global defaults and apply across all recipes.
 */
export function SettingsConversionsPage() {
  return (
    <SettingsLayout>
      <ConversionsSection />
    </SettingsLayout>
  );
}
