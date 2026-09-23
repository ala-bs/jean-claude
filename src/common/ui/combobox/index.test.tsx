// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { Combobox } from '@/common/ui/combobox';
import { RootOverlay } from '@/common/context/overlay';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  act(() => {
    root.render(<RootOverlay>{node}</RootOverlay>);
  });
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** The popover renders into a portal on document.body. */
function queryOptions() {
  return Array.from(document.querySelectorAll('[role="option"]'));
}

function optionLabels() {
  // The label and description spans both match `span.block`; take the first
  // child of the text column so reordering them cannot silently flip this to
  // asserting on descriptions.
  return queryOptions().map(
    (option) =>
      option.querySelector('.min-w-0 > span:first-child')?.textContent ?? '',
  );
}

/** Sticky group headers, which are presentational siblings of the options. */
function groupHeaders() {
  const listbox = document.querySelector('[role="listbox"]');
  return Array.from(
    listbox?.querySelectorAll(':scope > [role="presentation"]') ?? [],
  )
    .filter((node) => !node.querySelector('[role="option"]'))
    .map((node) => node.textContent ?? '');
}

function openMenu() {
  const trigger = container.querySelector('button');
  if (!trigger) throw new Error('Combobox trigger not found');
  click(trigger);
}

function typeSearch(text: string) {
  const input = document.querySelector('input');
  if (!input) throw new Error('Search input not found');
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const DEVICES = [
  {
    value: 'android:Pixel_8',
    label: 'Pixel 8',
    description: 'Android · Booted',
    group: 'Favorites',
    keywords: ['Android', 'android', 'Pixel_8', 'booted'],
  },
  {
    value: 'ios:sim-se',
    label: 'iPhone SE',
    description: 'iOS 18.2',
    group: 'iOS',
    keywords: ['iOS', 'ios', 'sim-se', 'shutdown'],
  },
  {
    value: 'android:Nexus_5',
    label: 'Nexus 5',
    description: '',
    group: 'Android',
    keywords: ['Android', 'android', 'Nexus_5', 'shutdown'],
  },
];

function renderPicker(
  overrides: Partial<React.ComponentProps<typeof Combobox>> = {},
) {
  render(
    <Combobox
      value=""
      options={DEVICES}
      onChange={vi.fn()}
      label="Select a device"
      placeholder="Select a device…"
      {...overrides}
    />,
  );
}

describe('Combobox', () => {
  it('filters devices by name as you type', () => {
    renderPicker();
    openMenu();
    expect(queryOptions()).toHaveLength(3);

    typeSearch('nexus');

    expect(optionLabels()).toEqual(['Nexus 5']);
  });

  it('matches the platform typed as a word', () => {
    // Note this passes via the `platform:id` value as well as via keywords, so
    // it pins the user-facing behaviour rather than the keywords plumbing --
    // the test below is the one that isolates keywords.
    renderPicker();
    openMenu();

    typeSearch('android');

    expect(optionLabels()).toEqual(['Pixel 8', 'Nexus 5']);
  });

  it('matches keywords absent from the label, description and value', () => {
    // "shutdown" appears in no visible field of any row, so this only passes
    // if `keywords` genuinely participates in the search.
    renderPicker();
    openMenu();

    typeSearch('shutdown');

    expect(optionLabels()).toEqual(['iPhone SE', 'Nexus 5']);
  });

  it('shows the empty label when nothing matches', () => {
    renderPicker({ emptyLabel: 'No matching devices' });
    openMenu();

    typeSearch('zzzz');

    expect(queryOptions()).toHaveLength(0);
    expect(document.body.textContent).toContain('No matching devices');
  });

  it('renders one header per group, in order', () => {
    // Asserts the header ELEMENTS: `body.textContent` also contains "iOS" and
    // "Android" from the option descriptions, so a text check passed even when
    // only the first header rendered.
    renderPicker();
    openMenu();

    expect(groupHeaders()).toEqual(['Favorites', 'iOS', 'Android']);
  });

  it('renders a single header for consecutive rows in one group', () => {
    renderPicker({
      options: [
        { value: 'ios:a', label: 'A', group: 'iOS' },
        { value: 'ios:b', label: 'B', group: 'iOS' },
        { value: 'android:c', label: 'C', group: 'Android' },
      ],
    });
    openMenu();

    expect(groupHeaders()).toEqual(['iOS', 'Android']);
  });

  it('drops headers whose group has no surviving matches', () => {
    renderPicker();
    openMenu();

    typeSearch('nexus');

    expect(groupHeaders()).toEqual(['Android']);
  });

  it('toggles the trailing star without selecting the row', () => {
    // The point of starring from the list: star several devices in one pass
    // without the menu selecting a row and closing under you.
    const onChange = vi.fn();
    const onToggle = vi.fn();
    renderPicker({
      onChange,
      renderOptionTrailing: (option) => (
        <button
          type="button"
          data-testid={`star-${option.value}`}
          onClick={() => onToggle(option.value)}
        >
          star
        </button>
      ),
    });
    openMenu();

    const star = document.querySelector('[data-testid="star-ios:sim-se"]');
    expect(star).not.toBeNull();
    click(star!);

    expect(onToggle).toHaveBeenCalledWith('ios:sim-se');
    expect(onChange).not.toHaveBeenCalled();
    expect(queryOptions()).toHaveLength(3);
  });

  it('still selects when the row itself is clicked', () => {
    const onChange = vi.fn();
    renderPicker({
      onChange,
      renderOptionTrailing: () => <button type="button">star</button>,
    });
    openMenu();

    click(queryOptions()[1]);

    expect(onChange).toHaveBeenCalledWith('ios:sim-se');
  });

  it('shows the placeholder when the value matches no option', () => {
    // A deleted simulator leaves a stale key; the trigger must not imply that
    // some other device is selected.
    renderPicker({ value: 'ios:deleted' });

    expect(container.textContent).toContain('Select a device…');
  });
});
