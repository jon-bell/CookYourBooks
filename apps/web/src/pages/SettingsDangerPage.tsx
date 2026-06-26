import { DangerZoneSection } from '../settings/DangerZoneSection.js';
import { OcrStorageSection } from '../settings/OcrStorageSection.js';
import { SettingsLayout } from '../settings/SettingsTabs.js';

/**
 * Data & deletion settings: bulk-delete OCR source images, and the
 * right-to-erasure account deletion flow. Both are destructive, so they live
 * together away from the everyday settings.
 */
export function SettingsDangerPage() {
  return (
    <SettingsLayout>
      <OcrStorageSection />
      <DangerZoneSection />
    </SettingsLayout>
  );
}
