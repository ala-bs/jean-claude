import { useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';



import { markDocumentStale, setDocumentResource } from '@/cache/cache-actions';
import { api } from '@/lib/api';
import type { CreateWorkItemVerificationNoteParams } from '@shared/work-item-verification-note-types';
import type { FeedItem } from '@shared/feed-types';
import { useCacheResource } from '@/cache/use-cache-resource';


function ingestFeedNotes(items: FeedItem[]) {
  setDocumentResource('feed:notes', items);
}

function markFeedNotesStale() {
  markDocumentStale('feed:notes');
}


export function useCreateFeedNote() {
  return useMutation({
    mutationFn: (params: { content: string }) => api.feed.createNote(params),
    onSuccess: markFeedNotesStale,
  });
}

export function useCreateWorkItemVerificationNote() {
  return useMutation({
    mutationFn: (params: CreateWorkItemVerificationNoteParams) =>
      api.feed.createWorkItemVerificationNote(params),
    onSuccess: markFeedNotesStale,
  });
}

export function useUpdateFeedNote() {
  return useMutation({
    mutationFn: (params: {
      id: string;
      content?: string;
      completedAt?: string | null;
    }) => api.feed.updateNote(params),
    onSuccess: markFeedNotesStale,
  });
}

/**
 * Returns a single feed note item by noteId, derived from the feed items query.
 */
export function useFeedNoteById(noteId: string) {
  const { data: items, isLoading } = useCacheResource({
    key: 'feed:notes',
    load: async () => api.feed.getNoteItems(),
    ingest: ingestFeedNotes,
    // Reuse feed list cache when note editor mounts. Explicitly stale notes
    // still refetch through useCacheResource's stale-resource effect.
    staleTime: Infinity,
  });

  const note = useMemo(
    () =>
      items?.find(
        (item): item is FeedItem & { noteId: string } =>
          item.source === 'note' && item.noteId === noteId,
      ),
    [items, noteId],
  );

  return { note, isLoading };
}

export function useDeleteFeedNote() {
  return useMutation({
    mutationFn: (params: { id: string }) => api.feed.deleteNote(params),
    onSuccess: markFeedNotesStale,
  });
}
