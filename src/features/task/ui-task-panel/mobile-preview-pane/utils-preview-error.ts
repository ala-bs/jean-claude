import type {
  MobilePreviewStreamStrategy,
} from '@shared/mobile-simulator-types';

export function formatError(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

export function cleanPreviewError(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
}

export function getStreamStrategyLabel(
  strategy: MobilePreviewStreamStrategy | null | undefined,
) {
  switch (strategy) {
    case 'coresimulator-framebuffer':
      return 'CoreSimulator framebuffer';
    case 'idb-h264-stream':
      return 'idb H264 stream';
    case 'idb-rbga-stream':
      return 'idb raw RGBA stream';
    case 'idb-video-stream':
      return 'idb video stream';
    case 'simctl-screenshot':
      return 'simctl screenshots';
    case 'adb-screenrecord':
      return 'adb screenrecord';
    case 'adb-screenshot':
      return 'adb screenshots';
    case 'scrcpy':
      return 'scrcpy';
    default:
      return null;
  }
}

export function getWaitingForFrameDetail(
  strategy: MobilePreviewStreamStrategy | null | undefined,
) {
  switch (strategy) {
    case 'coresimulator-framebuffer':
      return 'Preview stream is running; waiting for CoreSimulator frames';
    case 'simctl-screenshot':
      return 'Preview stream is running; waiting for simulator screenshots';
    case 'idb-rbga-stream':
    case 'idb-h264-stream':
    case 'idb-video-stream':
      return 'Preview stream is running; waiting for idb frames';
    case 'adb-screenshot':
      return 'Preview stream is running; waiting for Android screenshots';
    case 'adb-screenrecord':
      return 'Preview stream is running; waiting for Android screenrecord frames';
    case 'scrcpy':
      return 'Preview stream is running; waiting for scrcpy frames';
    default:
      return 'Preview stream is running; waiting for frames';
  }
}

export function getPreviewErrorInfo(message: string): {
  title: string;
  summary: string;
  steps: string[];
  detail?: string;
} {
  const cleaned = cleanPreviewError(message);

  if (cleaned.includes('Missing required iOS preview tool: idb')) {
    return {
      title: 'Install iOS streaming tools',
      summary:
        'Jean-Claude can see simulators, but needs idb to send interactive input.',
      steps: [
        'brew tap facebook/fb && brew install idb-companion',
        'python3 -m pip install fb-idb',
        'Restart Jean-Claude after idb is on PATH',
      ],
    };
  }

  if (cleaned.includes('Missing required iOS preview tool: xcrun')) {
    return {
      title: 'Install Xcode tools',
      summary: 'xcrun is required to list and boot iOS simulators.',
      steps: ['xcode-select --install', 'Restart Jean-Claude'],
    };
  }

  if (cleaned.includes('Missing required Android preview tool: adb')) {
    return {
      title: 'Install Android Platform Tools',
      summary: 'adb is required to find Android devices and send input.',
      steps: [
        'brew install --cask android-platform-tools',
        'adb devices -l',
        'Restart Jean-Claude after adb is on PATH',
      ],
    };
  }

  return {
    title: 'Preview error',
    summary: cleaned,
    steps: [],
  };
}
