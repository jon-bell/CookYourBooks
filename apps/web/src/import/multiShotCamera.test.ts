import { afterEach, describe, expect, it } from 'vitest';
import { isMultiShotAvailable } from './multiShotCamera.js';

type GlobalWithCapacitor = typeof globalThis & {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    getPlatform?: () => string;
    isPluginAvailable?: (name: string) => boolean;
  };
};

const g = globalThis as GlobalWithCapacitor;

afterEach(() => {
  delete g.Capacitor;
});

describe('isMultiShotAvailable', () => {
  it('returns false on web (no Capacitor global)', () => {
    expect(isMultiShotAvailable()).toBe(false);
  });

  it('returns false when Capacitor reports web platform', () => {
    g.Capacitor = {
      isNativePlatform: () => false,
      getPlatform: () => 'web',
      isPluginAvailable: () => false,
    };
    expect(isMultiShotAvailable()).toBe(false);
  });

  it('returns true on iOS native with Camera plugin available', () => {
    g.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      isPluginAvailable: (name) => name === 'Camera',
    };
    expect(isMultiShotAvailable()).toBe(true);
  });

  it('returns true on Android native with Camera plugin available', () => {
    g.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      isPluginAvailable: () => true,
    };
    expect(isMultiShotAvailable()).toBe(true);
  });

  it('returns false on a Capacitor native platform that is not ios/android', () => {
    g.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'electron',
      isPluginAvailable: () => true,
    };
    expect(isMultiShotAvailable()).toBe(false);
  });

  it('returns false when Camera plugin is not registered', () => {
    g.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      isPluginAvailable: () => false,
    };
    expect(isMultiShotAvailable()).toBe(false);
  });
});
