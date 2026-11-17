import { useI18n } from '../../i18n';
import { ModuleUpdateAction, useModuleUpdates } from '../../moduleUpdates';
import { type Notify, type Service, serviceMenuEntries, stopStartAction } from '../shared';
import { Panel, Toggle } from '../ui';
import { RowMenu } from './RowMenu';
import { StatusDot } from './StatusDot';

export function ServiceCard({
  service,
  onToggle,
  onAction,
  notify,
  busy = false,
  busyLabel,
  controlsDisabled = false,
}: {
  service: Service;
  onToggle: () => void;
  onAction: (service: Service, action: 'start' | 'stop' | 'restart') => void;
  notify: Notify;
  busy?: boolean;
  busyLabel?: string;
  // Disables start/stop (e.g. while the panel is stopped); other actions remain usable.
  controlsDisabled?: boolean;
}) {
  const { t } = useI18n();
  const updates = useModuleUpdates();
  const externallyBusy = busy;
  busy = busy || Boolean(updates.active[service.name]);
  const Icon = service.icon;
  const toggle = stopStartAction(service, t);
  const toggleDisabled = toggle.disabled || busy || updates.busy || controlsDisabled;

  return (
    <Panel className={`service-card ${busy ? 'busy' : ''}`} aria-busy={busy}>
      <div className="service-card-top">
        <div className="service-icon">
          <Icon size={18} />
        </div>
        <RowMenu
          entries={serviceMenuEntries(service, onAction, t, notify, busy || updates.busy, controlsDisabled)}
        />
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
        <Toggle
          checked={service.status === 'running'}
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
        </Toggle>
      </div>
      <ModuleUpdateAction name={service.name} disabled={externallyBusy} />
    </Panel>
  );
}
