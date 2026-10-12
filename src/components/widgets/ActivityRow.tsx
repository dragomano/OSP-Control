import { AlertTriangle, Info, OctagonAlert } from 'lucide-react';
import type { ActivityEntry } from '../shared';

// Log event level → row icon and status labels.
const ACTIVITY_ICONS: Record<ActivityEntry['level'], typeof Info> = {
  info: Info,
  warning: AlertTriangle,
  error: OctagonAlert,
};

export function ActivityRow({
  level,
  title,
  meta,
  status,
}: {
  level: ActivityEntry['level'];
  title: string;
  meta: string;
  status: string;
}) {
  const Icon = ACTIVITY_ICONS[level];

  return (
    <div className="activity-row">
      <div className={`activity-icon ${level !== 'info' ? level : ''}`} aria-hidden="true">
        <Icon size={15} />
      </div>
      <div className="activity-copy">
        <b>{title}</b>
        <span>{meta}</span>
      </div>
      <span
        className={`activity-status ${level !== 'info' ? level : ''}`}
        role="img"
        aria-label={status}
        title={status}
      >
        <Icon size={13} />
      </span>
    </div>
  );
}
