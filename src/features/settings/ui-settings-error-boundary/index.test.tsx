// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { SettingsErrorBoundary } from '.';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Boom(): never {
  throw new Error('kaboom from a settings section');
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('SettingsErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    act(() => {
      root.render(
        <SettingsErrorBoundary>
          <div>all good</div>
        </SettingsErrorBoundary>,
      );
    });
    expect(container.textContent).toContain('all good');
  });

  it('shows the error message instead of blanking the panel', () => {
    act(() => {
      root.render(
        <SettingsErrorBoundary sectionLabel="general:maintenance">
          <Boom />
        </SettingsErrorBoundary>,
      );
    });

    expect(container.textContent).toContain('This settings section crashed');
    expect(container.textContent).toContain('kaboom from a settings section');
    expect(console.error).toHaveBeenCalled();
  });

  it('recovers when Try again is clicked', () => {
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error('transient');
      return <div>recovered</div>;
    }

    act(() => {
      root.render(
        <SettingsErrorBoundary>
          <Flaky />
        </SettingsErrorBoundary>,
      );
    });
    expect(container.textContent).toContain('This settings section crashed');

    shouldThrow = false;
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    act(() => retry?.click());

    expect(container.textContent).toContain('recovered');
  });
});
