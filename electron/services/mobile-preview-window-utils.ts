import { runCommand } from './mobile-preview-process';

const MINIMIZE_EMULATOR_WINDOW_TIMEOUT_MS = 2_000;
const MINIMIZE_EMULATOR_WINDOW_RETRY_MS = 500;
const MINIMIZE_EMULATOR_WINDOW_RETRY_FOR_MS = 5_000;

export const ANDROID_EMULATOR_PROCESS_NAMES = [
  'Android Emulator',
  'Emulator',
  'emulator',
  'qemu-system',
  'qemu-system-aarch64',
  'qemu-system-x86_64',
  'qemu-system-i386',
];
export const IOS_SIMULATOR_PROCESS_NAMES = ['Simulator'];

const MINIMIZE_WINDOWS_SCRIPT = `
on run argv
  set processNamesText to item 1 of argv
  set windowNamesText to item 2 of argv
  set AppleScript's text item delimiters to linefeed
  set processNames to text items of processNamesText
  set windowNameFilters to text items of windowNamesText

  tell application "System Events"
    repeat with emulatorProcess in processes
      try
        set processName to name of emulatorProcess as text
        set processMatches to false
        repeat with processNameFilter in processNames
          if processName contains (processNameFilter as text) then set processMatches to true
        end repeat
        if processMatches then
          tell emulatorProcess
            repeat with emulatorWindow in windows
              try
                set shouldMinimize to windowNamesText is ""
                set emulatorWindowName to name of emulatorWindow as text
                repeat with windowNameFilter in windowNameFilters
                  if windowNameFilter is not "" and emulatorWindowName contains (windowNameFilter as text) then
                    set shouldMinimize to true
                  end if
                end repeat
                if shouldMinimize then set value of attribute "AXMinimized" of emulatorWindow to true
              end try
            end repeat
          end tell
        end if
      end try
    end repeat
  end tell
end run
`.trim();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function minimizeMobilePreviewWindows({
  processNames,
  windowNameIncludes = [],
}: {
  processNames: string[];
  windowNameIncludes?: string[];
}): Promise<void> {
  if (process.platform !== 'darwin' || processNames.length === 0) return;

  const startedAt = Date.now();
  const windowNameFilters = windowNameIncludes.filter(Boolean);
  do {
    try {
      await runCommand(
        'osascript',
        [
          '-e',
          MINIMIZE_WINDOWS_SCRIPT,
          processNames.join('\n'),
          windowNameFilters.join('\n'),
        ],
        {
          timeoutMs: MINIMIZE_EMULATOR_WINDOW_TIMEOUT_MS,
        },
      );
    } catch {
      // Best effort: Accessibility permission or emulator process timing can fail.
    }

    await sleep(MINIMIZE_EMULATOR_WINDOW_RETRY_MS);
  } while (Date.now() - startedAt < MINIMIZE_EMULATOR_WINDOW_RETRY_FOR_MS);
}
