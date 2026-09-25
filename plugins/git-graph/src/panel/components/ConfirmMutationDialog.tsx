import { useEffect, useRef } from 'react';
import type { MutationIntent, Translate } from '../domain/index.js';
type Confirmation = Pick<MutationIntent, 'title' | 'message'>;
export function ConfirmMutationDialog({ intent, t, onConfirm, onCancel, confirmLabel }: { intent: Confirmation | null; t: Translate; onConfirm(): void; onCancel(): void; confirmLabel?: string }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (intent) { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; cancel.current?.focus(); }
    else previousFocus.current?.focus();
  }, [intent]);
  useEffect(() => {
    if (!intent) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [intent, onCancel]);
  if (!intent) return null;
  return <div className="git-confirm-backdrop"><section className="git-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="git-confirm-title"><h2 id="git-confirm-title">{intent.title}</h2><p>{intent.message}</p><button ref={cancel} type="button" onClick={onCancel}>{t('workspace.cancel')}</button><button type="button" onClick={onConfirm}>{confirmLabel ?? t('workspace.confirm')}</button></section></div>;
}
