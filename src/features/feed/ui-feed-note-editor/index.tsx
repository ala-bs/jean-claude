import '@blocknote/core/fonts/inter.css';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/mantine/style.css';
import { useCreateBlockNote } from '@blocknote/react';
import { useNavigate } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/common/ui/button';
import { IconButton } from '@/common/ui/icon-button';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import {
  useDeleteFeedNote,
  useFeedNoteById,
  useUpdateFeedNote,
} from '@/hooks/use-feed-notes';

export function FeedNoteEditor({ noteId }: { noteId: string }) {
  const navigate = useNavigate();
  const { note, isLoading } = useFeedNoteById(noteId);
  const updateNote = useUpdateFeedNote();
  const deleteNote = useDeleteFeedNote();
  const editor = useCreateBlockNote();

  const [value, setValue] = useState('');
  const [hasInitialized, setHasInitialized] = useState(false);
  const lastSavedRef = useRef('');
  const isDeletedRef = useRef(false);
  const isLoadingEditorRef = useRef(false);

  // Stable ref for mutate so cleanup effect doesn't re-fire every render
  const mutateRef = useRef(updateNote.mutate);
  mutateRef.current = updateNote.mutate;

  // Initialize value from note content
  useEffect(() => {
    if (note && !hasInitialized) {
      const content = note.noteContent ?? note.title;
      const blocks = JSON.parse(content) as Parameters<
        typeof editor.replaceBlocks
      >[1];

      isLoadingEditorRef.current = true;
      editor.replaceBlocks(editor.document, blocks);
      isLoadingEditorRef.current = false;
      setValue(content);
      lastSavedRef.current = content;
      setHasInitialized(true);
    }
  }, [editor, note, hasInitialized]);

  // Keep refs for unmount flush and auto-save
  const valueRef = useRef(value);
  valueRef.current = value;

  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;

  // Auto-save via debounced value
  const debouncedValue = useDebouncedValue(value, 500);

  useEffect(() => {
    if (!hasInitialized || isDeletedRef.current) return;
    if (debouncedValue && debouncedValue !== lastSavedRef.current) {
      lastSavedRef.current = debouncedValue;
      mutateRef.current({
        id: noteIdRef.current,
        content: debouncedValue,
      });
    }
  }, [debouncedValue, hasInitialized]);

  // Flush pending save on unmount only
  useEffect(() => {
    return () => {
      if (isDeletedRef.current) return;
      if (valueRef.current && valueRef.current !== lastSavedRef.current) {
        lastSavedRef.current = valueRef.current;
        mutateRef.current({
          id: noteIdRef.current,
          content: valueRef.current,
        });
      }
    };
  }, []);

  const handleEditorChange = useCallback(() => {
    if (isLoadingEditorRef.current) return;
    setValue(JSON.stringify(editor.document));
  }, [editor]);

  const handleDelete = useCallback(() => {
    isDeletedRef.current = true;
    deleteNote.mutate(
      { id: noteId },
      {
        onSuccess: () => {
          navigate({ to: '/all' });
        },
      },
    );
  }, [noteId, deleteNote, navigate]);

  const handleClose = useCallback(() => {
    navigate({ to: '/all' });
  }, [navigate]);

  if (isLoading) {
    return (
      <div className="text-ink-3 flex h-full w-full flex-1 items-center justify-center">
        Loading...
      </div>
    );
  }

  if (!note) {
    return (
      <div className="text-ink-3 flex h-full w-full flex-1 items-center justify-center">
        Note not found
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="border-line-soft flex shrink-0 items-center justify-between border-b px-4 py-3">
        <span className="text-ink-1 text-sm font-medium">Note</span>
        <div className="flex items-center gap-2">
          <Button variant="danger" size="sm" onClick={handleDelete}>
            Delete
          </Button>
          <IconButton
            variant="ghost"
            size="sm"
            onClick={handleClose}
            icon={<X />}
            tooltip="Close"
          />
        </div>
      </div>

      <div className="feed-note-blocknote flex-1 overflow-y-auto px-2 py-3">
        <BlockNoteView
          editor={editor}
          theme="dark"
          onChange={handleEditorChange}
          className="h-full"
        />
      </div>
    </div>
  );
}
