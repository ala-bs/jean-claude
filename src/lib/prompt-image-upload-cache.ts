import type { PromptImagePart } from '@shared/agent-backend-types';

type UploadCacheEntry = {
  data: string;
  mimeType: string;
  storageData: string | undefined;
  storageMimeType: string | undefined;
  fileName: string;
} & ({ pending: Promise<string>; url?: never } | { pending?: never; url: string });

function matchesSnapshot(
  entry: UploadCacheEntry,
  image: PromptImagePart,
  fileName: string,
) {
  return (
    entry.data === image.data &&
    entry.mimeType === image.mimeType &&
    entry.storageData === image.storageData &&
    entry.storageMimeType === image.storageMimeType &&
    entry.fileName === fileName
  );
}

export type PromptImageUploadCache = ReturnType<
  typeof createPromptImageUploadCache
>;

export function createPromptImageUploadCache() {
  let entries = new WeakMap<PromptImagePart, UploadCacheEntry>();

  return {
    resolve({
      image,
      fileName,
      upload,
    }: {
      image: PromptImagePart;
      fileName: string;
      upload: () => Promise<string>;
    }) {
      const cached = entries.get(image);
      if (cached && matchesSnapshot(cached, image, fileName)) {
        return cached.pending ?? Promise.resolve(cached.url);
      }

      entries.delete(image);
      const snapshot = {
        data: image.data,
        mimeType: image.mimeType,
        storageData: image.storageData,
        storageMimeType: image.storageMimeType,
        fileName,
      };
      let uploadPromise: Promise<string>;
      try {
        uploadPromise = upload();
      } catch (error) {
        return Promise.reject(error);
      }

      let pendingEntry: UploadCacheEntry;
      const pending = uploadPromise.then(
        (url) => {
          if (entries.get(image) === pendingEntry) {
            entries.set(image, { ...snapshot, url });
          }
          return url;
        },
        (error: unknown) => {
          if (entries.get(image) === pendingEntry) {
            entries.delete(image);
          }
          throw error;
        },
      );
      pendingEntry = { ...snapshot, pending };
      entries.set(image, pendingEntry);
      return pending;
    },
    delete(image: PromptImagePart) {
      entries.delete(image);
    },
    clear() {
      entries = new WeakMap();
    },
  };
}
