import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastApi {
  toast: (message: string, kind?: ToastKind) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, kind: ToastKind = "info") => {
      const id = ++seq;
      setItems((prev) => [...prev.slice(-4), { id, message, kind }]);
      // Longer dwell for multi-sentence guidance (e.g. tour dismiss hint)
      const ms = message.length > 72 ? 7200 : 3800;
      window.setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      success: (m) => toast(m, "success"),
      error: (m) => toast(m, "error"),
      info: (m) => toast(m, "info"),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-viewport" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role="status">
            <span className="toast-icon" aria-hidden>
              {t.kind === "success" ? "✓" : t.kind === "error" ? "!" : "i"}
            </span>
            <div className="toast-msg">{t.message}</div>
            <button type="button" className="close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return {
      toast: () => undefined,
      success: () => undefined,
      error: () => undefined,
      info: () => undefined,
    };
  }
  return ctx;
}
