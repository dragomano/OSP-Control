import { Eraser, Files, FileText, X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { useI18n } from '../../i18n';
import { useDismiss } from '../shared';

export function ClearLogsDialog({
  source,
  count,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  source: string | null;
  count: number;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const windowRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const all = source === null;
  const Icon = all ? Files : FileText;

  useDismiss(windowRef, onClose, !busy);
  useEffect(() => {
    const previousFocus = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <div className="modal-overlay">
      <div
        className="modal-window log-clear-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        ref={windowRef}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const buttons = windowRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
          if (!buttons?.length) {
            event.preventDefault();
            return;
          }
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="modal-head">
          <div className="log-clear-heading">
            <Eraser size={19} />
            <h3 className="modal-title" id={titleId}>
              {t(all ? 'logs.clearAllTitle' : 'logs.clearCurrentTitle')}
            </h3>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={busy}
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>
        <p className="modal-hint" id={descriptionId}>
          {t(all ? 'logs.clearAllDescription' : 'logs.clearCurrentDescription')}
        </p>
        <div className="log-clear-target">
          <Icon size={18} />
          <div>
            <strong>{all ? t('logs.allLogs') : source}</strong>
            <span>{all ? t('logs.clearFileCount', { count }) : `logs/${source}`}</span>
          </div>
        </div>
        <p className="modal-hint">{t('logs.clearNote')}</p>
        {error && (
          <p className="log-clear-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-foot log-clear-foot">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={busy}
            ref={cancelRef}
          >
            {t('logs.cancel')}
          </button>
          <button
            type="button"
            className="primary-button log-clear-confirm"
            onClick={onConfirm}
            disabled={busy}
          >
            <Eraser size={15} />
            {t(busy ? 'logs.clearing' : all ? 'logs.clearAll' : 'logs.clearCurrent')}
          </button>
        </div>
      </div>
    </div>
  );
}
