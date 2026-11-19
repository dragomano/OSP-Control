import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { Button } from '../ui';
import './cornerNotice.css';

export function CornerNotice({
  icon,
  title,
  description,
  action,
  onClose,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action: ReactNode;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="corner-notice">
      <div className="corner-notice-icon" aria-hidden="true">
        {icon}
      </div>
      <div className="corner-notice-text" role="status">
        <b>{title}</b>
        <span>{description}</span>
      </div>
      {action}
      <Button
        type="button"
        variant="ghost"
        square
        className="icon-button"
        aria-label={t('common.close')}
        onClick={onClose}
      >
        <X size={16} />
      </Button>
    </div>
  );
}
