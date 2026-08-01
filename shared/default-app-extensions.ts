/**
 * File extensions that should be opened with the OS default application
 * (images, documents, media, archives) instead of the configured code editor.
 *
 * This allowlist is enforced in the main process too, so untrusted paths
 * printed by agents or command output can never be used to launch an
 * executable through `shell.openPath`.
 */
export const DEFAULT_APP_EXTENSIONS = new Set([
  // Images
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'tiff',
  'heic',
  'avif',
  // Documents
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'key',
  'pages',
  'numbers',
  // Media
  'mp4',
  'mov',
  'webm',
  'avi',
  'mkv',
  'mp3',
  'wav',
  'm4a',
  'flac',
  'ogg',
  // Archives
  'zip',
  'tar',
  'gz',
  'tgz',
  'rar',
  '7z',
]);

/**
 * True when the path should be opened with the OS default application.
 * Files without an extension, dotfiles, and anything not on the allowlist
 * are treated as editor files.
 */
export function isDefaultAppFile(filePath: string): boolean {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0) return false;
  return DEFAULT_APP_EXTENSIONS.has(fileName.slice(dotIndex + 1).toLowerCase());
}
