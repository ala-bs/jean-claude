export function getPrThreadImageUploader<T>({
  readOnly,
  activeCommentMode,
  uploadImage,
}: {
  readOnly: boolean;
  activeCommentMode: 'pr' | 'task';
  uploadImage: T;
}): T | undefined {
  if (readOnly) return undefined;

  switch (activeCommentMode) {
    case 'pr':
    case 'task':
      return uploadImage;
  }
}
