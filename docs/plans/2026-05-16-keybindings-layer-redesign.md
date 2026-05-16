# Keybindings Layer Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the flat Set-based exclusive layer system with an explicit layer-object API using stack-based priority and passthrough support.

**Architecture:** Layers are opaque handles created via `useKeyboardLayer()`. Bindings declare which layer they belong to (explicit prop or context wrapper). The topmost exclusive layer in the stack wins; its `passthrough` list allows named layers to also fire. Non-exclusive layers follow normal LIFO priority.

**Tech Stack:** React hooks, refs, context (minimal — only for wrapper sugar)

---

## Design

### New API

```tsx
// Create a layer
const layer = useKeyboardLayer('new-task', { exclusive: true, passthrough: ['global-nav'] })

// Register bindings to a layer (explicit)
useRegisterKeyboardBindings('escape', { 'escape': () => close() }, { layer })

// Or wrap children so they auto-inherit the layer
<KeyboardLayerProvider layer={layer}>
  <ChildrenWithBindings />
</KeyboardLayerProvider>

// useCommands also accepts layer
useCommands('settings-nav', [...], { layer })
```

### Layer Handle Shape

```ts
type KeyboardLayer = {
  readonly id: string;       // unique (useId)
  readonly name: string;     // human-readable, used for passthrough matching
}
```

### Resolution Algorithm

```
1. Get layer stack (ordered by mount time, last = topmost)
2. Find topmost exclusive layer (if any)
3. If exclusive layer exists:
   a. Allow bindings in that layer
   b. Allow bindings in layers named in passthrough[]
   c. Block everything else
4. If no exclusive layer: normal LIFO over all bindings
5. Within allowed set: LIFO priority (last registered = first checked)
```

### Migration Path

- Keep `useRegisterKeyboardBindings` signature backward-compatible (layer is optional)
- Bindings with no layer = "root" (always active unless blocked by exclusive)
- Old `KeyboardBindingLayer exclusive` replaced by `useKeyboardLayer` + `KeyboardLayerProvider`
- Only 2 consumers to migrate: `ModalProvider` and `review-submit-overlay`

---

## Tasks

### Task 1: Rewrite core keyboard-bindings module

**Files:**
- Modify: `src/common/context/keyboard-bindings/index.tsx` (full rewrite)

**Step 1: Rewrite the module**

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';

import type { BindingKey } from './types';
import { formatKeyboardEvent, isTypingInInput } from './utils';

// --- Types ---

export type KeyboardLayer = {
  readonly id: string;
  readonly name: string;
};

type BindingHandler = (event: KeyboardEvent) => boolean | void;

interface BindingConfig {
  handler: BindingHandler;
  ignoreIfInput?: boolean;
}

type Bindings = {
  [key in BindingKey]?: BindingHandler | BindingConfig;
};

// --- Root Context ---

interface RootContextValue {
  register: (
    id: string,
    bindings: RefObject<Bindings>,
    options?: { layerId?: string },
  ) => () => void;
  registerLayer: (layer: {
    id: string;
    name: string;
    exclusive?: boolean;
    passthrough?: string[];
  }) => () => void;
}

const RootKeyboardBindingsContext = createContext<RootContextValue | null>(null);

// --- Layer Context (for wrapper sugar) ---

const KeyboardLayerContext = createContext<KeyboardLayer | null>(null);

// --- Root Provider ---

