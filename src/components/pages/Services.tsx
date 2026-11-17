import { ChevronDown, ChevronRight, Layers, RefreshCw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { ModuleUpdateAction, ModuleUpdateToolbar, useModuleUpdates } from '../../moduleUpdates';
import {
  type Notify,
  SERVICE_GROUPS,
  type Service,
  type ServiceGroupId,
  type ServiceGroupView,
  serviceGroupSummary,
  serviceMenuEntries,
  statusLabel,
  stopStartAction,
} from '../shared';
import { Actions, Badge, Button, Notice, Panel, StatusBadge } from '../ui';
import { PageHeader } from '../widgets/PageHeader';
import { RowMenu } from '../widgets/RowMenu';
import { StatusDot } from '../widgets/StatusDot';

export function Services({
  services,
  onToggle,
  onAction,
  notify,
  onSync,
  onRestartAll,
  panelRestarting = false,
  pendingServices,
  onProfiles,
  panelOnline = true,
}: {
  services: Service[];
  onToggle: (index: number) => void;
  onAction: (service: Service, action: 'start' | 'stop' | 'restart') => void;
  notify: Notify;
  onSync: () => Promise<boolean>;
  onRestartAll: () => Promise<void>;
  // The panel restart lives in App: the lock has to survive leaving this page, so a service
  // command cannot be sent to a panel that is still starting.
  panelRestarting?: boolean;
  pendingServices?: ReadonlySet<string>;
  onProfiles?: (service: Service) => void;
  // When the panel is stopped, module start/stop is disabled.
  panelOnline?: boolean;
}) {
  const { t } = useI18n();
  const updates = useModuleUpdates();
  const [filter, setFilter] = useState<'all' | ServiceGroupId>('all');
  const [syncing, setSyncing] = useState(false);
  const [restartingAll, setRestartingAll] = useState(false);
  const [collapsed, setCollapsed] = useState<Partial<Record<ServiceGroupId, boolean>>>({});
  // A service is busy either because its own command is running or because the panel restarts.
  const isBusy = (name: string) =>
    panelRestarting || Boolean(updates.active[name]) || Boolean(pendingServices?.has(name));
  // With the panel stopped, module start/stop is unavailable.
  const controlsDisabled = !panelOnline;
  // Indices are positions in the overall services array: onToggle/onAction work with them.
  const items = services.map((service, index) => ({ service, index }));
  // Groups with at least one service: the declared sections plus the leftovers in "other".
  // The "other" group is a named constant so its id keeps the ServiceGroupId type.
  const otherGroup: ServiceGroupView = {
    id: 'other',
    label: t('services.group.other'),
    items: items.filter(({ service }) => !SERVICE_GROUPS.some((group) => group.kinds.includes(service.kind))),
  };
  const visibleGroups: ServiceGroupView[] = [
    ...SERVICE_GROUPS.map((group) => ({
      id: group.id,
      label: t(`services.group.${group.id}`),
      items: items.filter(({ service }) => group.kinds.includes(service.kind)),
    })),
    otherGroup,
  ].filter((group) => group.items.length > 0);
  const selectFilter = (id: 'all' | ServiceGroupId) => {
    setFilter(id);

    if (id !== 'all') setCollapsed((current) => ({ ...current, [id]: false }));
  };

  return (
    <>
      <PageHeader
        eyebrow={t('nav.workspace')}
        heading={t('nav.services')}
        description={t('services.subtitle')}
        action={
          <Button
            variant="primary"
            type="button"
            className="primary-button"
            disabled={restartingAll || panelRestarting || updates.busy || controlsDisabled}
            onClick={() => {
              setRestartingAll(true);
              void onRestartAll().finally(() => setRestartingAll(false));
            }}
          >
            <RefreshCw size={16} className={panelRestarting ? 'spin' : undefined} />
            {panelRestarting ? t('services.restartingPanel') : t('services.restartAll')}
          </Button>
        }
      />
      <ModuleUpdateToolbar />
      <Notice className="notice">
        <ShieldCheck size={18} />
        <div>
          <b>{t('services.synced')}</b>
          <span>{t('services.syncedNote')}</span>
        </div>
        <Button
          variant="ghost"
          type="button"
          className="text-button"
          disabled={syncing}
          onClick={() => {
            setSyncing(true);
            void onSync()
              .then((success) => {
                if (success) notify(t('services.toastChecked'));
              })
              .finally(() => setSyncing(false));
          }}
        >
          {t('services.checkAgain')}
        </Button>
      </Notice>
      {visibleGroups.length > 0 && (
        <div className="service-filter">
          <Button
            selected={Boolean(filter === 'all')}
            variant="ghost"
            type="button"
            className={`filter-chip ${filter === 'all' ? 'active' : ''}`}
            onClick={() => selectFilter('all')}
          >
            {t('services.filterAll')}
            <span className="filter-chip-count">{services.length}</span>
          </Button>
          {visibleGroups.map((group) => (
            <Button
              selected={Boolean(filter === group.id)}
              variant="ghost"
              type="button"
              key={group.id}
              className={`filter-chip ${filter === group.id ? 'active' : ''}`}
              onClick={() => selectFilter(group.id)}
            >
              {group.label}
              <span className="filter-chip-count">{group.items.length}</span>
            </Button>
          ))}
        </div>
      )}
      {visibleGroups
        .filter((group) => filter === 'all' || filter === group.id)
        .map((group) => {
          const isCollapsed = Boolean(collapsed[group.id]);
          const summary = serviceGroupSummary(group.items, t);
          return (
            <section className="service-group" key={group.id}>
              <Button
                variant="ghost"
                type="button"
                className="service-group-head"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((current) => ({ ...current, [group.id]: !isCollapsed }))}
              >
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span className="service-group-name">{group.label}</span>
                <span className="service-group-count">{group.items.length}</span>
                <span className={`service-group-summary ${summary.tone}`}>{summary.text}</span>
              </Button>
              {!isCollapsed && (
                <div className="service-list">
                  {group.items.map(({ service, index }) => {
                    const toggle = stopStartAction(service, t);
                    const busy = isBusy(service.name);
                    const toggleDisabled = toggle.disabled || busy || updates.busy || controlsDisabled;
                    const profileName = service.profile || t('common.unknown');
                    const profilesLabel = t('profiles.open', { name: service.name, profile: profileName });

                    return (
                      <Panel
                        className={`service-row ${busy ? 'busy' : ''}`}
                        aria-busy={busy}
                        key={service.name}
                      >
                        <div className="service-row-icon">
                          <service.icon size={19} />
                        </div>
                        <div className="service-row-main">
                          <div>
                            <h3>{service.name}</h3>
                            <span>{t(service.detail)}</span>
                          </div>
                          <div className="service-meta">
                            <b>{updates.versions[service.name] ?? service.version}</b>
                            <span>{service.port}</span>
                          </div>
                          <StatusBadge
                            tone={
                              service.status === 'running'
                                ? 'success'
                                : service.status === 'warning'
                                  ? 'warning'
                                  : 'default'
                            }
                            className="service-state"
                          >
                            <StatusDot status={service.status} />
                            {statusLabel(service.status, t)}
                            {busy && (
                              <Badge className="service-busy-badge">
                                {t(panelRestarting ? 'services.restartingPanel' : 'services.pendingAction')}
                              </Badge>
                            )}
                          </StatusBadge>
                          <Actions className="row-actions">
                            {onProfiles && (
                              <Button
                                type="button"
                                className="secondary-button profiles-trigger"
                                disabled={busy || updates.busy}
                                onClick={() => onProfiles(service)}
                                aria-label={profilesLabel}
                                title={profilesLabel}
                              >
                                <Layers size={14} />
                                <span className="profiles-trigger-name">{profileName}</span>
                                <ChevronDown size={12} />
                              </Button>
                            )}
                            <Button
                              type="button"
                              className="secondary-button"
                              disabled={toggleDisabled}
                              title={
                                busy
                                  ? t(panelRestarting ? 'services.restartingPanel' : 'services.pendingAction')
                                  : undefined
                              }
                              onClick={() => {
                                if (!toggleDisabled) onToggle(index);
                              }}
                            >
                              <toggle.icon size={14} className={busy ? 'spin' : undefined} />
                              {busy && !panelRestarting ? t('services.pendingAction') : toggle.label}
                            </Button>
                            <RowMenu
                              entries={serviceMenuEntries(
                                service,
                                onAction,
                                t,
                                notify,
                                busy || updates.busy,
                                controlsDisabled,
                              )}
                            />
                          </Actions>
                        </div>
                        <ModuleUpdateAction
                          name={service.name}
                          disabled={panelRestarting || Boolean(pendingServices?.has(service.name))}
                        />
                      </Panel>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      {visibleGroups.length === 0 && <div className="service-list" />}
    </>
  );
}
