import {
  AlertTriangle,
  ArrowDownWideNarrow,
  ArrowUpRight,
  ChevronDown,
  Clock3,
  Code2,
  Copy,
  FolderOpen,
  Globe2,
  Network,
  Search,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { errorText, localeTag, useI18n } from '../../i18n';
import {
  type CreatedProject,
  type EditorInfo,
  isEngineUnset,
  listEditors,
  type OsPanelProject,
  openInBrowser,
  openInEditor,
  openProjectFolder,
} from '../../ospanel';
import { CreateProjectDialog } from '../dialogs/CreateProjectDialog';
import { ProjectModulesDialog } from '../dialogs/ProjectModulesDialog';
import { copyText, type Notify } from '../shared';
import { FilterFacet, facetValues } from '../widgets/FilterFacet';
import { PageHeader } from '../widgets/PageHeader';
import { RowMenu } from '../widgets/RowMenu';
import { activityDate, groupProjectActivity, useProjectActivity } from './projectActivity';

export function Projects({
  projects,
  allProjects,
  query,
  setQuery,
  notify,
  onProjectCreated,
  onProjectDeleted,
  onToggleSsl,
  onRestartPanel,
}: {
  projects: OsPanelProject[];
  allProjects: OsPanelProject[];
  query: string;
  setQuery: (value: string) => void;
  notify: Notify;
  onProjectCreated: (created: CreatedProject) => void;
  onProjectDeleted: (domain: string) => void;
  onToggleSsl: (domain: string, next: boolean) => void;
  onRestartPanel: () => void;
}) {
  const { t, lang } = useI18n();
  const [modulesFor, setModulesFor] = useState<OsPanelProject | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [sslFilter, setSslFilter] = useState<'all' | 'on' | 'off'>('all');
  const [phpFilter, setPhpFilter] = useState('all');
  const [httpEngineFilter, setHttpEngineFilter] = useState('all');
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const activityId = useId();
  const { activity, loading: activityLoading, error: activityError, now } = useProjectActivity(allProjects);
  const dateFormat = new Intl.DateTimeFormat(localeTag(lang), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const timeFormat = new Intl.DateTimeFormat(localeTag(lang), { hour: '2-digit', minute: '2-digit' });
  // Facet value lists are built over the full project list, not the already
  // search-filtered one: otherwise the chosen filter hides the remaining options.
  const phpVersions = useMemo(
    () =>
      facetValues(
        allProjects.map((project) => project.php),
        (a, b) => b.localeCompare(a, undefined, { numeric: true }),
      ),
    [allProjects],
  );
  const httpEngines = useMemo(
    () =>
      facetValues(
        allProjects.map((project) => project.type),
        (a, b) => a.localeCompare(b),
      ),
    [allProjects],
  );
  const filtersActive = sslFilter !== 'all' || phpFilter !== 'all' || httpEngineFilter !== 'all';
  const visibleProjects = useMemo(
    () =>
      projects.filter(
        (project) =>
          (sslFilter === 'all' || (sslFilter === 'on' ? project.ssl : !project.ssl)) &&
          (phpFilter === 'all' || project.php === phpFilter) &&
          (httpEngineFilter === 'all' || project.type === httpEngineFilter),
      ),
    [projects, sslFilter, phpFilter, httpEngineFilter],
  );
  const resetFilters = () => {
    setSslFilter('all');
    setPhpFilter('all');
    setHttpEngineFilter('all');
  };
  const activityGroups = groupProjectActivity(visibleProjects, activity, now);
  // Editors for "Open in": looked up once when the page opens.
  const [editors, setEditors] = useState<EditorInfo[]>([]);

  useEffect(() => {
    listEditors()
      .then(setEditors)
      .catch(() => setEditors([]));
  }, []);

  const openProject = async (project: OsPanelProject) => {
    try {
      await openInBrowser(`${project.ssl ? 'https' : 'http'}://${project.domain}`);
      notify(t('projects.toastOpened', { domain: project.domain }));
    } catch (error) {
      notify(errorText(t, error, 'projects.toastOpenFailed'));
    }
  };
  const openProjectDir = async (project: OsPanelProject) => {
    try {
      await openProjectFolder(project.path);
      notify(t('projects.toastFolderOpened', { domain: project.domain }));
    } catch (error) {
      notify(errorText(t, error, 'projects.toastFolderFailed'));
    }
  };
  const openProjectIn = async (project: OsPanelProject, editorId: string, editorName: string) => {
    try {
      await openInEditor(editorId, project.path);
      notify(t('projects.toastOpenedIn', { domain: project.domain, editor: editorName }));
    } catch (error) {
      notify(errorText(t, error, 'projects.toastOpenInFailed'));
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={t('nav.workspace')}
        heading={t('nav.projects')}
        description={t('projects.subtitle')}
        action={
          <button type="button" className="primary-button" onClick={() => setCreateDialogOpen(true)}>
            <span className="plus">+</span>
            {t('projects.new')}
          </button>
        }
      />
      <div className="toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('projects.searchPlaceholder')}
          />
        </div>
        <FilterFacet
          icon={ShieldCheck}
          label={t('projects.filterSsl')}
          allLabel={t('projects.filterAll')}
          value={sslFilter}
          options={[
            { value: 'on', label: t('projects.filterSslOn') },
            { value: 'off', label: t('projects.filterSslOff') },
          ]}
          onChange={(value) => setSslFilter(value)}
        />
        {(phpVersions.length > 1 || phpFilter !== 'all') && (
          <FilterFacet
            icon={Code2}
            label={t('projects.filterPhp')}
            allLabel={t('projects.filterAll')}
            value={phpFilter}
            options={phpVersions.map((version) => ({
              value: version,
              label: isEngineUnset(version) ? t('projects.engineUnset') : `PHP ${version}`,
            }))}
            onChange={(value) => setPhpFilter(value)}
          />
        )}
        {(httpEngines.length > 1 || httpEngineFilter !== 'all') && (
          <FilterFacet
            icon={Network}
            label={t('projects.modulesHttpEngine')}
            allLabel={t('projects.filterAll')}
            value={httpEngineFilter}
            options={httpEngines.map((engine) => ({
              value: engine,
              label: isEngineUnset(engine) ? t('projects.engineUnset') : engine,
            }))}
            onChange={(value) => setHttpEngineFilter(value)}
          />
        )}
        {filtersActive && (
          <button type="button" className="filter-button reset" onClick={resetFilters}>
            <X size={15} />
            {t('projects.filterReset')}
          </button>
        )}
      </div>
      <div className="project-table project-activity-table">
        <div className="table-head">
          <span>{t('projects.colName')}</span>
          <span>{t('projects.colEnv')}</span>
          <span>{t('projects.colSsl')}</span>
          <span>{t('projects.colActions')}</span>
        </div>
        {visibleProjects.length === 0 ? (
          <div className="empty-note">
            {filtersActive && projects.length > 0 ? t('projects.emptyFiltered') : t('projects.empty')}
          </div>
        ) : (
          activityGroups.flatMap((group) =>
            group.projects.map((project, index) => {
              const entry = activity[project.domain];
              const modified = activityDate(entry);
              const expanded = expandedProject === project.domain;
              const detailsId = `${activityId}-${project.domain}`;
              return (
                <Fragment key={project.domain}>
                  {index === 0 && (
                    <h3 className="project-activity-group-heading" id={`${activityId}-group-${group.key}`}>
                      <b>{t(`projects.activity${group.kind[0].toUpperCase()}${group.kind.slice(1)}`)}</b>
                      {group.date && <time dateTime={group.key}>{dateFormat.format(group.date)}</time>}
                    </h3>
                  )}
                  <div className="project-row" aria-describedby={`${activityId}-group-${group.key}`}>
                    <div className="project-activity-identity">
                      <div className="project-activity-title">
                        <b>{project.domain}</b>
                        {modified && entry.lastFile ? (
                          <button
                            type="button"
                            className="project-last-change"
                            onClick={() => setExpandedProject(expanded ? null : project.domain)}
                            aria-expanded={expanded}
                            aria-controls={detailsId}
                            aria-label={t(
                              expanded ? 'projects.activityHideFile' : 'projects.activityShowFile',
                              { domain: project.domain },
                            )}
                            title={modified.toLocaleString(localeTag(lang))}
                          >
                            <Clock3 size={13} />
                            <time dateTime={modified.toISOString()}>{timeFormat.format(modified)}</time>
                            {entry.status === 'partial' && (
                              <AlertTriangle size={13} aria-label={t('projects.activityPartial')} />
                            )}
                            <ChevronDown size={12} className={expanded ? 'expanded' : ''} />
                          </button>
                        ) : (
                          <span className="project-activity-unavailable">
                            {t(
                              !entry && activityLoading
                                ? 'projects.activityScanning'
                                : entry?.status === 'empty'
                                  ? 'projects.activityEmpty'
                                  : 'projects.activityUnavailable',
                            )}
                          </span>
                        )}
                      </div>
                      <span className="project-activity-path">{project.path}</span>
                    </div>
                    <div>
                      <b>{isEngineUnset(project.php) ? '' : `PHP ${project.php}`}</b>
                      <span className="table-sub">{isEngineUnset(project.type) ? '' : project.type}</span>
                    </div>
                    <div>
                      <button
                        type="button"
                        className={`ssl-toggle ${project.ssl ? 'on' : ''}`}
                        onClick={() => onToggleSsl(project.domain, !project.ssl)}
                        aria-pressed={project.ssl}
                        title={t(project.ssl ? 'projects.sslToggleOff' : 'projects.sslToggleOn', {
                          domain: project.domain,
                        })}
                      >
                        {project.ssl ? <ShieldCheck size={13} /> : <ShieldOff size={13} />}
                        {t(project.ssl ? 'projects.sslOn' : 'projects.sslOff')}
                      </button>
                    </div>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void openProject(project)}
                      >
                        <ArrowUpRight size={14} />
                        {t('projects.open')}
                      </button>
                      <RowMenu
                        entries={[
                          {
                            label: t('projects.menuModules'),
                            icon: SlidersHorizontal,
                            onSelect: () => setModulesFor(project),
                          },
                          {
                            label: t('projects.menuOpenBrowser'),
                            icon: Globe2,
                            onSelect: () => void openProject(project),
                          },
                          {
                            label: t('projects.menuOpenFolder'),
                            icon: FolderOpen,
                            onSelect: () => void openProjectDir(project),
                          },
                          // The "Open in" section is shown only if editors were found.
                          ...(editors.length > 0
                            ? [
                                {
                                  label: t('projects.openIn'),
                                  icon: Code2,
                                  children: editors.map((editor) => ({
                                    label: editor.name,
                                    onSelect: () => void openProjectIn(project, editor.id, editor.name),
                                  })),
                                },
                              ]
                            : []),
                          {
                            label: t('projects.menuCopyDomain'),
                            icon: Copy,
                            onSelect: () => void copyText(t, project.domain, 'label.domain', notify),
                          },
                          {
                            label: t('projects.menuCopyPath'),
                            icon: Copy,
                            onSelect: () => void copyText(t, project.path, 'label.path', notify),
                          },
                          {
                            label: t('projects.delete'),
                            icon: Trash2,
                            danger: true,
                            onSelect: () => onProjectDeleted(project.domain),
                          },
                        ]}
                      />
                    </div>
                  </div>
                  {modified && entry.lastFile && (
                    <div className="project-activity-file" id={detailsId} hidden={!expanded}>
                      <span>{t('projects.activityLastFile')}</span>
                      <code>{entry.lastFile}</code>
                      {entry.status === 'partial' && (
                        <span className="project-activity-warning">
                          <AlertTriangle size={13} />
                          {t('projects.activityPartial')}
                        </span>
                      )}
                    </div>
                  )}
                </Fragment>
              );
            }),
          )
        )}
      </div>
      {allProjects.length > 0 && (
        <div className="project-activity-footer">
          <span role="status">
            {activityError
              ? errorText(t, activityError, 'projects.activityFailed')
              : activityLoading
                ? t('projects.activityScanning')
                : ''}
          </span>
          <span>
            <ArrowDownWideNarrow size={13} />
            {t('projects.activitySortRecent')}
          </span>
        </div>
      )}
      {modulesFor && (
        <ProjectModulesDialog project={modulesFor} notify={notify} onClose={() => setModulesFor(null)} />
      )}
      {createDialogOpen && (
        <CreateProjectDialog
          notify={notify}
          onCreated={onProjectCreated}
          onRestartPanel={onRestartPanel}
          onClose={() => setCreateDialogOpen(false)}
        />
      )}
    </>
  );
}
