import type { PreviewRenderedFrameSource } from './utils-setup-operation';

type NotifyFrameRendered = (
  sessionId: string,
  source: PreviewRenderedFrameSource,
) => void;

export function notifyImageFrameRendered(
  notify: NotifyFrameRendered,
  sessionId: string,
) {
  notify(sessionId, 'image');
}

export function notifyRawRgbaFrameRendered(
  notify: NotifyFrameRendered,
  sessionId: string,
) {
  notify(sessionId, 'raw-rgba');
}

export function notifyH264FrameRendered(
  notify: NotifyFrameRendered,
  sessionId: string,
) {
  notify(sessionId, 'h264');
}
