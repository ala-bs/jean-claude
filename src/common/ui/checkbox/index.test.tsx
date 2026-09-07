// @vitest-environment happy-dom

import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Checkbox } from '.';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(checked: boolean) {
  flushSync(() => {
    root.render(
      <Checkbox checked={checked} onChange={() => {}} label="Toggle me" />,
    );
  });
}

describe('Checkbox', () => {
  // Regression: rendering the tick only when checked left the indicator
  // childless in the unchecked state, which changed the baseline of the
  // `inline-flex` root and resized the row by 1px on every toggle, nudging
  // sibling content below it.
  it('keeps the indicator markup identical between checked and unchecked', () => {
    render(false);
    const unchecked = container.querySelector('span[aria-hidden="true"]');
    const uncheckedChildren = unchecked?.children.length;

    render(true);
    const checked = container.querySelector('span[aria-hidden="true"]');

    expect(uncheckedChildren).toBe(1);
    expect(checked?.children.length).toBe(uncheckedChildren);
  });

  it('hides the tick when unchecked via colour, not by unmounting it', () => {
    render(false);
    const indicator = container.querySelector('span[aria-hidden="true"]');

    expect(indicator?.querySelector('svg')).not.toBeNull();
    expect(indicator?.className).toContain('text-transparent');

    render(true);
    const checkedIndicator = container.querySelector('span[aria-hidden="true"]');

    expect(checkedIndicator?.querySelector('svg')).not.toBeNull();
    expect(checkedIndicator?.className).not.toContain('text-transparent');
  });
});
