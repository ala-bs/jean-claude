// Electron wraps main-process throws as
// "Error invoking remote method 'channel': Error: <message>".
// Strip that boilerplate so the original message can be shown to the user.
export function cleanIpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
}
