import type { DebugMessageWithRawData } from '@/lib/api';

const MAX_TASK_TITLE_FILENAME_LENGTH = 80;

export function getMessageMappingFilename({
  taskId,
  taskTitle,
}: {
  taskId: string;
  taskTitle: string;
}): string {
  const safeTaskTitle = taskTitle
    .trim()
    .split('')
    .map((character) =>
      character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character)
        ? '-'
        : character,
    )
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, MAX_TASK_TITLE_FILENAME_LENGTH)
    .trim();

  const hasMeaningfulTitle = /[^.\- ]/.test(safeTaskTitle);
  return `message-mapping-${hasMeaningfulTitle ? safeTaskTitle : taskId.slice(0, 8)}.json`;
}

export function downloadMessageMapping(
  messages: DebugMessageWithRawData[],
  taskId: string,
  taskTitle: string,
) {
  const mapping = messages.map((msg) => ({
    messageIndex: msg.messageIndex,
    rawFormat: msg.rawFormat,
    backendSessionId: msg.backendSessionId,
    createdAt: msg.createdAt,
    rawData: msg.rawData ?? null,
    normalizedData: msg.normalizedData ?? null,
  }));

  const blob = new Blob([JSON.stringify(mapping, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = getMessageMappingFilename({ taskId, taskTitle });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
