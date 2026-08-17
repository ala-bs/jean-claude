// Shared list-selection semantics for the diff tab strip and file tree.

/**
 * Selection produced by clicking a row (a tab, a file in the tree): ⇧ extends
 * from the anchor, ⌘/ctrl toggles, a plain click replaces. `activate` says
 * whether the click should also open the file.
 */
export function selectionAfterClick({
  rowPaths,
  path,
  anchor,
  selection,
  shiftKey,
  toggleKey,
}: {
  rowPaths: string[];
  path: string;
  anchor: string | null;
  selection: string[];
  shiftKey: boolean;
  toggleKey: boolean;
}): { selection: string[]; anchor: string | null; activate: boolean } {
  if (shiftKey && anchor) {
    const from = rowPaths.indexOf(anchor);
    const to = rowPaths.indexOf(path);
    if (from > -1 && to > -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      return { selection: rowPaths.slice(lo, hi + 1), anchor, activate: true };
    }
  }
  if (toggleKey) {
    return {
      selection: selection.includes(path)
        ? selection.filter((item) => item !== path)
        : [...selection, path],
      anchor: path,
      activate: false,
    };
  }
  return { selection: [path], anchor: path, activate: true };
}
