/**
 * Character-offset helpers shared by the commentable-text layer and any
 * content that needs to anchor a selection back to its owning message.
 */

/**
 * Character offset of `target`'s first text node within `container`'s combined
 * text, or -1 when `target` is not inside `container`.
 *
 * Used to rebase offsets when a fragment of a message (e.g. a table) is
 * re-rendered in a portal: offsets measured inside the portal are relative to
 * the fragment, but comments must be stored relative to the whole message.
 */
export function getNodeCharOffset(container: Node, target: Node): number {
  if (!container.contains(target)) return -1;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (target.contains(node)) return offset;
    offset += node.textContent?.length ?? 0;
  }
  return -1;
}
