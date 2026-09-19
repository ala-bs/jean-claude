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

function render(checked: boolean, props?: { disabled?: boolean }) {
  flushSync(() => {
    root.render(
      <Checkbox
        checked={checked}
        onChange={() => {}}
        label="Toggle me"
        disabled={props?.disabled}
      />,
    );
  });
}

function mouseDownOnLabel() {
  const event = new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
  });
  container.querySelector('label')?.dispatchEvent(event);
  return event;
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

  // Regression: the browser's focus-driven scroll-into-view for the `sr-only`
  // input scrolled ancestors (including `overflow: clip` ones), which shifted
  // whole panels and left an unreachable blank band. We focus it ourselves
  // with preventScroll instead.
  it('focuses the input itself with preventScroll on mousedown', () => {
    render(false);
    const input = container.querySelector('input');
    const calls: (FocusOptions | undefined)[] = [];
    input!.focus = (options?: FocusOptions) => calls.push(options);

    const event = mouseDownOnLabel();

    expect(event.defaultPrevented).toBe(true);
    expect(calls).toEqual([{ preventScroll: true }]);
  });

  it('leaves mousedown alone when disabled so nothing gets focused', () => {
    render(false, { disabled: true });
    const input = container.querySelector('input');
    let focusCount = 0;
    input!.focus = () => {
      focusCount += 1;
    };

    const event = mouseDownOnLabel();

    expect(event.defaultPrevented).toBe(false);
    expect(focusCount).toBe(0);
  });
});
