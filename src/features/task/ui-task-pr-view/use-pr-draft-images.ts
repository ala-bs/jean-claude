/* eslint-disable sort-imports */
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { getAttachmentFileName } from '@/lib/image-utils';
import { getImageDisplayWidth } from '@/lib/markdown-image-size';
import type { PrDraftImageRef } from '@/stores/navigation';
import type { PromptImagePart } from '@shared/agent-backend-types';
import { usePrDraftState } from '@/stores/navigation';

/** Stable empty reference: a fresh `[]` would retrigger every image effect. */
const EMPTY_IMAGES: PrDraftImage[] = [];

/** A draft image hydrated from disk, with the placeholder that anchors it. */
export type PrDraftImage = PromptImagePart & {
  token: string;
  placeholderMarkdown: string;
  /** Set when the backing file has gone (worktree deleted, manual cleanup). */
  missing?: boolean;
};

/**
 * PR drafts are long-lived, so attachments cannot live in React state the way
 * they do in the create-PR form. They are written to
 * `<worktreePath>/.jean-claude/tmp` (already in `ignoredPaths`, so they never
 * reach the task diff) and only their file refs are persisted in the draft.
 *
 * A single variant is stored per image rather than the agent+storage pair:
 * `getAzureAttachmentPayload` re-encodes whatever it gets at upload time, and
 * GIFs keep their original bytes so animation survives.
 */
