// Shared tactile feedback for the camera shutter. A shutter press is a more
// significant action than the planner's per-tick nudge, so it uses a Medium
// impact (vs. `plannerHapticTick`'s Light). Best-effort: a silent no-op on the
// web / any platform without the Capacitor Haptics plugin.

export async function shutterHaptic(): Promise<void> {
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle.Medium });
  } catch {
    // No haptics engine (web, unsupported device) — ignore.
  }
}
