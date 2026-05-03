import { Pencil, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useRegisterKeyboardBindings } from '@/common/context/keyboard-bindings';
import { formatLineRangeLabel } from '@/stores/utils-comment-store';

// ---------------------------------------------------------------------------
// Shared styling constants for inline comment UI
// ---------------------------------------------------------------------------

export const COMMENT_ACCENT = {
  bg: 'color-mix(in oklch, oklch(0.78 0.18 295) 8%, transparent)',
  bgLight: 'color-mix(in oklch, oklch(0.78 0.18 295) 6%, transparent)',
  border: 'oklch(0.78 0.18 295 / 0.15)',
  borderStrong: 'oklch(0.78 0.18 295 / 0.2)',
  bar: 'oklch(0.78 0.18 295)',
  barSoft: 'oklch(0.78 0.18 295 / 0.5)',
  text: 'oklch(0.65 0.15 295)',
  chipBg: 'color-mix(in oklch, oklch(0.78 0.18 295) 18%, transparent)',
  chipText: 'oklch(0.78 0.18 295)',
};

// ---------------------------------------------------------------------------
// InlineCommentComposer — shared comment input form
// ---------------------------------------------------------------------------

export function InlineCommentComposer({
  lineStart,
  lineEnd,
  onSubmit,
  onCancel,
  renderBeforeTextarea,
  renderAfterActions,
  placeholder = 'Add a comment...',
  submitLabel = 'Add comment',
  canSubmitEmpty = false,
  initialBody = '',
}: {
  lineStart: number;
  lineEnd?: number;
  onSubmit: (body: string) => void;
  onCancel: () => void;
  /** Rendered between the line label and the textarea (e.g. preset chips). */
  renderBeforeTextarea?: ReactNode;
  /** Rendered after the action buttons (e.g. hint text). */
  renderAfterActions?: ReactNode;
  placeholder?: string;
  submitLabel?: string;
  /**
   * When true the submit button is enabled even if the body is empty.
   * Useful when the parent tracks additional state (e.g. selected presets)
   * that makes an empty body valid.
   */
  canSubmitEmpty?: boolean;
  /** Initial body text (for editing existing comments). */
  initialBody?: string;
}) {
  const [body, setBody] = useState(initialBody);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bindingId = useId();

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const lineLabel = formatLineRangeLabel(lineStart, lineEnd);

  const handleSubmit = useCallback(() => {
    const trimmed = body.trim();
    if (!trimmed && !canSubmitEmpty) return;
    onSubmit(trimmed);
  }, [body, canSubmitEmpty, onSubmit]);

  // Register cmd+enter and escape at the top of the keyboard binding stack.
  // Because the LIFO stack checks most-recently-registered first, these
  // bindings take priority over the overlay's cmd+enter while this component
  // is mounted. Each handler only fires when the composer textarea is focused.
  useRegisterKeyboardBindings(`inline-comment-composer-${bindingId}`, {
    'cmd+enter': () => {
      if (document.activeElement !== textareaRef.current) return false;
      handleSubmit();
      return true;
    },
    escape: () => {
      if (document.activeElement !== textareaRef.current) return false;
      onCancel();
      return true;
    },
  });

  const isDisabled = !body.trim() && !canSubmitEmpty;

  return (
    <div className="flex flex-col gap-2">
      <span
        className="font-mono text-[10px]"
        style={{ color: COMMENT_ACCENT.text }}
      >
        {lineLabel}
      </span>

      {renderBeforeTextarea}

      <textarea
        ref={textareaRef}
        className="bg-bg-2 text-ink-1 border-stroke-1 min-h-[60px] w-full resize-y rounded border px-2 py-1.5 text-xs focus:outline-none"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
      />

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="bg-acc text-acc-ink inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
          onClick={handleSubmit}
          disabled={isDisabled}
        >
          {submitLabel}
          <kbd className="rounded bg-white/20 px-1 py-px font-mono text-[9px]">
            {'\u2318\u21B5'}
          </kbd>
        </button>
        <button
          type="button"
          className="text-ink-3 hover:text-ink-1 rounded px-2 py-1 text-xs"
          onClick={onCancel}
        >
          Cancel
        </button>
        {renderAfterActions}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlineCommentBubble — shared comment display
// ---------------------------------------------------------------------------

export function InlineCommentBubble({
  lineStart,
  lineEnd,
  body,
  onRemove,
  onEdit,
  renderHeaderExtras,
  renderExtraActions,
  renderFooter,
}: {
  lineStart: number;
  lineEnd?: number;
  body: string;
  onRemove?: () => void;
  /** Called with the new body text when the user saves an edit. */
  onEdit?: (newBody: string) => void;
  /** Extra elements in the header row (e.g. status pill, preset tags). */
  renderHeaderExtras?: ReactNode;
  /** Extra action buttons rendered alongside the default edit/remove buttons. */
  renderExtraActions?: ReactNode;
  /** Rendered below the body (e.g. agent response note). */
  renderFooter?: ReactNode;
}) {
  const lineLabel = formatLineRangeLabel(lineStart, lineEnd);
  const [isEditing, setIsEditing] = useState(false);
  const [editBody, setEditBody] = useState(body);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const bindingId = useId();

  const startEditing = useCallback(() => {
    setEditBody(body);
    setIsEditing(true);
  }, [body]);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
    setEditBody(body);
  }, [body]);

  const saveEdit = useCallback(() => {
    const trimmed = editBody.trim();
    if (!trimmed || trimmed === body) {
      cancelEditing();
      return;
    }
    onEdit?.(trimmed);
    setIsEditing(false);
  }, [editBody, body, onEdit, cancelEditing]);

  // Focus textarea when entering edit mode
  useEffect(() => {
    if (isEditing) {
      editTextareaRef.current?.focus();
    }
  }, [isEditing]);

  // Keyboard bindings for edit mode
  useRegisterKeyboardBindings(
    `inline-comment-edit-${bindingId}`,
    isEditing
      ? {
          'cmd+enter': () => {
            if (document.activeElement !== editTextareaRef.current)
              return false;
            saveEdit();
            return true;
          },
          escape: () => {
            if (document.activeElement !== editTextareaRef.current)
              return false;
            cancelEditing();
            return true;
          },
        }
      : {},
  );

  return (
    <div className="group flex items-start gap-2 rounded px-3 py-1.5">
      <div
        className="mt-1 h-3 w-0.5 shrink-0 rounded-full"
        style={{ background: COMMENT_ACCENT.bar }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className="mr-2 font-mono text-[10px]"
            style={{ color: COMMENT_ACCENT.text }}
          >
            {lineLabel}
          </span>
          {renderHeaderExtras}
          <div className="flex-1" />
          {!isEditing && (onEdit || onRemove || renderExtraActions) && (
            <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              {onEdit && (
                <button
                  type="button"
                  aria-label="Edit comment"
                  className="text-ink-4 hover:text-ink-1 mt-0.5 shrink-0"
                  onClick={startEditing}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  aria-label="Remove comment"
                  className="text-ink-4 hover:text-ink-1 mt-0.5 shrink-0"
                  onClick={onRemove}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
              {renderExtraActions}
            </div>
          )}
        </div>
        {isEditing ? (
          <div className="flex flex-col gap-1.5">
            <textarea
              ref={editTextareaRef}
              className="bg-bg-2 text-ink-1 border-stroke-1 min-h-[48px] w-full resize-y rounded border px-2 py-1.5 text-xs focus:outline-none"
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="bg-acc text-acc-ink inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
                onClick={saveEdit}
                disabled={!editBody.trim() || editBody.trim() === body}
              >
                Save
                <kbd className="rounded bg-white/20 px-1 py-px font-mono text-[9px]">
                  {'\u2318\u21B5'}
                </kbd>
              </button>
              <button
                type="button"
                className="text-ink-3 hover:text-ink-1 rounded px-2 py-1 text-xs"
                onClick={cancelEditing}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="text-ink-0 text-xs whitespace-pre-wrap">{body}</div>
        )}
        {renderFooter}
      </div>
    </div>
  );
}
