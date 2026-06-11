import { CoverSettingsSection } from '../settings/CoverSettingsSection.js';
import { FallbackModelSection } from '../settings/FallbackModelSection.js';
import { OcrKeysSection } from '../settings/OcrKeysSection.js';
import { OcrModelPromptSection } from '../settings/OcrModelPromptSection.js';
import { RemixSettingsSection } from '../settings/RemixSettingsSection.js';
import { RewriteSettingsSection } from '../settings/RewriteSettingsSection.js';
import { SettingsLayout } from '../settings/SettingsTabs.js';

/**
 * LLM & models settings: provider keys, the default import model + prompt, and
 * the per-feature LLM configs (rewrite, remix, covers). Keys live in Supabase
 * Vault and never reach the browser bundle; everything else is stored
 * server-side in `user_*_prefs`.
 */
export function SettingsLlmPage() {
  return (
    <SettingsLayout>
      <p className="text-sm text-stone-600 dark:text-stone-400">
        Provider keys, the default model + prompt the bulk import flow uses, and the rewrite, remix,
        and cover-image features. All values are stored server-side; the keys live in Supabase Vault
        and never leave the worker.
      </p>
      <OcrKeysSection />
      <FallbackModelSection />
      <OcrModelPromptSection />
      <RewriteSettingsSection />
      <RemixSettingsSection />
      <CoverSettingsSection />
    </SettingsLayout>
  );
}
