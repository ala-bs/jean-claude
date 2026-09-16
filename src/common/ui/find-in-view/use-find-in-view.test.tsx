// @vitest-environment happy-dom

import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFindInView } from './use-find-in-view';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function pressEscape() {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }),
  );
}

function pressFind() {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/**
 * Mimics `Modal`: an Escape handler on `document` in the capture phase,
 * registered *before* the find bar opens.
 */
function Harness({
  onModalClose,
  enabled = true,
  label = '',
}: {
  onModalClose: () => void;
  enabled?: boolean;
  label?: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<{ focus: () => void }>(null);
  const find = useFindInView({ containerRef: contentRef, inputRef, enabled });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.defaultPrevented) return;
      onModalClose();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [onModalClose]);

  return (
    <div ref={contentRef} data-testid="content">
      <span>{`${label}${find.isOpen ? 'search-open' : 'search-closed'}`}</span>
    </div>
  );
}

describe('useFindInView escape handling', () => {
  it('closes the search before the surrounding modal sees Escape', () => {
    const onModalClose = vi.fn();
    flushSync(() => root.render(<Harness onModalClose={onModalClose} />));

    flushSync(() => pressFind());
    expect(container.textContent).toBe('search-open');

    flushSync(() => pressEscape());
    expect(container.textContent).toBe('search-closed');
    expect(onModalClose).not.toHaveBeenCalled();
  });

  it('lets Escape through to the modal once the search is closed', () => {
    const onModalClose = vi.fn();
    flushSync(() => root.render(<Harness onModalClose={onModalClose} />));

    flushSync(() => pressEscape());
    expect(onModalClose).toHaveBeenCalledTimes(1);
  });

  it('closes when it loses `enabled`, so it stops swallowing Escape', () => {
    const onModalClose = vi.fn();
    flushSync(() =>
      root.render(<Harness onModalClose={onModalClose} enabled />),
    );
    flushSync(() => pressFind());
    expect(container.textContent).toBe('search-open');

    // e.g. the full details modal opens over this preview pane. `act` rather
    // than flushSync so the teardown of the Escape listener also flushes.
    act(() => {
      root.render(<Harness onModalClose={onModalClose} enabled={false} />);
    });
    expect(container.textContent).toBe('search-closed');

    flushSync(() => pressEscape());
    expect(onModalClose).toHaveBeenCalledTimes(1);
  });
});

describe('useFindInView instance arbitration', () => {
  it('closes any other open find bar when one opens', () => {
    // Both are enabled at once — e.g. the work item route rendering a details
    // view while a board overlay keeps its preview pane mounted. They share the
    // global CSS.highlights registry, so only one may be open.
    const noop = vi.fn();
    flushSync(() =>
      root.render(
        <>
          <Harness onModalClose={noop} label="a:" />
          <Harness onModalClose={noop} label="b:" />
        </>,
      ),
    );

    flushSync(() => pressFind());
    // Which one wins is incidental (last handler registered); what matters is
    // that never more than one is open, since they share one highlight registry.
    const openCount = (container.textContent ?? '').split('search-open').length - 1;
    expect(openCount).toBe(1);
  });
});
