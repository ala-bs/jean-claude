// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import type { PermissionScope } from '@shared/permission-types';

const openDirectory = vi.hoisted(() => vi.fn());
const addToast = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({ api: { dialog: { openDirectory } } }));
vi.mock('@/stores/toasts', () => ({
  useToastStore: (selector: (state: unknown) => unknown) =>
    selector({ addToast }),
}));

import { ExternalDirectories, getExternalDirectories } from '.';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onAdd = vi.fn(async () => {});
const onRemove = vi.fn();

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render(permissions: PermissionScope | undefined) {
  act(() => {
    root.render(
      <ExternalDirectories
        permissions={permissions}
        isLoading={false}
        isBusy={false}
        description="desc"
        emptyDescription="nothing here"
        onAdd={onAdd}
        onRemove={onRemove}
      />,
    );
  });
}

function rows() {
  return Array.from(container.querySelectorAll('li'));
}

function addButton() {
  return Array.from(container.querySelectorAll('button')).find((element) =>
    element.textContent?.includes('Add directory'),
  )!;
}

async function clickAdd() {
  await act(async () => {
    addButton().click();
  });
}

describe('ExternalDirectories', () => {
  it('shows the caller-supplied empty state when no entries exist', () => {
    render({});
    expect(container.textContent).toContain('nothing here');
    expect(rows()).toHaveLength(0);
  });

  it('lists allow entries as plain directories', () => {
    render({ external_directory: { '/tmp/shared/**': 'allow' } });
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain('/tmp/shared');
  });

  it('still renders deny/ask and non-glob entries so they can be removed', () => {
    // These are invisible to `getExternalDirectories` and hidden from the
    // permissions editor, so this list is their only UI affordance.
    render({
      external_directory: {
        '/tmp/denied/**': 'deny',
        '/tmp/weird': 'allow',
      },
    });

    expect(rows()).toHaveLength(2);
    expect(container.textContent).toContain('/tmp/denied');
    expect(container.textContent).toContain('deny');
    expect(container.textContent).toContain('/tmp/weird');

    act(() => {
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Remove /tmp/denied"]',
      )!.click();
    });
    expect(onRemove).toHaveBeenCalledWith('/tmp/denied/**');
  });

  it('adds the picked directory as a `<dir>/**` allow pattern', async () => {
    openDirectory.mockResolvedValue('/tmp/new/');
    render({});
    await clickAdd();
    expect(onAdd).toHaveBeenCalledWith('/tmp/new/**');
  });

  it('skips directories already granted', async () => {
    openDirectory.mockResolvedValue('/tmp/shared');
    render({ external_directory: { '/tmp/shared/**': 'allow' } });
    await clickAdd();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('re-adds a directory whose existing entry is not `allow`', async () => {
    openDirectory.mockResolvedValue('/tmp/denied');
    render({ external_directory: { '/tmp/denied/**': 'deny' } });
    await clickAdd();
    expect(onAdd).toHaveBeenCalledWith('/tmp/denied/**');
  });

  it('rejects directories with glob metacharacters instead of writing a dead rule', async () => {
    openDirectory.mockResolvedValue('/tmp/we[i]rd');
    render({});
    await clickAdd();
    expect(onAdd).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    );
  });
});

describe('getExternalDirectories', () => {
  it('returns only allow entries with a `/**` suffix', () => {
    expect(
      getExternalDirectories({
        external_directory: {
          '/a/**': 'allow',
          '/b/**': 'deny',
          '/c': 'allow',
        },
      }),
    ).toEqual(['/a']);
  });

  it('tolerates a missing scope', () => {
    expect(getExternalDirectories(undefined)).toEqual([]);
  });
});
