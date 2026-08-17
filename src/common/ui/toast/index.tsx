import { CheckCircle2, CircleAlert, X } from 'lucide-react';
import clsx from 'clsx';


import { useToastStore } from '@/stores/toasts';

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed right-4 bottom-4 z-[60] flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.type === 'error' ? 'alert' : 'status'}
          className={clsx(
            'flex items-start gap-2 rounded-lg border px-4 py-3 shadow-lg backdrop-blur-sm',
            toast.type === 'error' &&
              'border-status-fail/40 bg-status-fail-soft text-ink-0',
            toast.type === 'success' &&
              'border-status-done/40 bg-status-done-soft text-ink-0',
          )}
        >
          {toast.type === 'error' ? (
            <CircleAlert className="text-status-fail mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <CheckCircle2 className="text-status-done mt-0.5 h-4 w-4 shrink-0" />
          )}
          <p className="text-sm">{toast.message}</p>
          <button
            onClick={() => removeToast(toast.id)}
            className="ml-2 shrink-0 rounded p-0.5 hover:bg-glass-medium"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
