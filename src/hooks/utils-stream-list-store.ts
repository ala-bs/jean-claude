import { useSyncExternalStore } from 'react';

export type StreamListStore<TItem> = {
  get: () => readonly TItem[];
  append: (items: TItem[], maxItems: number) => void;
  clear: () => void;
  subscribe: (listener: () => void) => () => void;
};

const EMPTY_ITEMS: readonly unknown[] = [];

/**
 * Append-only buffer for high-frequency stream data (device logs, network
 * requests). Data lives outside React so only the components that actually
 * render the list re-render when new items arrive.
 */
export function createStreamListStore<TItem>(): StreamListStore<TItem> {
  let items = EMPTY_ITEMS as readonly TItem[];
  const listeners = new Set<() => void>();

  const emit = () => {
    listeners.forEach((listener) => {
      listener();
    });
  };

  return {
    get: () => items,
    append: (nextItems, maxItems) => {
      if (nextItems.length === 0) return;
      items = [...items, ...nextItems].slice(-maxItems);
      emit();
    },
    clear: () => {
      if (items.length === 0) return;
      items = EMPTY_ITEMS as readonly TItem[];
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useStreamListStore<TItem>(
  store: StreamListStore<TItem>,
): readonly TItem[] {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

const noopSubscribe = () => () => undefined;


/**
 * Same as `useStreamListStore`, but only subscribes while `enabled`. Used by
 * hidden tabs so their stream traffic cannot re-render the parent.
 */
export function useStreamListStoreWhen<TItem>(
  store: StreamListStore<TItem>,
  enabled: boolean,
): readonly TItem[] {
  const getEmptyItems = () => EMPTY_ITEMS as readonly TItem[];
  return useSyncExternalStore(
    enabled ? store.subscribe : noopSubscribe,
    enabled ? store.get : getEmptyItems,
    enabled ? store.get : getEmptyItems,
  );
}
