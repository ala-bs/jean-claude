import { describe, expect, it } from 'vitest';

import { structurallyShare } from './structural-sharing';

describe('structurallyShare', () => {
  it('reuses an equal plain object tree', () => {
    const previous = {
      items: [{ id: 'item-1', tags: ['one', 'two'] }],
      optional: undefined,
    };
    const next = {
      items: [{ id: 'item-1', tags: ['one', 'two'] }],
      optional: undefined,
    };

    const result = structurallyShare(previous, next);

    expect(result).toBe(previous);
    expect(result.items).toBe(previous.items);
    expect(result.items[0]).toBe(previous.items[0]);
    expect(result.items[0].tags).toBe(previous.items[0].tags);
  });

  it('replaces changed ancestry while preserving equal siblings', () => {
    const previous = {
      changed: { value: 1 },
      unchanged: { value: 2 },
    };
    const next = {
      changed: { value: 3 },
      unchanged: { value: 2 },
    };

    const result = structurallyShare(previous, next);

    expect(result).not.toBe(previous);
    expect(result.changed).not.toBe(previous.changed);
    expect(result.changed).not.toBe(next.changed);
    expect(result.unchanged).toBe(previous.unchanged);
    expect(previous.changed.value).toBe(1);
    expect(next.changed.value).toBe(3);
  });

  it('compares array elements by position', () => {
    const previous = [{ id: 'one' }, { id: 'two' }];
    const next = [{ id: 'two' }, { id: 'one' }];

    const result = structurallyShare(previous, next);

    expect(result).not.toBe(previous);
    expect(result[0]).not.toBe(previous[1]);
    expect(result[1]).not.toBe(previous[0]);
  });

  it('uses Object.is semantics for nested primitives', () => {
    const previous = { nan: Number.NaN, zero: -0 };

    const equalResult = structurallyShare(previous, {
      nan: Number.NaN,
      zero: -0,
    });
    const changedResult = structurallyShare(previous, {
      nan: Number.NaN,
      zero: 0,
    });

    expect(equalResult).toBe(previous);
    expect(changedResult).not.toBe(previous);
    expect(Object.is(changedResult.zero, 0)).toBe(true);
  });

  it('distinguishes missing keys from keys set to undefined', () => {
    const previous: { value?: undefined } = { value: undefined };
    const next: { value?: undefined } = {};

    const result = structurallyShare(previous, next);

    expect(result).not.toBe(previous);
    expect(Object.hasOwn(result, 'value')).toBe(false);
  });

  it('reuses Dates with equal timestamps', () => {
    const previous = { updatedAt: new Date('2026-01-01T00:00:00.000Z') };
    const next = { updatedAt: new Date('2026-01-01T00:00:00.000Z') };

    const result = structurallyShare(previous, next);

    expect(result).toBe(previous);
    expect(result.updatedAt).toBe(previous.updatedAt);
  });

  it('uses incoming Dates when timestamps differ', () => {
    const previous = { updatedAt: new Date('2026-01-01T00:00:00.000Z') };
    const next = { updatedAt: new Date('2026-01-02T00:00:00.000Z') };

    const result = structurallyShare(previous, next);

    expect(result.updatedAt).toBe(next.updatedAt);
  });

  it('treats other non-plain values as opaque replacements', () => {
    const previousMap = new Map([['key', 'value']]);
    const nextMap = new Map([['key', 'value']]);

    const result = structurallyShare(
      { lookup: previousMap },
      { lookup: nextMap },
    );

    expect(result.lookup).toBe(nextMap);
  });

  it('treats plain objects with accessors as opaque without invoking getters', () => {
    let getterCalls = 0;
    const previous = { value: 1 };
    const next = {} as { value: number };
    Object.defineProperty(next, 'value', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 1;
      },
    });

    const result = structurallyShare(previous, next);

    expect(result).toBe(next);
    expect(getterCalls).toBe(0);
  });

  it('treats plain objects with symbol properties as opaque', () => {
    const marker = Symbol('marker');
    const previous = { value: 1, [marker]: 'before' };
    const next = { value: 1, [marker]: 'after' };

    const result = structurallyShare(previous, next);

    expect(result).toBe(next);
  });

  it('distinguishes sparse array holes from own values', () => {
    const previous = new Array<string>(1);
    Object.setPrototypeOf(previous, { 0: 'value' });
    const next = ['value'];

    const result = structurallyShare(previous, next);

    expect(result).not.toBe(previous);
    expect(Object.hasOwn(result, 0)).toBe(true);
    expect(result[0]).toBe('value');
  });

  it('treats arrays with custom prototypes as opaque', () => {
    const previous = ['value'];
    const next = ['value'];
    Object.setPrototypeOf(previous, { kind: 'previous' });
    Object.setPrototypeOf(next, { kind: 'next' });

    const result = structurallyShare(previous, next);

    expect(result).toBe(next);
  });
});
