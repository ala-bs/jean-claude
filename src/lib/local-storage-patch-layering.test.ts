// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installLocalStorageBootGuard,
  resetLocalStorageBootGuardForTests,
} from './local-storage-boot-guard';

/**
 * Pins the install order asserted in `src/main-renderer.tsx`.
 *
 * Both `debug-local-storage` and `local-storage-boot-guard` wrap `setItem` on
 * the `localStorage` instance, each capturing whatever it resolves to at install
 * time — so whichever installs *last* ends up outermost. The entry point relies
 * on diagnostic-then-guard, giving caller -> guard -> diagnostic -> real write,
 * so that a withheld write is withheld before the diagnostic reports it as
 * written.
 *
 * Nothing in the type system or the linter protects that ordering: an import
 * reorder or an autofix would silently invert it and the guard would stop
 * guarding while still claiming to. Hence a test.
 */
describe('localStorage patch layering', () => {
  beforeEach(() => {
    resetLocalStorageBootGuardForTests();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps the guard outside the diagnostic when installed in entry-point order', () => {
    const diagnosticCalls: string[] = [];

    // Stand-in for `debug-local-storage`, which installs by assignment and, in
    // the real module, logs/measures before delegating to the real write.
    const realSetItem = window.localStorage.setItem.bind(window.localStorage);
    Object.defineProperty(window.localStorage, 'setItem', {
      value: (key: string, value: string) => {
        diagnosticCalls.push(key);
        realSetItem(key, value);
      },
      configurable: true,
      writable: true,
    });

    // Guard installs second, so it wraps the diagnostic.
    installLocalStorageBootGuard();

    window.localStorage.setItem('ui-store', '{"a":1}');

    // Outermost wins: the write never reaches the diagnostic, and never lands.
    expect(diagnosticCalls).toEqual([]);
    expect(window.localStorage.getItem('ui-store')).toBeNull();
  });

  it('routes replayed writes back through the diagnostic', () => {
    const diagnosticCalls: string[] = [];
    const realSetItem = window.localStorage.setItem.bind(window.localStorage);
    Object.defineProperty(window.localStorage, 'setItem', {
      value: (key: string, value: string) => {
        diagnosticCalls.push(key);
        realSetItem(key, value);
      },
      configurable: true,
      writable: true,
    });

    installLocalStorageBootGuard();
    window.localStorage.setItem('ui-store', '{"a":1}');

    // Replay must not bypass the layer below, or the diagnostic would go blind
    // to every write made before the guard resolved.
    void import('./local-storage-boot-guard').then((m) =>
      m.resolveLocalStorageBootGuard({ hadPriorData: false }),
    );

    return vi.waitFor(() => {
      expect(diagnosticCalls).toEqual(['ui-store']);
      expect(window.localStorage.getItem('ui-store')).toBe('{"a":1}');
    });
  });
});