export function usePrDraftImages({
  taskId,
  worktreePath,
}: {
  taskId: string;
  worktreePath: string | null;
}) {
  const { prDraft, setPrDraft } = usePrDraftState(taskId);
  const refs = prDraft?.images;
  const hydrationKey = JSON.stringify(refs?.map((ref) => ref.filePath) ?? []);

  // Refs are the source of truth; this is the hydrated cache, tagged with the
  // ref list it was built from. Deriving `images` from the tag (rather than
  // clearing state in an effect) keeps stale bytes from rendering for a frame
  // after the refs change.
  const [hydrated, setHydrated] = useState<{
    key: string;
    images: PrDraftImage[];
  }>({ key: '[]', images: EMPTY_IMAGES });
  const images = hydrated.key === hydrationKey ? hydrated.images : EMPTY_IMAGES;
  const isHydrating =
    hydrated.key !== hydrationKey && (refs?.length ?? 0) > 0;

  // Pasting several images at once fires concurrent `addImage` calls before any
  // re-render lands. Reading `refs` from the render closure would give each of
  // them the same base list, so they would allocate duplicate tokens and
  // overwrite each other's refs. This mirror is updated synchronously.
  const refsRef = useRef<PrDraftImageRef[]>(refs ?? []);
  useEffect(() => {
    // Merge by token rather than keeping only empty-filePath claims. Zustand
    // notifications for two concurrent writes can interleave, so a ref that is
    // already complete may not be in `refs` yet; dropping it here would free
    // its token and let a later paste allocate a duplicate.
    const next = refs ?? [];
    const known = new Set(next.map((ref) => ref.token));
    refsRef.current = [
      ...next,
      ...refsRef.current.filter((ref) => !known.has(ref.token)),
    ];
  }, [refs]);

  useEffect(() => {
    // Nothing to read: `images` already derives to empty for this key, so no
    // state update is needed (and none should cascade a render).
    if (!refs || refs.length === 0) return;

    let cancelled = false;

    void Promise.all(
      refs.map(async (ref): Promise<PrDraftImage> => {
        const placeholderMarkdown = buildPlaceholder(ref);
        const base: PrDraftImage = {
          type: 'image',
          data: '',
          mimeType: ref.mimeType,
          filename: ref.filename,
          width: ref.width,
          height: ref.height,
          sizeBytes: ref.sizeBytes,
          token: ref.token,
          placeholderMarkdown,
        };
        try {
          const dataUrl = await api.fs.readImageAsDataUrl(ref.filePath);
          const data = dataUrl?.split(',')[1];
          if (!data) return { ...base, missing: true };
          return {
            ...base,
            data,
            // GIF bytes are the untouched original; flag them as storage bytes
            // so the Azure payload path keeps the animation intact.
            ...(ref.mimeType === 'image/gif'
              ? { storageData: data, storageMimeType: 'image/gif' }
              : {}),
          };
        } catch {
          return { ...base, missing: true };
        }
      }),
    ).then((loaded) => {
      if (!cancelled) setHydrated({ key: hydrationKey, images: loaded });
    });

    return () => {
      cancelled = true;
    };
  }, [hydrationKey, refs]);

  /**
   * Persist a freshly staged image and return the placeholder to insert.
   * Returns null when the write failed, so the caller leaves the description
   * untouched rather than inserting a placeholder with no backing file.
   */
  const addImage = useCallback(
    async (image: PromptImagePart): Promise<string | null> => {
      if (!worktreePath) return null;

      // Token must be unique across the draft's lifetime, including previous
      // sessions, so derive it from the existing refs rather than a counter.
      const used = new Set(refsRef.current.map((ref) => ref.token));
      let token = 1;
      while (used.has(String(token))) token += 1;
      // Claim the token synchronously so a concurrent call cannot pick it too.
      const claimed: PrDraftImageRef = {
        token: String(token),
        filePath: '',
        filename: '',
        mimeType: '',
      };
      refsRef.current = [...refsRef.current, claimed];

      // GIFs keep the untouched original; everything else stores the compressed
      // agent variant, whose extension must match its actual bytes.
      const useStorage = image.storageMimeType === 'image/gif';
      const data = useStorage ? (image.storageData ?? image.data) : image.data;
      const mimeType = useStorage ? 'image/gif' : image.mimeType;
      const filename = getAttachmentFileName(
        image.filename || `image-${token}.png`,
        mimeType,
      );

      let filePath: string;
      try {
        filePath = await api.fs.writeAttachmentFile(
          worktreePath,
          filename,
          data,
          'base64',
        );
      } catch (error) {
        // Release the claimed token so the next attempt can reuse it.
        refsRef.current = refsRef.current.filter(
          (candidate) => candidate !== claimed,
        );
        throw error;
      }

      // The user can remove an image while its write is still in flight. The
      // claim is then gone, and inserting a placeholder for it would leave an
      // unresolvable `jc-image://` link plus an orphaned file on disk.
      if (!refsRef.current.includes(claimed)) {
        void api.fs.deleteAttachmentFile(worktreePath, filePath).catch(() => {});
        return null;
      }

      const ref: PrDraftImageRef = {
        ...claimed,
        filePath,
        filename,
        mimeType,
        width: image.width,
        height: image.height,
        sizeBytes: image.sizeBytes,
      };
      refsRef.current = refsRef.current.map((candidate) =>
        candidate === claimed ? ref : candidate,
      );
      // Only fully-written refs reach the store; a concurrent sibling still
      // mid-write keeps its placeholder in the mirror and lands on its own.
      setPrDraft({
        images: refsRef.current.filter((candidate) => candidate.filePath),
      });
      return buildPlaceholder(ref);
    },
    [setPrDraft, worktreePath],
  );

  const removeImage = useCallback(
    (token: string) => {
      const ref = refsRef.current.find(
        (candidate) => candidate.token === token,
      );
      refsRef.current = refsRef.current.filter(
        (candidate) => candidate.token !== token,
      );
      setPrDraft({
        images: refsRef.current.filter((candidate) => candidate.filePath),
      });
      if (ref?.filePath && worktreePath) {
        // Best-effort: an orphaned tmp file is harmless (it is git-ignored and
        // dies with the worktree), so never block the UI on this.
        void api.fs
          .deleteAttachmentFile(worktreePath, ref.filePath)
          .catch(() => {});
      }
    },
    [setPrDraft, worktreePath],
  );

  /**
   * Reclaim the backing files for the given tokens. Scoped to specific tokens
   * rather than "all" so a partly-failed PR upload keeps the images it could
   * not publish -- the draft is their only remaining copy.
   */
  const deleteImageFiles = useCallback(
    async (tokens: string[]) => {
      if (!worktreePath || tokens.length === 0) return;
      const wanted = new Set(tokens);
      await Promise.all(
        refsRef.current
          .filter((ref) => wanted.has(ref.token) && ref.filePath)
          .map((ref) =>
            api.fs
              .deleteAttachmentFile(worktreePath, ref.filePath)
              .catch(() => {}),
          ),
      );
    },
    [worktreePath],
  );

  return { images, isHydrating, addImage, removeImage, deleteImageFiles };
}

function buildPlaceholder(ref: PrDraftImageRef): string {
  const safeAltText = ref.filename.replace(/[[\]()\\]/g, '_');
  const size =
    ref.width && ref.height
      ? ` =${getImageDisplayWidth(ref.width, ref.height)}x`
      : '';
  return `![${safeAltText}](jc-image://${ref.token}${size})`;
}
