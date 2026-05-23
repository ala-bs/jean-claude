import { createFileRoute } from '@tanstack/react-router';

import { FeedNoteEditor } from '@/features/feed/ui-feed-note-editor';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

const FEED_NAVIGATION_DEBOUNCE_MS = 100;

export const Route = createFileRoute('/all/notes/$noteId')({
  component: AllNoteEditor,
});

function AllNoteEditor() {
  const { noteId } = Route.useParams();
  const debouncedNoteId = useDebouncedValue(
    noteId,
    FEED_NAVIGATION_DEBOUNCE_MS,
  );

  return <FeedNoteEditor key={debouncedNoteId} noteId={debouncedNoteId} />;
}
