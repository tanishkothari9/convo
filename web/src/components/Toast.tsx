import { useEffect, useState } from "react";

export interface ToastMessage {
  id: number;
  text: string;
  tone: "ok" | "danger";
}

let nextId = 1;

export function useToast() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const show = (text: string, tone: ToastMessage["tone"] = "ok") => {
    const id = nextId++;
    setToasts((current) => [...current, { id, text, tone }]);
    setTimeout(
      () => setToasts((current) => current.filter((t) => t.id !== id)),
      3800,
    );
  };

  return { toasts, show };
}

export function Toaster({ toasts }: { toasts: ToastMessage[] }) {
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function Toast({ toast }: { toast: ToastMessage }) {
  // Enters and exits along the same path, so the motion reads as one object
  // arriving and leaving rather than two effects.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className={`toast toast-${toast.tone}`} data-mounted={mounted}>
      {toast.text}
    </div>
  );
}
