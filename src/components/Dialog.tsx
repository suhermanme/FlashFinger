import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from './Button.js';
export interface DialogProps { open: boolean; title: string; children: ReactNode; onClose(): void; actions?: ReactNode }
export function Dialog({ open, title, children, onClose, actions }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = `ff-dialog-${useId().replace(/:/g, '')}`;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open]);
  return <dialog ref={ref} className="ff-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <h2 id={titleId}>{title}</h2>{children}<div className="ff-dialog-actions">{actions}<Button onClick={onClose}>Close</Button></div>
  </dialog>;
}
