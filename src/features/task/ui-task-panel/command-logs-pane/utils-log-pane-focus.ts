import type { MouseEvent, RefObject } from 'react';

export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  return !!target.closest('input, textarea, select, button, [contenteditable]');
}

export function selectActiveLog(pane: HTMLElement): void {
  const log = pane.querySelector<HTMLElement>('[data-command-log-content]');
  if (!log) return;

  const selection = window.getSelection();
  if (!selection) return;

  const range = document.createRange();
  range.selectNodeContents(log);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Mousedown handler that pulls keyboard focus onto `ref` unless the click
 * landed on something that wants focus itself (input, button, ...).
 */
export function focusOnNonInteractiveMouseDown(
  ref: RefObject<HTMLElement | null>,
): (event: MouseEvent) => void {
  return (event: MouseEvent) => {
    if (isInteractiveTarget(event.target)) return;
    ref.current?.focus();
  };
}
