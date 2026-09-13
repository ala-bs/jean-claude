export const MIN_BOARD_WIDTH = 30;
export const MAX_BOARD_WIDTH = 80;

export function clampBoardWidth(width: number) {
  return Math.min(MAX_BOARD_WIDTH, Math.max(MIN_BOARD_WIDTH, width));
}

export function getKeyboardBoardWidth(currentWidth: number, key: string) {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  return clampBoardWidth(currentWidth + (key === 'ArrowLeft' ? -2 : 2));
}

export function createBoardResize(initialWidth: number) {
  let pendingWidth = clampBoardWidth(initialWidth);
  let finished = false;

  return {
    move({
      clientX,
      containerLeft,
      containerWidth,
    }: {
      clientX: number;
      containerLeft: number;
      containerWidth: number;
    }) {
      if (!finished && containerWidth > 0) {
        pendingWidth = clampBoardWidth(
          ((clientX - containerLeft) / containerWidth) * 100,
        );
      }
      return pendingWidth;
    },
    finish() {
      if (finished) return null;
      finished = true;
      return pendingWidth;
    },
  };
}
