import type { Activity } from 'lucide-react';

export function Metric({
  icon: Icon,
  label,
  value,
  trend,
  tone,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  trend: string;
  tone: 'green' | 'blue' | 'purple' | 'orange';
}) {
  return (
    <div className="metric-card">
      <div className={`metric-icon ${tone}`}>
        <Icon size={18} />
      </div>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className={`metric-trend ${tone}`}>{trend}</div>
    </div>
  );
}
