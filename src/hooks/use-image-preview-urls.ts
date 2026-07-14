import { useEffect, useMemo, useState } from 'react';
import { MAX_IMAGE_ATTACHMENT_BYTES } from '@shared/media-limits';
import type { PromptImagePart } from '@shared/agent-backend-types';

import { decodeBase64Chunks } from '@/lib/base64';
import { tagBlobPreviewUrl } from '@/lib/blob-preview-url';

const BASE64_CHUNK_SIZE = 64 * 1024;

function createRendererYieldController() {
  const pendingYields = new Map<ReturnType<typeof setTimeout>, () => void>();

  return {
    yieldToRenderer: () =>
      new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          pendingYields.delete(timeout);
          resolve();
        }, 0);
        pendingYields.set(timeout, resolve);
      }),
    cancel: () => {
      for (const [timeout, resolve] of pendingYields) {
        clearTimeout(timeout);
        resolve();
      }
      pendingYields.clear();
    },
  };
}

async function base64ToBlob(
  {
    data,
    mimeType,
    maxDecodedBytes,
    isCancelled,
    yieldToRenderer,
  }: {
    data: string;
    mimeType: string;
    isCancelled: () => boolean;
    yieldToRenderer: () => Promise<void>;
    maxDecodedBytes: number;
  },
): Promise<Blob | undefined> {
  const parts = await decodeBase64Chunks({
    data,
    maxDecodedBytes,
    chunkSize: BASE64_CHUNK_SIZE,
    isCancelled,
    yieldBetweenChunks: yieldToRenderer,
  });
  if (!parts) return undefined;
  return new Blob(parts, { type: mimeType });
}

export function useImagePreviewUrls(
  images: PromptImagePart[],
): (string | undefined)[] {
  const pendingUrls = useMemo(() => images.map(() => undefined), [images]);
  const [result, setResult] = useState<{
    images: PromptImagePart[];
    urls: (string | undefined)[];
  }>(() => ({ images, urls: pendingUrls }));

  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];
    const yieldController = createRendererYieldController();

    void Promise.all(
      images.map(async (image) => {
        try {
          const data = image.storageData ?? image.data;
          const mimeType = image.storageMimeType ?? image.mimeType;
          const blob = await base64ToBlob({
            data,
            mimeType,
            maxDecodedBytes:
              mimeType.split(';', 1)[0].trim().toLowerCase() === 'image/gif'
                ? Number.MAX_SAFE_INTEGER
                : MAX_IMAGE_ATTACHMENT_BYTES,
            isCancelled: () => cancelled,
            yieldToRenderer: yieldController.yieldToRenderer,
          });
          if (!blob || cancelled) return undefined;

          const url = URL.createObjectURL(blob);

          if (cancelled) {
            URL.revokeObjectURL(url);
            return undefined;
          }

          createdUrls.push(url);
          return tagBlobPreviewUrl(url, blob.type);
        } catch {
          return undefined;
        }
      }),
    ).then((urls) => {
      if (!cancelled) setResult({ images, urls });
    });

    return () => {
      cancelled = true;
      yieldController.cancel();
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [images]);

  return result.images === images ? result.urls : pendingUrls;
}
