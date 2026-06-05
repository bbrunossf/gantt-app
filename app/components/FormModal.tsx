import { useEffect, useRef, type ReactNode } from "react";

interface FormModalProps {
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
  loading?: boolean;
  error?: string | null;
  children: ReactNode;
}

export default function FormModal({
  title,
  onCancel,
  onConfirm,
  confirmLabel = "Salvar",
  loading = false,
  error = null,
  children,
}: FormModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Fecha com Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Foca o modal ao abrir
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div className="modal" ref={dialogRef} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id="modal-title">
            {title}
          </h2>
          <button
            className="modal-close"
            onClick={onCancel}
            type="button"
            aria-label="Fechar"
          >
            ✕
          </button>
        </header>

        <div className="modal-body">{children}</div>

        {error && (
          <p className="modal-error" role="alert">
            {error}
          </p>
        )}

        <footer className="modal-footer">
          <button
            className="btn btn-ghost"
            onClick={onCancel}
            type="button"
            disabled={loading}
          >
            Cancelar
          </button>
          <button
            className="btn btn-primary"
            onClick={onConfirm}
            type="button"
            disabled={loading}
          >
            {loading ? "Salvando…" : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
