// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// The real <Modal> is used on purpose: this suite exists because <Modal> defers
// mounting its children by one render while it wins arbitration, which is what
// broke the changelog's infinite scroll. Mocking <Modal> hides the bug entirely.
vi.mock('@/common/context/keyboard-bindings', () => ({
  useRegisterKeyboardBindings: () => {},
}));
vi.mock('react-focus-lock', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('react-remove-scroll', () => ({
  RemoveScroll: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ModalArbitrationProvider } from '@/common/context/modal-arbitration';
import { changelog } from '@/lib/changelog';
import { useChangelogStore } from '@/stores/changelog';

import { ChangelogModal } from '.';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAYS_PER_PAGE = 10;

type Observed = {
  callback: IntersectionObserverCallback;
  targets: Element[];
  options: IntersectionObserverInit | undefined;
};

let observers: Observed[] = [];
let container: HTMLDivElement;
let root: Root;

function installIntersectionObserver() {
  class FakeIntersectionObserver {
    private readonly entry: Observed;

    constructor(
      callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      this.entry = { callback, targets: [], options };
      observers.push(this.entry);
    }

    observe(target: Element) {
      this.entry.targets.push(target);
    }

    unobserve() {}

    disconnect() {
      observers = observers.filter((item) => item !== this.entry);
    }

    takeRecords() {
      return [];
    }
  }

  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
}

function renderModal() {
  act(() => {
    root.render(
      <ModalArbitrationProvider>
        <ChangelogModal />
      </ModalArbitrationProvider>,
    );
  });
}

function renderedDayCount() {
  return document.querySelectorAll('section[data-date]').length;
}

/** Simulate the sentinel scrolling into view. */
function triggerSentinel() {
  const observer = observers.at(-1);
  if (!observer) throw new Error('no IntersectionObserver was constructed');
  const target = observer.targets.at(-1);
  act(() => {
    observer.callback(
      [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
}

describe('ChangelogModal infinite scroll', () => {
  beforeEach(() => {
    observers = [];
    installIntersectionObserver();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      useChangelogStore.setState({ isOpen: true, lastSeenHash: 'seen' });
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    act(() => {
      useChangelogStore.setState({ isOpen: false, lastSeenHash: null });
    });
  });

  it('has enough fixture data for pagination to be observable', () => {
    // Guards the rest of the suite: with <= one page of changelog days there is
    // no sentinel and these assertions would pass vacuously.
    expect(changelog.length).toBeGreaterThan(DAYS_PER_PAGE);
  });

  it('attaches an observer to the sentinel despite Modal deferring child mount', () => {
    renderModal();

    // Regression: <Modal> renders null on the first pass while it acquires
    // arbitration, so a plain ref is still null when this component's effects
    // run — and nothing re-ran them afterwards, so no observer was ever built.
    expect(observers.length).toBeGreaterThan(0);
    const observer = observers.at(-1);
    expect(observer?.targets.at(-1)).toBeInstanceOf(HTMLElement);
    expect(observer?.options?.root).toBeInstanceOf(HTMLElement);
  });

  it('renders more days each time the sentinel comes into view', () => {
    renderModal();
    expect(renderedDayCount()).toBe(DAYS_PER_PAGE);

    triggerSentinel();
    expect(renderedDayCount()).toBe(DAYS_PER_PAGE * 2);

    triggerSentinel();
    expect(renderedDayCount()).toBe(DAYS_PER_PAGE * 3);
  });

  it('re-arms the observer after each page so loading never stalls', () => {
    renderModal();

    // A single long-lived observer only fires on an intersection *transition*.
    // If the sentinel stays visible after a short page renders, no further
    // callback arrives, so the observer must be rebuilt per page.
    const before = observers.at(-1);
    triggerSentinel();
    expect(observers.at(-1)).not.toBe(before);
    expect(observers.at(-1)?.targets.at(-1)).toBeInstanceOf(HTMLElement);
  });

  it('stops observing and reports the end once every day is rendered', () => {
    renderModal();

    const pages = Math.ceil(changelog.length / DAYS_PER_PAGE);
    for (let i = 0; i < pages - 1; i++) triggerSentinel();

    expect(renderedDayCount()).toBe(changelog.length);
    expect(observers).toHaveLength(0);
    // Modal portals into document.body, so assert against the document.
    expect(document.body.textContent).toContain("That's the whole changelog");
  });
});
