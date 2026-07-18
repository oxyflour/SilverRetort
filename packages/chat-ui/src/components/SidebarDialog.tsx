import type { ReactNode } from "react";

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        className={`w-full space-y-4 rounded-lg bg-white p-4 shadow-xl dark:bg-neutral-900 ${
          wide ? "max-w-lg" : "max-w-sm"
        }`}
      >
        <h2 className="font-medium">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function DialogActions({
  onCancel,
  onConfirm,
  confirmLabel,
  disabled = false,
  danger = false,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex justify-end gap-2">
      <button
        onClick={onCancel}
        className="rounded px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        Cancel
      </button>
      <button
        disabled={disabled}
        onClick={onConfirm}
        className={`rounded px-3 py-1.5 text-sm text-white disabled:opacity-40 ${
          danger
            ? "bg-red-600 hover:bg-red-700"
            : "bg-neutral-900 hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
        }`}
      >
        {confirmLabel}
      </button>
    </div>
  );
}
