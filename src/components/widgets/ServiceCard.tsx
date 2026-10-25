import { useI18n } from '../../i18n';
import { ModuleUpdateAction, useModuleUpdates } from '../../moduleUpdates';
import { type Notify, type Service, serviceMenuEntries, stopStartAction } from '../shared';
import { RowMenu } from './RowMenu';
import { StatusDot } from './StatusDot';

export function ServiceCard({
  service,
  onToggle,
  onAction,
  notify,
  busy = false,
  busyLabel,
}: {
  service: Service;
  onToggle: () => void;
  onAction: (service: Service, action: 'start' | 'stop' | 'restart') => void;
  notify: Notify;
  busy?: boolean;
  busyLabel?: string;
}) {
  const { t } = useI18n();
  const updates = useModuleUpdates();
  const externallyBusy = busy;
  busy = busy || Boolean(updates.active[service.name]);
  const Icon = service.icon;
  const toggle = stopStartAction(service, t);
  const toggleDisabled = toggle.disabled || busy || updates.busy;

  return (
    <div className={`service-card ${busy ? 'busy' : ''}`} aria-busy={busy}>
      <div className="service-card-top">
        <div className="service-icon">
          <Icon size={18} />
        </div>
        <RowMenu entries={serviceMenuEntries(service, onAction, t, notify, busy || updates.busy)} />
      </div>
      <div className="service-title">
        <h4>{service.name}</h4>
        <StatusDot status={service.status} />
        {busy && <span className="service-card-busy">{busyLabel ?? t('services.pendingAction')}</span>}
      </div>
      <div className="service-detail">{t(service.detail)}</div>
      <div className="service-footer">
        <span>
          {updates.versions[service.name] ?? service.version} <i>·</i> {service.port}
        </span>
        <button
          type="button"
          className={`mini-toggle ${service.status === 'running' ? 'on' : ''} ${toggle.disabled ? 'unknown' : ''}`}
          disabled={toggleDisabled}
          onClick={() => {
            if (!toggleDisabled) onToggle();
          }}
          aria-label={t('services.toggleAria', { name: service.name })}
          title={busy ? (busyLabel ?? t('services.pendingAction')) : undefined}
        >
          <span />
        </button>
      </div>
      <ModuleUpdateAction name={service.name} disabled={externallyBusy} />
    </div>
  );
}