export function RootKeyboardBindings({ children }: { children: ReactNode }) {
  const bindingsRef = useRef<
    { id: string; bindings: RefObject<Bindings>; layerId?: string }[]
  >([]);

  const layersRef = useRef<
    { id: string; name: string; exclusive?: boolean; passthrough?: string[] }[]
  >([]);

  const register = useCallback(
    (
      id: string,
      bindings: RefObject<Bindings>,
      options?: { layerId?: string },
    ) => {
      bindingsRef.current = bindingsRef.current.filter((c) => c.id !== id);
      bindingsRef.current.push({ id, bindings, layerId: options?.layerId });
      return () => {
        bindingsRef.current = bindingsRef.current.filter((c) => c.id !== id);
      };
    },
    [],
  );

  const registerLayer = useCallback(
    (layer: {
      id: string;
      name: string;
      exclusive?: boolean;
      passthrough?: string[];
    }) => {
      layersRef.current = layersRef.current.filter((l) => l.id !== layer.id);
      layersRef.current.push(layer);
      return () => {
        layersRef.current = layersRef.current.filter((l) => l.id !== layer.id);
      };
    },
    [],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = formatKeyboardEvent(event);
      const inInput = isTypingInInput(event);

      // Find topmost exclusive layer (last in array = most recent mount)
      let topmostExclusive: (typeof layersRef.current)[number] | null = null;
      for (let i = layersRef.current.length - 1; i >= 0; i--) {
        if (layersRef.current[i].exclusive) {
          topmostExclusive = layersRef.current[i];
          break;
        }
      }

      // Build set of allowed layer IDs
      let allowedLayerIds: Set<string> | null = null;
      if (topmostExclusive) {
        allowedLayerIds = new Set<string>([topmostExclusive.id]);
        if (topmostExclusive.passthrough) {
          // Passthrough matches by layer NAME
          for (const layer of layersRef.current) {
            if (topmostExclusive.passthrough.includes(layer.name)) {
              allowedLayerIds.add(layer.id);
            }
          }
        }
      }

      // Loop LIFO (most recently registered first)
      for (let i = bindingsRef.current.length - 1; i >= 0; i--) {
        const entry = bindingsRef.current[i];

        // If exclusive layer active, filter
        if (allowedLayerIds) {
          if (!entry.layerId || !allowedLayerIds.has(entry.layerId)) {
            continue;
          }
        }

        const binding = entry.bindings.current?.[key];
        if (!binding) continue;

        const config: BindingConfig =
          typeof binding === 'function' ? { handler: binding } : binding;

        if (config.ignoreIfInput && inInput) continue;

        const handled = config.handler(event);
        if (handled === true || handled === undefined) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, []);

  const value = useMemo(
    () => ({ register, registerLayer }),
    [register, registerLayer],
  );

  return (
    <RootKeyboardBindingsContext.Provider value={value}>
      {children}
    </RootKeyboardBindingsContext.Provider>
  );
}

// --- useKeyboardLayer ---

export function useKeyboardLayer(
  name: string,
  options?: { exclusive?: boolean; passthrough?: string[] },
): KeyboardLayer {
  const id = useId();
  const root = useRootKeyboardBindings();

  const exclusive = options?.exclusive;
  const passthrough = options?.passthrough;

  useEffect(() => {
    return root.registerLayer({ id, name, exclusive, passthrough });
  }, [id, name, exclusive, passthrough, root]);

  return useMemo(() => ({ id, name }), [id, name]);
}

// --- KeyboardLayerProvider (wrapper sugar) ---

export function KeyboardLayerProvider({
  layer,
  children,
}: {
  layer: KeyboardLayer;
  children: ReactNode;
}) {
  return (
    <KeyboardLayerContext.Provider value={layer}>
      {children}
    </KeyboardLayerContext.Provider>
  );
}

// --- useRegisterKeyboardBindings ---

export function useRegisterKeyboardBindings(
  id: string,
  bindings: Bindings,
  options?: { enabled?: boolean; layer?: KeyboardLayer },
): void {
  const root = useRootKeyboardBindings();
  const contextLayer = useContext(KeyboardLayerContext);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  const enabled = options?.enabled ?? true;
  const layer = options?.layer ?? contextLayer;
  const layerId = layer?.id;

  useEffect(() => {
    if (!enabled) return;
    return root.register(id, bindingsRef, { layerId });
  }, [id, root, enabled, layerId]);
}

// --- Backward compat: KeyboardBindingLayer (deprecated) ---

/**
 * @deprecated Use `useKeyboardLayer` + `KeyboardLayerProvider` instead.
 */
export function KeyboardBindingLayer({
  exclusive,
  children,
  passthrough,
}: {
  exclusive?: boolean;
  passthrough?: string[];
  children: ReactNode;
}) {
  const layer = useKeyboardLayer('keyboard-binding-layer', {
    exclusive,
    passthrough,
  });

  return (
    <KeyboardLayerProvider layer={layer}>{children}</KeyboardLayerProvider>
  );
}

// --- Internal ---

function useRootKeyboardBindings() {
  const context = useContext(RootKeyboardBindingsContext);
  if (!context) {
    throw new Error(
      'useRootKeyboardBindings must be used within RootKeyboardBindings',
    );
  }
  return context;
}
```

**Step 2: Run type check**

Run: `pnpm ts-check`
Expected: PASS (backward-compat `KeyboardBindingLayer` still exported)

**Step 3: Run lint**

Run: `pnpm lint --fix && pnpm lint`
Expected: PASS

**Step 4: Commit**

```bash
git add src/common/context/keyboard-bindings/index.tsx
git commit -m "refactor(keybindings): rewrite core with layer-object API and stack-based priority"
```

---

### Task 2: Update useCommands to accept layer option

**Files:**
- Modify: `src/common/hooks/use-commands/index.tsx`

**Step 1: Add layer to useCommands signature**

Add optional `options` parameter with `layer`:

```tsx
import type { KeyboardLayer } from '@/common/context/keyboard-bindings';

export const useCommands = (
  id: string,
  commands: (Command | false | null | undefined)[],
  options?: { layer?: KeyboardLayer },
) => {
  const filtered = commands.filter((v) => !!v);
  useCommandPalette(id, filtered);
  useRegisterKeyboardBindings(
    id,
    filtered.reduce(
      (acc, command) => {
        const binding = command.ignoreIfInput
          ? { handler: () => command.handler(), ignoreIfInput: true }
          : () => command.handler();

        if (Array.isArray(command.shortcut)) {
          command.shortcut.forEach((key) => { acc[key] = binding; });
        } else if (command.shortcut) {
          acc[command.shortcut] = binding;
        }
        return acc;
      },
      {} as Parameters<typeof useRegisterKeyboardBindings>[1],
    ),
    { layer: options?.layer },
  );
};
```

**Step 2: Run type check + lint**

Run: `pnpm ts-check && pnpm lint --fix && pnpm lint`
Expected: PASS

**Step 3: Commit**

```bash
git add src/common/hooks/use-commands/index.tsx
git commit -m "feat(keybindings): add layer option to useCommands"
```

---

### Task 3: Migrate existing KeyboardBindingLayer consumers

**Files:**
- Modify: `src/common/context/modal/index.tsx`
- Modify: `src/features/agent/ui-review-comments/review-submit-overlay.tsx`

**Step 1: Migrate ModalProvider**

Replace `<KeyboardBindingLayer exclusive>` with `useKeyboardLayer` + `KeyboardLayerProvider`:

```tsx
import {
  KeyboardLayerProvider,
  useKeyboardLayer,
  useRegisterKeyboardBindings,
} from '@/common/context/keyboard-bindings';

// Inside ModalProvider, before the return:
// (layer must be always created but only rendered when modal exists)

// Inside the modal rendering section:
{currentModal && (
  <ModalExclusiveLayer modal={currentModal} onClose={removeFromQueue} />
)}

// Extract to sub-component so the hook is always called:
function ModalExclusiveLayer({ modal, onClose }: { modal: QueuedModal; onClose: () => void }) {
  const layer = useKeyboardLayer('modal', { exclusive: true });
  return (
    <KeyboardLayerProvider layer={layer}>
      <ModalRenderer modal={modal} onClose={onClose} />
    </KeyboardLayerProvider>
  );
}
```

**Step 2: Migrate review-submit-overlay**

Same pattern — replace `<KeyboardBindingLayer exclusive>` with hook + provider.

**Step 3: Run type check + lint**

Run: `pnpm ts-check && pnpm lint --fix && pnpm lint`
Expected: PASS

**Step 4: Commit**

```bash
git add src/common/context/modal/index.tsx src/features/agent/ui-review-comments/review-submit-overlay.tsx
git commit -m "refactor(keybindings): migrate consumers to new layer API"
```

---

### Task 4: Remove deprecated KeyboardBindingLayer (optional, can defer)

Only after all consumers migrated. Remove from exports and delete the component.

---

## Summary

| What | Before | After |
|------|--------|-------|
| Layer creation | Implicit via `<KeyboardBindingLayer>` context | Explicit `useKeyboardLayer()` returns handle |
| Exclusive priority | Flat Set (all exclusive layers fire) | Stack (topmost exclusive wins) |
| Passthrough | Not supported | `passthrough: ['layer-name']` on exclusive layers |
| Binding assignment | Auto from context tree | Explicit `{ layer }` or `<KeyboardLayerProvider>` |
| Root bindings (no layer) | Always active | Active unless blocked by exclusive |
