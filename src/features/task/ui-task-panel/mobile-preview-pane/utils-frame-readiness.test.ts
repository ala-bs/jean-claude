import { describe, expect, it, vi } from 'vitest';

import {
  notifyH264FrameRendered,
  notifyImageFrameRendered,
  notifyRawRgbaFrameRendered,
} from './utils-frame-readiness';

describe('preview frame readiness wiring', () => {
  it('forwards image, raw RGBA, and H264 renders with exact session id', () => {
    const notify = vi.fn();

    notifyImageFrameRendered(notify, 'image-session');
    notifyRawRgbaFrameRendered(notify, 'raw-session');
    notifyH264FrameRendered(notify, 'h264-session');

    expect(notify.mock.calls).toEqual([
      ['image-session', 'image'],
      ['raw-session', 'raw-rgba'],
      ['h264-session', 'h264'],
    ]);
  });
});
