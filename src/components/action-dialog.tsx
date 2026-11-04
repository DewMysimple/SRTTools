import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { errorText } from './common';

/** A pending write keeps the dialog and editable configuration intact on failure. */
export function ActionDialog({ title, children, confirmLabel, danger = false, onConfirm, onClose }: {
  title: string; children: ReactNode; confirmLabel: string; danger?: boolean;
  onConfirm: () => Promise<void> | void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="confirm-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); if (pending) return; setPending(true); setError(''); void Promise.resolve().then(onConfirm).then(onClose).catch(problem => setError(errorText(problem))).finally(() => setPending(false)); }}>
      <h2 id={titleId}>{title}</h2><div className="dialog-content">{children}</div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="button-row end"><button type="button" className="button secondary" disabled={pending} onClick={onClose}>取消</button><button type="submit" className={`button ${danger ? 'danger' : 'primary'}`} disabled={pending}>{pending ? '正在保存…' : confirmLabel}</button></div>
    </form>
  </dialog>;
}
