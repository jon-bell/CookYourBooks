import { DangerZoneSection } from '../settings/DangerZoneSection.js';
import { OcrStorageSection } from '../settings/OcrStorageSection.js';
import { ProductImprovementSection } from '../settings/ProductImprovementSection.js';
import { SettingsLayout } from '../settings/SettingsTabs.js';

/**
 * Data & deletion settings: the product-improvement opt-out, bulk-delete of
 * OCR source images, and the right-to-erasure account deletion flow — every
 * "what leaves this device / what can I get rid of" control in one place. The
 * two destructive ones stay at the bottom.
 */
export function SettingsDangerPage() {
  return (
    <SettingsLayout>
      <ProductImprovementSection />
      <OcrStorageSection />
      <DangerZoneSection />
    </SettingsLayout>
  );
}
