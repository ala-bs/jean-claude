import clsx from 'clsx';
import { Copy, Terminal, Trash2, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import {
  resolveSnippetTemplate,
  type SnippetVariableContext,
} from '@/lib/resolve-snippet-template';
import { HandlebarsEditor } from '@/common/ui/handlebars-editor';
import { isBuiltinSnippet } from '@/lib/builtin-snippets';
import type { PromptSnippet } from '@shared/types';
import { Switch } from '@/common/ui/switch';



const VARIABLE_GROUPS = [
  {
    group: 'project',
    items: [
      { name: 'project.name', desc: 'Project name' },
      { name: 'project.path', desc: 'Worktree root' },
    ],
  },
  {
    group: 'task',
    items: [
      { name: 'task.name', desc: 'Task title' },
      { name: 'task.note', desc: 'Author note' },
      { name: 'task.sourceBranch', desc: 'Source branch' },
      { name: 'task.branchName', desc: 'Working branch' },
      { name: 'task.worktreePath', desc: 'Worktree path' },
    ],
  },
  {
    group: 'workItems',
    items: [
      { name: 'this.id', desc: 'inside #each' },
      { name: 'this.title', desc: 'inside #each' },
      { name: 'this.description', desc: 'inside #each' },
      { name: 'this.comments', desc: 'inside #each' },
      { name: 'this.testCases', desc: 'inside #each' },
    ],
  },
  {
    group: 'helpers',
    items: [
      { name: '#each', desc: 'Loop over collection' },
      { name: '#if', desc: 'Conditional' },
    ],
  },
];

const PREVIEW_CONTEXT: SnippetVariableContext = {
  project: { name: 'my-project', path: '~/code/my-project' },
  task: {
    name: 'example task',
    note: 'implementation notes here',
    sourceBranch: 'main',
    branchName: 'jean-claude/example-task',
    worktreePath: '~/code/my-project/.worktrees/example',
  },
  workItems: [
    {
      id: '12345',
      title: 'Example work item',
      description: 'Implement the feature',
      testCases: [
        {
          id: '99001',
          title: 'Verify feature works end-to-end',
          steps: [
            {
              action: 'Open the app',
              expectedResult: 'App loads successfully',
            },
            { action: 'Click the button', expectedResult: 'Action completes' },
          ],
        },
        {
          id: '99002',
          title: 'Verify no regressions',
        },
      ],
    },
  ],
};

function FieldLabel({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="mb-1.5 flex items-baseline gap-2">
      <span className="text-ink-1 text-[11px] font-medium tracking-wide uppercase">
        {label}
      </span>
      {hint && <span className="text-ink-3 text-[10.5px]">{hint}</span>}
    </div>
  );
}

function ContextToggle({
  on,
  label,
  onClick,
  disabled,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'inline-flex items-center gap-[7px] rounded-[5px] border py-[5px] pr-2.5 pl-2 text-[11.5px] font-medium disabled:opacity-50',
        on
          ? 'bg-acc-soft border-acc-line text-acc'
          : 'bg-glass-subtle border-glass-border text-ink-2',
      )}
    >
      <span
        className={clsx(
          'inline-flex h-3 w-3 items-center justify-center rounded-[3px]',
          on ? 'bg-acc text-on-acc' : 'border-line border-[1.5px] bg-transparent',
        )}
      >
        {on && (
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </span>
      {label}
    </button>
  );
}

function SlugChip({
  slug,
  primary,
  onRemove,
}: {
  slug: string;
  primary?: boolean;
  onRemove?: () => void;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded px-[7px] py-[3px] font-mono text-[11.5px]',
        primary
          ? 'bg-acc-soft border-acc-line text-acc border'
          : 'bg-glass-light border-glass-border text-ink-2 border',
      )}
    >
      /{slug}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] opacity-50 hover:opacity-100"
        >
          <X size={9} strokeWidth={2.2} />
        </button>
      )}
    </span>
  );
}

