import { useId, useMemo, useState } from 'react';
import { Shield } from 'lucide-react';

import { buildBashSuggestions } from '@shared/permission-suggestions';
import { Modal } from '@/common/ui/modal';

export type PermissionPartScope = 'session' | 'project' | 'worktree' | 'global';

const SCOPE_LABELS: Record<
  PermissionPartScope,
  { title: string; hint: string }
> = {
  session: { title: 'Session', hint: 'Current step only.' },
  project: { title: 'Project', hint: 'All sessions in this project.' },
  worktree: { title: 'Worktree', hint: 'All worktrees for this project.' },
  global: { title: 'Global', hint: 'All projects.' },
};

/**
 * Edit a single command part into a permission rule pattern before granting it.
 *
 * The permission bar shows compound bash commands split into parts; each part
 * is evaluated on its own, so each part needs its own rule. This modal lets the
 * user widen a part (e.g. replace an argument with `*`) and pick the scope the
 * rule is written to.
 */
export function PermissionPartModal({
  isOpen,
  onClose,
  part,
  scopes,
  onGrant,
}: {
  isOpen: boolean;
  onClose: () => void;
  part: string;
  /** Scopes that can actually be written from this permission bar. */
  scopes: PermissionPartScope[];
  onGrant: (args: {
    pattern: string;
    scope: PermissionPartScope;
  }) => Promise<void>;
}) {
  const formId = useId();
  const defaultScope: PermissionPartScope = scopes.includes('project')
    ? 'project'
    : (scopes[0] ?? 'session');
  const [pattern, setPattern] = useState(part);
  const [scope, setScope] = useState<PermissionPartScope>(defaultScope);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestions = useMemo(() => {
    const built = buildBashSuggestions(part).map((s) => s.pattern);
    return [...new Set([part, ...built])];
  }, [part]);

  const trimmed = pattern.trim();

  const handleSubmit = async () => {
    if (!trimmed) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await onGrant({ pattern: trimmed, scope });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add permission');
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Allow command part"
      ariaLabel="Allow command part"
      size="lg"
    >
      <div className="space-y-4">
        <div>
          <label
            htmlFor={`${formId}-pattern`}
            className="text-ink-2 mb-2 block text-xs font-medium"
          >
            Rule pattern
          </label>
          <input
            id={`${formId}-pattern`}
            type="text"
            value={pattern}
            autoFocus
            spellCheck={false}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && trimmed && !isSubmitting) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            className="border-glass-border bg-bg-0 text-ink-1 focus:border-acc-line focus:ring-acc/30 w-full rounded border px-2.5 py-1.5 font-mono text-xs focus:ring-1 focus:outline-none"
          />
          <p className="text-ink-3 mt-1 text-[11px]">
            Use <code className="text-ink-2">*</code> to widen the rule, e.g.{' '}
            <code className="text-ink-2">git log *</code>.
          </p>
          {suggestions.length > 1 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-ink-3">Presets:</span>
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setPattern(suggestion)}
                  className={`rounded border px-1.5 py-0.5 font-mono ${
                    suggestion === pattern
                      ? 'border-purple-400/60 text-ink-1 bg-purple-500/15'
                      : 'border-glass-border text-ink-2 hover:text-ink-1 bg-black/20 hover:border-purple-400/60'
                  }`}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
        </div>

        <fieldset>
          <legend className="text-ink-2 mb-2 text-xs font-medium">Scope</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {scopes.map((value) => (
              <label
                key={value}
                className="border-glass-border bg-bg-0/35 flex cursor-pointer items-start gap-2 rounded border px-2.5 py-2"
              >
                <input
                  type="radio"
                  name={`${formId}-scope`}
                  value={value}
                  checked={scope === value}
                  onChange={() => setScope(value)}
                  className="border-glass-border bg-glass-medium text-acc focus:ring-acc/30 mt-0.5 h-3.5 w-3.5"
                />
                <span>
                  <span className="text-ink-1 block text-sm">
                    {SCOPE_LABELS[value].title}
                  </span>
                  <span className="text-ink-3 block text-[11px]">
                    {SCOPE_LABELS[value].hint}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {scope !== 'session' && (
            <p className="text-status-run mt-2 text-[11px] leading-relaxed">
              Persistent Bash permissions can apply broadly. Keep patterns
              specific.
            </p>
          )}
        </fieldset>

        {error && <p className="text-status-fail text-xs">{error}</p>}

        <div className="border-glass-border flex items-center justify-end gap-2 border-t pt-4">
          <button
            onClick={onClose}
            className="text-ink-2 hover:bg-glass-medium hover:text-ink-1 rounded px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={!trimmed || isSubmitting}
            className="bg-acc hover:bg-acc flex items-center gap-1.5 rounded px-3 py-1.5 text-on-acc text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Shield className="h-3.5 w-3.5" />
            {isSubmitting ? 'Allowing…' : 'Allow part'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
