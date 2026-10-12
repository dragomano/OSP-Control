import { useI18n } from '../../i18n';
import type { ServiceStatus } from '../../ospanel';
import { statusLabel } from '../shared';

export function StatusDot({ status }: { status: ServiceStatus }) {
  const { t } = useI18n();

  return <span className={`status-dot ${status}`} role="img" aria-label={statusLabel(status, t)} />;
}