function VarTree() {
  return (
    <div className="flex flex-col gap-2.5">
      {VARIABLE_GROUPS.map((g) => (
        <div key={g.group}>
          <div
            className="text-ink-3 mb-1 flex items-center gap-1.5 font-mono text-[9.5px] font-semibold tracking-[1px] uppercase"
          >
            <span className="text-acc">●</span>
            {g.group}
          </div>
          <div className="flex flex-col gap-px">
            {g.items.map((v) => (
              <div
                key={v.name}
                className="hover:bg-glass-subtle flex items-baseline gap-2 rounded px-1.5 py-1 font-mono text-[11px] transition-colors"
              >
                <span className="text-acc shrink-0 whitespace-nowrap">
                  {v.name}
                </span>
                <span className="text-ink-3 truncate text-[10.5px]">
                  {v.desc}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SnippetDetail({
  snippet,
  onUpdate,
  onDelete,
  onDuplicate,
}: {
  snippet: PromptSnippet;
  onUpdate: (updates: Partial<Omit<PromptSnippet, 'id'>>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const isBuiltin = isBuiltinSnippet(snippet.id);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [slugInput, setSlugInput] = useState('');

  const previewResult = useMemo(
    () => resolveSnippetTemplate(snippet.template, PREVIEW_CONTEXT),
    [snippet.template],
  );

  const handleAddSlug = useCallback(() => {
    const slug = slugInput
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');
    if (slug && !snippet.autocomplete.slugs.includes(slug)) {
      onUpdate({
        autocomplete: {
          ...snippet.autocomplete,
          slugs: [...snippet.autocomplete.slugs, slug],
        },
      });
    }
    setSlugInput('');
  }, [slugInput, snippet.autocomplete, onUpdate]);

  const handleRemoveSlug = useCallback(
    (slug: string) => {
      onUpdate({
        autocomplete: {
          ...snippet.autocomplete,
          slugs: snippet.autocomplete.slugs.filter((s) => s !== slug),
        },
      });
    },
    [snippet.autocomplete, onUpdate],
  );

  return (
    <div className="bg-bg-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex min-w-0 flex-col gap-[18px] p-6">
        {/* Header */}
        <div className="flex items-start gap-3.5">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2.5">
              <Terminal size={15} className="text-acc shrink-0" />
              <div className="text-ink-0 text-lg font-semibold tracking-tight">
                {snippet.name || 'Untitled snippet'}
              </div>
              {isBuiltin && (
                <span className="bg-glass-light text-ink-3 rounded px-[7px] py-0.5 font-mono text-[10px] tracking-wider uppercase">
                  built-in
                </span>
              )}
            </div>
            <div className="text-ink-2 text-[12.5px]">
              {snippet.description || 'No description'}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={onDuplicate}
              className="text-ink-3 hover:bg-glass-subtle rounded p-1.5 transition-colors"
              title="Duplicate"
            >
              <Copy size={14} />
            </button>
            {!isBuiltin &&
              (confirmingDelete ? (
                <button
                  type="button"
                  onClick={() => {
                    onDelete();
                    setConfirmingDelete(false);
                  }}
                  onBlur={() => setConfirmingDelete(false)}
                  className="bg-status-fail-soft text-status-fail border-status-fail/30 rounded border px-2 py-1 text-xs font-medium"
                  autoFocus
                >
                  Delete?
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="text-ink-3 hover:text-status-fail hover:bg-status-fail/10 rounded p-1.5 transition-colors"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              ))}
            <Switch
              checked={snippet.enabled}
              onChange={() => onUpdate({ enabled: !snippet.enabled })}
              label="Enabled"
            />
          </div>
        </div>

        {/* Name + Description */}
        {!isBuiltin && (
          <div className="grid grid-cols-2 gap-3.5">
            <div>
              <FieldLabel label="Name" />
              <input
                type="text"
                value={snippet.name}
                onChange={(e) => onUpdate({ name: e.target.value })}
                placeholder="My Snippet"
                aria-label="Snippet name"
                className="border-glass-border bg-bg-1 text-ink-0 placeholder:text-ink-3 w-full rounded-md border px-2.5 py-[7px] text-sm focus:outline-none"
              />
            </div>
            <div>
              <FieldLabel
                label="Description"
                hint="One line, helps you remember"
              />
              <input
                type="text"
                value={snippet.description}
                onChange={(e) => onUpdate({ description: e.target.value })}
                placeholder="Short description"
                aria-label="Snippet description"
                className="border-glass-border bg-bg-1 text-ink-0 placeholder:text-ink-3 w-full rounded-md border px-2.5 py-[7px] text-sm focus:outline-none"
              />
            </div>
          </div>
        )}

        {/* Template + Variables */}
        <div
          className="grid min-w-0 items-start gap-3.5"
          style={{ gridTemplateColumns: 'minmax(0, 1fr) 220px' }}
        >
          <div className="min-w-0">
            <FieldLabel
              label="Template"
              hint={
                isBuiltin
                  ? undefined
                  : 'Handlebars syntax — type {{ to insert a variable'
              }
            />
            <div className="border-glass-border bg-code-bg min-w-0 overflow-visible rounded-[7px] border">
              {isBuiltin ? (
                <pre className="text-ink-0 overflow-auto p-3 font-mono text-xs leading-relaxed">
                  {snippet.template}
                </pre>
              ) : (
                <HandlebarsEditor
                  value={snippet.template}
                  onChange={(val) => onUpdate({ template: val })}
                  placeholder="Review changes on branch {{task.branchName}}..."
                  minHeight="140px"
                  maxHeight="300px"
                />
              )}
            </div>
          </div>

          <div>
            <FieldLabel label="Variables" hint="reference" />
            <div
              className="border-glass-border bg-bg-1 overflow-auto rounded-[7px] border p-2.5"
              style={{ maxHeight: 280 }}
            >
              <VarTree />
            </div>
          </div>
        </div>

        {/* Live Preview */}
        <div>
          <FieldLabel label="Preview" hint="Rendered against sample context" />
          <div className="border-glass-border bg-bg-1 text-ink-0 rounded-[7px] border p-3.5 text-[13px] leading-relaxed whitespace-pre-wrap">
            {previewResult.ok
              ? previewResult.output
              : `⚠ ${previewResult.error}`}
          </div>
        </div>

        {/* Availability + Slugs */}
        <div className="grid grid-cols-2 gap-3.5">
          <div>
            <FieldLabel
              label="Available in"
              hint="Where this snippet appears"
            />
            <div className="flex flex-wrap gap-1.5">
              <ContextToggle
                on={snippet.contexts.newTask}
                label="New task"
                disabled={isBuiltin}
                onClick={() =>
                  onUpdate({
                    contexts: {
                      ...snippet.contexts,
                      newTask: !snippet.contexts.newTask,
                    },
                  })
                }
              />
              <ContextToggle
                on={snippet.contexts.newTaskStep}
                label="New task step"
                disabled={isBuiltin}
                onClick={() =>
                  onUpdate({
                    contexts: {
                      ...snippet.contexts,
                      newTaskStep: !snippet.contexts.newTaskStep,
                    },
                  })
                }
              />
            </div>
          </div>
          <div>
            <FieldLabel label="Slash commands" hint="Trigger with /" />
            <div className="flex flex-wrap items-center gap-1.5">
              {snippet.autocomplete.slugs.map((slug, i) => (
                <SlugChip
                  key={slug}
                  slug={slug}
                  primary={i === 0}
                  onRemove={
                    !isBuiltin ? () => handleRemoveSlug(slug) : undefined
                  }
                />
              ))}
              {!isBuiltin && (
                <input
                  value={slugInput}
                  onChange={(e) => setSlugInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddSlug();
                    }
                  }}
                  onBlur={handleAddSlug}
                  placeholder="+ add"
                  className="border-glass-border text-ink-3 placeholder:text-ink-4 w-[70px] rounded border border-dashed bg-transparent px-2 py-0.5 font-mono text-[11px] focus:outline-none"
                />
              )}
            </div>
          </div>
        </div>

        {/* Autocomplete toggle */}
        {!isBuiltin && (
          <div>
            <FieldLabel label="Autocomplete" />
            <Switch
              checked={snippet.autocomplete.enabled}
              onChange={() =>
                onUpdate({
                  autocomplete: {
                    ...snippet.autocomplete,
                    enabled: !snippet.autocomplete.enabled,
                  },
                })
              }
              label="Show in / autocomplete"
            />
          </div>
        )}
      </div>
    </div>
  );
}
