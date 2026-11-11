import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { type ConfirmRequest, registerConfirmHost } from '../../ospanel';
import { useDismiss } from '../shared';

// The single in-app confirmation dialog for every askConfirm() caller, mounted once
// in App. It replaces the native Windows message box: same question, OK/Cancel and
// focused OK button, but no system sound (the native warning icon always beeps).
// Questions arriving while a dialog is already open queue up and are shown in order.
export function ConfirmDialog() {
  const { t } = useI18n();
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);
  const windowRef = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef<ConfirmRequest[]>([]);

  useEffect(() => {
    pendingRef.current = [];
    registerConfirmHost((request) => {
      pendingRef.current = [...pendingRef.current, request];
      setQueue(pendingRef.current);
    });
    return () => {
      // Decline everything still open so callers never wait on an unmounted dialog.
      for (const request of pendingRef.current) request.resolve(false);
      pendingRef.current = [];
      registerConfirmHost(null);
    };
  }, []);

  const request = queue[0];
  const settle = (confirmed: boolean) => {
    if (!request) return;
    pendingRef.current = pendingRef.current.filter((item) => item !== request);
    setQueue(pendingRef.current);
    request.resolve(confirmed);
  };

  // The replaced native box also starts with OK focused, so Enter still confirms.
  useEffect(() => {
    if (request) okRef.current?.focus();
  }, [request]);

  // Outside click and Escape both decline, like dismissing the native box.
  useDismiss(windowRef, () => settle(false), Boolean(request));

  if (!request) return null;

  return (
    <div className="modal-overlay">
      <div
        className="modal-window confirm-window"
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        ref={windowRef}
        onKeyDown={(event) => {
          // Tab cycle between the two buttons, as in the other modal dialogs;
          // Enter is handled by the focused button itself.
          if (event.key !== 'Tab') return;
          const controls = windowRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)');
          if (!controls?.length) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && event.target === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && event.target === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="confirm-row">
          <AlertTriangle size={22} className="confirm-icon" aria-hidden="true" />
          <div>
            <h3 className="modal-title">{request.title}</h3>
            <p className="confirm-message">{request.message}</p>
          </div>
        </div>
        <div className="modal-foot confirm-foot">
          <button type="button" className="secondary-button" onClick={() => settle(false)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="primary-button" ref={okRef} onClick={() => settle(true)}>
            {t('common.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
