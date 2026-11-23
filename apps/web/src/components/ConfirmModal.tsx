import { useState, useCallback } from 'react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!open) return null;

  const variantStyles = {
    danger: {
      icon: '⚠️',
      iconBg: 'bg-destructive/20 border-destructive/40',
      confirmBtn:
        'bg-destructive hover:bg-destructive/80 text-white shadow-lg shadow-destructive/20',
    },
    warning: {
      icon: '⚡',
      iconBg: 'bg-amber-500/20 border-amber-500/40',
      confirmBtn:
        'bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-500/20',
    },
    default: {
      icon: '❓',
      iconBg: 'bg-primary/20 border-primary/40',
      confirmBtn: 'btn-primary',
    },
  };

  const v = variantStyles[variant];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md animate-fade-in">
      <div className="card max-w-md w-full mx-4 p-0 border border-border shadow-2xl overflow-hidden">
        {/* Header accent bar */}
        <div
          className={`h-1 w-full ${
            variant === 'danger'
              ? 'bg-gradient-to-r from-destructive/80 to-red-500/60'
              : variant === 'warning'
                ? 'bg-gradient-to-r from-amber-500/80 to-orange-500/60'
                : 'bg-gradient-to-r from-primary/80 to-blue-500/60'
          }`}
        />

        <div className="p-6">
          {/* Icon + Title */}
          <div className="flex items-start gap-4">
            <div
              className={`shrink-0 w-10 h-10 rounded-xl border flex items-center justify-center text-lg ${v.iconBg}`}
            >
              {v.icon}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-bold text-foreground">{title}</h3>
              <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
                {message}
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="grid grid-cols-2 sm:flex sm:items-center sm:justify-end gap-2.5 mt-6 pt-4 border-t border-border/60">
            <button
              onClick={onCancel}
              className="btn btn-secondary text-xs py-2 px-4 font-medium"
            >
              {cancelLabel}
            </button>
            <button
              onClick={onConfirm}
              className={`btn text-xs py-2 px-5 font-bold cursor-pointer transition-all ${v.confirmBtn}`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Hook that replaces window.confirm() with a themed modal.
 * Usage:
 *   const { confirm, ConfirmDialog } = useConfirm();
 *   // In handler: const ok = await confirm({ title, message, variant });
 *   // In JSX:     {ConfirmDialog}
 */
export function useConfirm() {
  const [state, setState] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    variant?: 'danger' | 'warning' | 'default';
    resolve?: (value: boolean) => void;
  }>({ open: false, title: '', message: '' });

  const confirm = useCallback(
    (opts: {
      title: string;
      message: string;
      confirmLabel?: string;
      variant?: 'danger' | 'warning' | 'default';
    }): Promise<boolean> => {
      return new Promise((resolve) => {
        setState({ ...opts, open: true, resolve });
      });
    },
    [],
  );

  const handleConfirm = useCallback(() => {
    state.resolve?.(true);
    setState((s) => ({ ...s, open: false }));
  }, [state.resolve]);

  const handleCancel = useCallback(() => {
    state.resolve?.(false);
    setState((s) => ({ ...s, open: false }));
  }, [state.resolve]);

  const ConfirmDialog = (
    <ConfirmModal
      open={state.open}
      title={state.title}
      message={state.message}
      confirmLabel={state.confirmLabel}
      variant={state.variant}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );

  return { confirm, ConfirmDialog };
}
