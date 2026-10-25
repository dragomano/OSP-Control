import {
  Activity,
  ArrowUpRight,
  ChevronRight,
  Gauge,
  Globe2,
  Leaf,
  MoreHorizontal,
  Power,
  RefreshCw,
  Sparkles,
  Wifi,
} from 'lucide-react';
import { useState } from 'react';
import { localeTag, useI18n } from '../../i18n';
import { ModuleUpdateToolbar } from '../../moduleUpdates';
import type { OverviewMetrics } from '../../ospanel';
import { formatRam, type Notify, type Page, type Service, type SettingsTab } from '../shared';
import { buildActivityRows, logAliasesFromTranslator } from '../tables/Logs';
import { ActivityRow } from '../widgets/ActivityRow';
import { Metric } from '../widgets/Metric';
import { PageHeader } from '../widgets/PageHeader';
import { ServiceCard } from '../widgets/ServiceCard';

export function Overview({
  runningCount,
  services,
  userName,
  metrics,
  activityLines,
  onNavigate,
  onToggle,
  onAction,
  notify,
  onSync,
  panelRestarting = false,
  pendingServices,
}: {
  runningCount: number;
  services: Service[];
  userName: string;
  metrics: OverviewMetrics | null;
  activityLines: string[] | null;
  onNavigate: (page: Page, tab?: SettingsTab) => void;
  onToggle: (index: number) => void;
  onAction: (service: Service, action: 'start' | 'stop' | 'restart') => void;
  notify: Notify;
  onSync: () => Promise<boolean>;
  panelRestarting?: boolean;
  pendingServices?: ReadonlySet<string>;
}) {
  const { lang, t } = useI18n();
  const logAliases = logAliasesFromTranslator(t);
  const [syncing, setSyncing] = useState(false);
  const rawDate = new Date().toLocaleDateString(localeTag(lang), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const eyebrow = rawDate.charAt(0).toUpperCase() + rawDate.slice(1);
  // Recent events of the panel log: frame separators are dropped, error blocks
  // merged into a single entry; newest on top.
  const activityRows = buildActivityRows(activityLines ?? [], logAliases)
    .slice(-3)
    .reverse();

  return (
    <>
      <PageHeader
        eyebrow={eyebrow}
        heading={t('overview.greeting', { name: userName })}
        description={t('overview.subtitle')}
        action={
          <button
            type="button"
            className="primary-button"
            disabled={syncing}
            onClick={() => {
              setSyncing(true);
              void onSync()
                .then((success) => {
                  if (success) notify(t('overview.toastSynced'));
                })
                .finally(() => setSyncing(false));
            }}
          >
            <RefreshCw size={16} />
            {t('overview.sync')}
          </button>
        }
      />
      <ModuleUpdateToolbar />
      <section className="hero-panel">
        <div className="hero-copy">
          <div className="hero-kicker">
            <Sparkles size={14} />
            {t('overview.heroKicker')}
          </div>
          <h2>
            {t('overview.heroTitle')}
            <br />
            <span>{t('overview.heroTitleAccent')}</span>
          </h2>
          <p>{t('overview.heroText')}</p>
          <div className="hero-actions">
            <button type="button" className="hero-button" onClick={() => onNavigate('services')}>
              <Power size={16} />
              {t('overview.heroServices')}
            </button>
            <button type="button" className="ghost-button" onClick={() => onNavigate('projects')}>
              {t('overview.heroProjects')} <ArrowUpRight size={15} />
            </button>
          </div>
        </div>
        <div className="hero-orb">
          <div className="orb-ring ring-one" />
          <div className="orb-ring ring-two" />
          <div className="orb-center">
            <Leaf size={30} />
          </div>
        </div>
      </section>
      <div className="metrics-grid">
        <Metric
          icon={Activity}
          label={t('overview.metricsServices')}
          value={`${runningCount}/${services.length}`}
          trend={
            services.length > 0 && runningCount === services.length
              ? t('overview.metricsServicesTrend')
              : t('overview.metricsServicesPartial')
          }
          tone="green"
        />
        <Metric
          icon={Globe2}
          label={t('overview.metricsProjects')}
          value={metrics ? String(metrics.projectsTotal) : '—'}
          trend={t('overview.metricsProjectsTrend')}
          tone="blue"
        />
        <Metric
          icon={Gauge}
          label={t('overview.metricsRam')}
          value={formatRam(metrics?.ramBytes ?? 0)}
          trend={
            metrics && metrics.ramBytes > 0
              ? t('overview.metricsRamTrend')
              : t('overview.metricsRamUnavailable')
          }
          tone="purple"
        />
        <Metric
          icon={Wifi}
          label={t('overview.metricsPorts')}
          value={metrics && metrics.portsTotal > 0 ? `${metrics.portsOpen}/${metrics.portsTotal}` : '—'}
          trend={
            metrics && metrics.portProblems > 0
              ? t('overview.metricsPortsProblems', { n: metrics.portProblems })
              : t('overview.metricsPortsTrend')
          }
          tone={metrics && metrics.portProblems > 0 ? 'orange' : 'green'}
        />
      </div>
      <div className="section-heading">
        <div>
          <h3>{t('overview.quickTitle')}</h3>
          <span>{t('overview.quickSubtitle')}</span>
        </div>
        <button type="button" className="text-button" onClick={() => onNavigate('services')}>
          {t('overview.allServices')} <ChevronRight size={15} />
        </button>
      </div>
      <div className="service-grid">
        {services.map((service, index) => {
          const busy = panelRestarting || Boolean(pendingServices?.has(service.name));
          const busyLabel = panelRestarting
            ? t('services.restartingPanel')
            : busy
              ? t('services.pendingAction')
              : undefined;

          return (
            <ServiceCard
              key={service.name}
              service={service}
              onToggle={() => onToggle(index)}
              onAction={onAction}
              notify={notify}
              busy={busy}
              busyLabel={busyLabel}
            />
          );
        })}
      </div>
      <div className="lower-grid">
        <div className="activity-panel">
          <div className="panel-heading">
            <div>
              <h3>{t('overview.activity')}</h3>
              <span>{t('overview.activitySubtitle')}</span>
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={() => onNavigate('logs')}
              aria-label={t('overview.activityOpenLogs')}
              title={t('overview.activityOpenLogs')}
            >
              <MoreHorizontal size={17} />
            </button>
          </div>
          {activityLines === null ? null : activityRows.length === 0 ? (
            <p className="empty-note">{t('overview.activityEmpty')}</p>
          ) : (
            activityRows.map((row) => (
              <ActivityRow
                key={`${row.time}-${row.text}`}
                level={row.level}
                title={row.text}
                meta={row.time}
                status={
                  row.level === 'error'
                    ? t('overview.activityFailed')
                    : row.level === 'warning'
                      ? t('overview.activityAttention')
                      : t('overview.activityInfo')
                }
              />
            ))
          )}
        </div>
        <div className="tip-panel">
          <div className="tip-glow" />
          <Sparkles size={20} className="tip-icon" />
          <div>
            <span className="eyebrow">{t('overview.tipKicker')}</span>
            <h3>{t('overview.tipTitle')}</h3>
            <p>{t('overview.tipText')}</p>
            <button type="button" className="text-button" onClick={() => onNavigate('settings', 'autostart')}>
              {t('overview.tipSettings')} <ArrowUpRight size={15} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
