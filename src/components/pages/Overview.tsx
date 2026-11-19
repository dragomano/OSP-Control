import {
  Activity,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Globe2,
  Leaf,
  MoreHorizontal,
  Power,
  RefreshCw,
  Sparkles,
  Unplug,
  Wifi,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { localeTag, useI18n } from '../../i18n';
import { ModuleUpdateToolbar } from '../../moduleUpdates';
import type { OverviewMetrics } from '../../ospanel';
import { formatRam, type Notify, type Page, type Service, type SettingsTab } from '../shared';
import { buildActivityRows, logAliasesFromTranslator } from '../tables/Logs';
import { Button, Panel } from '../ui';
import { ActivityRow } from '../widgets/ActivityRow';
import { Metric } from '../widgets/Metric';
import { PageHeader } from '../widgets/PageHeader';
import { ServiceCard } from '../widgets/ServiceCard';

type OverviewTip = {
  titleKey: string;
  textKey: string;
  action: 'settings' | 'services' | 'projects' | 'logs' | 'documentation';
  actionKey: string;
  documentationTopic?: string;
};

const OVERVIEW_TIPS: OverviewTip[] = [
  {
    titleKey: 'overview.tipTitle',
    textKey: 'overview.tipText',
    action: 'settings',
    actionKey: 'overview.tipSettings',
  },
  {
    titleKey: 'overview.tipSsdTitle',
    textKey: 'overview.tipSsdText',
    action: 'documentation',
    actionKey: 'overview.tipDocumentation',
    documentationTopic: 'installation',
  },
  {
    titleKey: 'overview.tipSysprepTitle',
    textKey: 'overview.tipSysprepText',
    action: 'documentation',
    actionKey: 'overview.tipDocumentation',
    documentationTopic: 'sysprep',
  },
  {
    titleKey: 'overview.tipVpnTitle',
    textKey: 'overview.tipVpnText',
    action: 'documentation',
    actionKey: 'overview.tipDocumentation',
    documentationTopic: 'vpn',
  },
  {
    titleKey: 'overview.tipProjectTitle',
    textKey: 'overview.tipProjectText',
    action: 'projects',
    actionKey: 'overview.tipProjects',
  },
  {
    titleKey: 'overview.tipModulesTitle',
    textKey: 'overview.tipModulesText',
    action: 'services',
    actionKey: 'overview.tipServices',
  },
  {
    titleKey: 'overview.tipSslTitle',
    textKey: 'overview.tipSslText',
    action: 'documentation',
    actionKey: 'overview.tipDocumentation',
    documentationTopic: 'ssl',
  },
  {
    titleKey: 'overview.tipCliTitle',
    textKey: 'overview.tipCliText',
    action: 'documentation',
    actionKey: 'overview.tipDocumentation',
    documentationTopic: 'projectsCli',
  },
  {
    titleKey: 'overview.tipTasksTitle',
    textKey: 'overview.tipTasksText',
    action: 'projects',
    actionKey: 'overview.tipProjects',
  },
  {
    titleKey: 'overview.tipDatabaseTitle',
    textKey: 'overview.tipDatabaseText',
    action: 'documentation',
    actionKey: 'overview.tipDocumentation',
    documentationTopic: 'modules',
  },
  {
    titleKey: 'overview.tipXdebugTitle',
    textKey: 'overview.tipXdebugText',
    action: 'documentation',
    actionKey: 'overview.tipDocumentation',
    documentationTopic: 'xdebug',
  },
  {
    titleKey: 'overview.tipLogsTitle',
    textKey: 'overview.tipLogsText',
    action: 'logs',
    actionKey: 'overview.tipLogs',
  },
];

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
  onOpenDocumentation,
  panelRestarting = false,
  pendingServices,
  panelOnline = true,
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
  onOpenDocumentation: (topic?: string) => void;
  panelRestarting?: boolean;
  pendingServices?: ReadonlySet<string>;
  // When the panel is stopped, module start/stop is disabled.
  panelOnline?: boolean;
}) {
  const { lang, t } = useI18n();
  const logAliases = logAliasesFromTranslator(t);
  const [syncing, setSyncing] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * OVERVIEW_TIPS.length));
  const [tipKeyboard, setTipKeyboard] = useState(false);
  const prevTipRef = useRef<HTMLButtonElement>(null);
  const nextTipRef = useRef<HTMLButtonElement>(null);
  const tip = OVERVIEW_TIPS[tipIndex];
  const stepTip = (step: number) =>
    setTipIndex((index) => (index + step + OVERVIEW_TIPS.length) % OVERVIEW_TIPS.length);

  useEffect(() => {
    const updateTime = () => setNow(new Date());
    const timer = window.setInterval(updateTime, 60_000);
    window.addEventListener('focus', updateTime);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', updateTime);
    };
  }, []);

  const hour = now.getHours();
  const greetingKey =
    hour >= 5 && hour < 12
      ? 'overview.greetingMorning'
      : hour >= 12 && hour < 18
        ? 'overview.greeting'
        : 'overview.greetingEvening';
  const rawDate = now.toLocaleDateString(localeTag(lang), {
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
        heading={t(greetingKey, { name: userName })}
        description={t('overview.subtitle')}
        action={
          <Button
            variant="primary"
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
          </Button>
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
            <span>{t(panelOnline ? 'overview.heroTitleAccent' : 'overview.heroTitleAccentOffline')}</span>
          </h2>
          <p>{t(panelOnline ? 'overview.heroText' : 'overview.heroTextOffline')}</p>
          <div className="hero-actions">
            <Button
              variant="primary"
              type="button"
              className="hero-button"
              onClick={() => onNavigate('services')}
            >
              <Power size={16} />
              {t('overview.heroServices')}
            </Button>
            <Button
              variant="ghost"
              type="button"
              className="ghost-button"
              onClick={() => onNavigate('projects')}
            >
              {t('overview.heroProjects')} <ArrowUpRight size={15} />
            </Button>
          </div>
        </div>
        <div className={`hero-orb${panelOnline ? '' : ' offline'}`}>
          <div className="orb-ring ring-one" />
          <div className="orb-ring ring-two" />
          <div className="orb-center">{panelOnline ? <Leaf size={30} /> : <Unplug size={30} />}</div>
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
        <Button variant="ghost" type="button" className="text-button" onClick={() => onNavigate('services')}>
          {t('overview.allServices')} <ChevronRight size={15} />
        </Button>
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
              controlsDisabled={!panelOnline}
            />
          );
        })}
      </div>
      <div className="lower-grid">
        <Panel className="activity-panel">
          <div className="panel-heading">
            <div>
              <h3>{t('overview.activity')}</h3>
              <span>{t('overview.activitySubtitle')}</span>
            </div>
            <Button
              variant="ghost"
              square
              type="button"
              className="icon-button"
              onClick={() => onNavigate('logs')}
              aria-label={t('overview.activityOpenLogs')}
              title={t('overview.activityOpenLogs')}
            >
              <MoreHorizontal size={17} />
            </Button>
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
        </Panel>
        <Panel
          className="tip-panel"
          // Keyboard switching stays off until an arrow button is used, so arrow
          // keys keep their usual meaning (e.g. scrolling) for users who never
          // interact with the tip navigation.
          onKeyDown={(event) => {
            if (!tipKeyboard) return;
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            event.preventDefault();
            const arrow = event.key === 'ArrowLeft' ? prevTipRef.current : nextTipRef.current;
            // The outline follows the direction so keyboard switching shows its effect
            // on the arrow the user would have clicked.
            arrow?.focus({ preventScroll: true });
            stepTip(event.key === 'ArrowLeft' ? -1 : 1);
          }}
        >
          <div className="tip-glow" />
          <Sparkles size={20} className="tip-icon" />
          <div>
            <span className="eyebrow">{t('overview.tipKicker')}</span>
            <h3>{t(tip.titleKey)}</h3>
            <p>{t(tip.textKey)}</p>
            <div className="tip-actions">
              <Button
                variant="ghost"
                type="button"
                className="text-button"
                onClick={() => {
                  if (tip.action === 'settings') onNavigate('settings', 'general');
                  else if (tip.action === 'services') onNavigate('services');
                  else if (tip.action === 'projects') onNavigate('projects');
                  else if (tip.action === 'logs') onNavigate('logs');
                  else onOpenDocumentation(tip.documentationTopic);
                }}
              >
                {t(tip.actionKey)} <ArrowUpRight size={15} />
              </Button>
              <div className="join">
                <Button
                  ref={prevTipRef}
                  variant="ghost"
                  square
                  type="button"
                  className="join-item"
                  aria-label={t('overview.tipPrev')}
                  title={t('overview.tipPrev')}
                  onClick={() => {
                    setTipKeyboard(true);
                    stepTip(-1);
                  }}
                >
                  <ChevronLeft size={15} />
                </Button>
                <Button
                  ref={nextTipRef}
                  variant="ghost"
                  square
                  type="button"
                  className="join-item"
                  aria-label={t('overview.tipNext')}
                  title={t('overview.tipNext')}
                  onClick={() => {
                    setTipKeyboard(true);
                    stepTip(1);
                  }}
                >
                  <ChevronRight size={15} />
                </Button>
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
