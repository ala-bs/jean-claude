// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getLocalStorageBootGuardState,
  installLocalStorageBootGuard,
  resetLocalStorageBootGuardForTests,
  resolveLocalStorageBootGuard,
  subscribeLocalStorageBootGuard,
} from './local-storage-boot-guard';

/**
 * The guard patches the real `localStorage`, so each case starts from a clean
 * bucket and an unpatched `setItem`.
 */
beforeEach(() => {
  window.localStorage.clear();
  resetLocalStorageBootGuardForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  window.localStorage.clear();
  resetLocalStorageBootGuardForTests();
  vi.restoreAllMocks();
});

describe('localStorage boot guard', () => {
  it('stays out of the way entirely when the bucket read fine', () => {
    window.localStorage.setItem('ui-store', '{"seeded":true}');

    installLocalStorageBootGuard();

    expect(getLocalStorageBootGuardState()).toBe('pass-through');
    // The common path must keep its exact current behaviour: writes land
    // immediately, with nothing withheld.
    window.localStorage.setItem('jean-claude-feed-overrides', '{"pinned":[1]}');
    expect(window.localStorage.getItem('jean-claude-feed-overrides')).toBe(
      '{"pinned":[1]}',
    );
  });

  it('withholds writes while an empty bucket is still unexplained', () => {
    installLocalStorageBootGuard();

    expect(getLocalStorageBootGuardState()).toBe('suspect');

    window.localStorage.setItem('jean-claude-feed-overrides', '{"pinned":[]}');

    expect(window.localStorage.getItem('jean-claude-feed-overrides')).toBeNull();
  });

  it('replays withheld writes once a genuine first run is confirmed', () => {
    installLocalStorageBootGuard();

    window.localStorage.setItem('ui-store', '{"a":1}');
    window.localStorage.setItem('navigation', '{"b":2}');

    resolveLocalStorageBootGuard({ hadPriorData: false });

    expect(getLocalStorageBootGuardState()).toBe('pass-through');
    expect(window.localStorage.getItem('ui-store')).toBe('{"a":1}');
    expect(window.localStorage.getItem('navigation')).toBe('{"b":2}');

    // And subsequent writes go straight through.
    window.localStorage.setItem('onboarding-store', '{"c":3}');
    expect(window.localStorage.getItem('onboarding-store')).toBe('{"c":3}');
  });

  it('keeps only the newest value per key so a hot writer cannot grow the queue', () => {
    installLocalStorageBootGuard();

    window.localStorage.setItem('ui-store', '{"n":1}');
    window.localStorage.setItem('ui-store', '{"n":2}');
    window.localStorage.setItem('ui-store', '{"n":3}');

    resolveLocalStorageBootGuard({ hadPriorData: false });

    expect(window.localStorage.getItem('ui-store')).toBe('{"n":3}');
  });

  /** The whole point: a failed read must not become an overwrite. */
  it('blocks writes permanently when prior data proves the read failed', () => {
    installLocalStorageBootGuard();

    window.localStorage.setItem('jean-claude-feed-overrides', '{"pinned":[]}');

    resolveLocalStorageBootGuard({ hadPriorData: true });

    expect(getLocalStorageBootGuardState()).toBe('blocked');
    // Neither the withheld write nor any later one may land.
    expect(window.localStorage.getItem('jean-claude-feed-overrides')).toBeNull();

    window.localStorage.setItem('ui-store', '{"defaults":true}');
    expect(window.localStorage.getItem('ui-store')).toBeNull();
  });

  it('ignores a later resolve once blocked', () => {
    installLocalStorageBootGuard();
    resolveLocalStorageBootGuard({ hadPriorData: true });
    resolveLocalStorageBootGuard({ hadPriorData: false });

    expect(getLocalStorageBootGuardState()).toBe('blocked');
    window.localStorage.setItem('ui-store', '{"defaults":true}');
    expect(window.localStorage.getItem('ui-store')).toBeNull();
  });

  it('notifies subscribers when it blocks', () => {
    installLocalStorageBootGuard();
    const listener = vi.fn();
    subscribeLocalStorageBootGuard(listener);

    resolveLocalStorageBootGuard({ hadPriorData: true });

    expect(listener).toHaveBeenCalledWith('blocked');
  });

  /**
   * `main-renderer.tsx` and `__root.tsx` both call
   * `removeItem('react-scan-options')` unconditionally at boot, so a guard that
   * only covered `setItem` would still let a destructive call reach a bucket it
   * claims to be protecting.
   */
  it('withholds removals too, so nothing destructive reaches the bucket', () => {
    installLocalStorageBootGuard();
    resolveLocalStorageBootGuard({ hadPriorData: true });

    // Must not throw, and must not reach the real bucket.
    window.localStorage.removeItem('react-scan-options');
    window.localStorage.clear();

    expect(getLocalStorageBootGuardState()).toBe('blocked');
  });

  it('replays a withheld removal before the writes that follow it', () => {
    installLocalStorageBootGuard();

    window.localStorage.setItem('ui-store', '{"a":1}');
    window.localStorage.removeItem('ui-store');
    window.localStorage.setItem('ui-store', '{"a":2}');

    resolveLocalStorageBootGuard({ hadPriorData: false });

    // The final write wins; the removal does not erase it.
    expect(window.localStorage.getItem('ui-store')).toBe('{"a":2}');
  });

  it('applies a withheld removal that was not followed by a write', () => {
    installLocalStorageBootGuard();

    window.localStorage.setItem('ui-store', '{"a":1}');
    window.localStorage.removeItem('ui-store');

    resolveLocalStorageBootGuard({ hadPriorData: false });

    expect(window.localStorage.getItem('ui-store')).toBeNull();
  });

  it('holds writes indefinitely when the check never resolves', () => {
    installLocalStorageBootGuard();

    window.localStorage.setItem('ui-store', '{"defaults":true}');

    // Fail-closed: not persisting is recoverable next launch, overwriting is not.
    expect(getLocalStorageBootGuardState()).toBe('suspect');
    expect(window.localStorage.getItem('ui-store')).toBeNull();
  });
});
