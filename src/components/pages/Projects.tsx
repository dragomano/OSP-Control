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
  Layers,
  Network,
  Pencil,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Tags,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { Fragment, lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { errorText, localeTag, useI18n } from '../../i18n';
import {
  type CreatedProject,
  type EditorInfo,
  filterProjects,
  isEngineUnset,
  listEditors,
  listProjectEditors,
  type OsPanelProject,
  openInBrowser,
  openInEditor,
  openProjectConsole,
  openProjectEditor,
  openProjectFolder,
} from '../../ospanel';
import { displayProjectDomain } from '../../projectDomain';
import { mergeProjectEditors, type ProjectEditor } from '../../projectEditors';
import {
  editProjectTags,
  knownProjectTags,
  matchesProjectTags,
  PROJECT_TAGS_KEY,
  type ProjectSort,
  type ProjectTagColorEdits,
  pruneProjectTagColors,
  readProjectTagColors,
  readProjectTags,
  renameProjectTags,
  setProjectTagColor,
  sortTaggedProjects,
  type TagMatch,
  tagsForProject,
  writeProjectTags,
} from '../../projectTags';
import { CreateProjectDialog } from '../dialogs/CreateProjectDialog';
import { HostsEditor } from '../dialogs/HostsEditor';
import { RenameProjectDialog } from '../dialogs/RenameProjectDialog';
import { copyText, type Notify } from '../shared';
import { Actions, BadgeButton, Button, DataTable, EmptyState, Toolbar } from '../ui';
import { FilterFacet, facetValues } from '../widgets/FilterFacet';
import { MenuSelect } from '../widgets/MenuSelect';
import { PageHeader } from '../widgets/PageHeader';
import { ProjectTagSelect } from '../widgets/ProjectTagSelect';
import { ProjectSelection, ProjectTagEditor, ProjectTagFilter, ProjectTagList } from '../widgets/ProjectTags';
import { RowMenu } from '../widgets/RowMenu';
import { SearchField } from '../widgets/SearchField';
import { activityDate, groupProjectActivity, useProjectActivity } from './projectActivity';

const ProjectWorkspace = lazy(() =>
  import('./ProjectWorkspace').then((module) => ({ default: module.ProjectWorkspace })),
);

const ProjectStartersWorkspace = lazy(() =>
  import('./ProjectStartersWorkspace').then((module) => ({ default: module.ProjectStartersWorkspace })),
);

export type ProjectShortcut = 'hosts' | 'templates' | 'create';

type ProjectsProps = {
  projects: OsPanelProject[];
  allProjects: OsPanelProject[];
  query: string;
  setQuery: (value: string) => void;
  notify: Notify;
  shortcut?: { kind: ProjectShortcut };
  onProjectCreated: (created: CreatedProject) => void;
  onProjectDeleted: (domain: string) => void;
  onProjectRenamed: (domain: string, renamed: OsPanelProject) => void;
  onToggleSsl: (domain: string, next: boolean) => void;
  onRestartPanel: () => void;
  blocked?: boolean;
  onWorkspaceStateChange?: (state: { dirty: boolean; busy: boolean }) => void;
};

export function Projects(props: ProjectsProps) {
  return <ProjectsContent {...props} tagStorageKey={PROJECT_TAGS_KEY} />;
}

function ProjectsContent({
  projects,
  allProjects,
  query,
  setQuery,
  notify,
  shortcut,
  onProjectCreated,
  onProjectDeleted,
  onProjectRenamed,
  onToggleSsl,
  onRestartPanel,
  blocked,
  onWorkspaceStateChange,
  tagStorageKey,
}: ProjectsProps & { tagStorageKey: string }) {
  const { t, lang } = useI18n();
  const [modulesFor, setModulesFor] = useState<OsPanelProject | null>(null);
  const listScroll = useRef(0);
  const openSettings = (project: OsPanelProject) => {
    const main = document.querySelector('.main-content');
    listScroll.current = main?.scrollTop ?? 0;
    if (main) main.scrollTop = 0;
    setModulesFor(project);
  };
  const [dialog, setDialog] = useState<'create' | 'hosts' | null>(null);
  const [renameFor, setRenameFor] = useState<OsPanelProject | null>(null);
  const [sslFilter, setSslFilter] = useState<'all' | 'on' | 'off' | 'auto'>('all');
  const [phpFilter, setPhpFilter] = useState('all');
  const [httpEngineFilter, setHttpEngineFilter] = useState('all');
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [startersOpen, setStartersOpen] = useState(false);
  const startersScroll = useRef<number | null>(null);
  const openTemplates = useCallback(() => {
    if (startersScroll.current !== null) return;
    const main = document.querySelector('.main-content');
    startersScroll.current = main?.scrollTop ?? 0;
    if (main) main.scrollTop = 0;
    setStartersOpen(true);
  }, []);
  const [tagState, setTagState] = useState(() => ({
    key: tagStorageKey,
    tags: readProjectTags(tagStorageKey),
    colors: readProjectTagColors(tagStorageKey),
  }));
  const tagColors = tagState.key === tagStorageKey ? tagState.colors : readProjectTagColors(tagStorageKey);
  const projectTags = useMemo(
    () => (tagState.key === tagStorageKey ? tagState.tags : readProjectTags(tagStorageKey)),
    [tagState, tagStorageKey],
  );
  const tagsRef = useRef(projectTags);
  tagsRef.current = projectTags;
  const colorsRef = useRef(tagColors);
  colorsRef.current = tagColors;
  const [tagFilters, setTagFilters] = useState<(string | null)[]>([]);
  const [tagMatch, setTagMatch] = useState<TagMatch>('any');
  const [sort, setSort] = useState<ProjectSort>('recent');
  const [editingTags, setEditingTags] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkTags, setBulkTags] = useState<string[]>([]);
  useEffect(() => {
    const kind = shortcut?.kind;
    if (!kind) return;
    if (kind === 'templates') openTemplates();
    else setDialog((current) => current ?? kind);
  }, [openTemplates, shortcut]);
  useEffect(() => {
    const tags = readProjectTags(tagStorageKey);
    const colors = readProjectTagColors(tagStorageKey);
    const retained = pruneProjectTagColors(tags, colors);
    if (Object.keys(retained).length !== Object.keys(colors).length) {
      try {
        // Clear colors left behind by earlier releases when the palette is first read.
        writeProjectTags(tagStorageKey, tags, retained);
      } catch {
        // A failed cleanup must not prevent the projects page from loading.
      }
    }
    setTagState({ key: tagStorageKey, tags, colors: retained });
    setSelected(new Set());
    setEditingTags(null);
    setTagFilters([]);
  }, [tagStorageKey]);
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
  const tagCatalog = useMemo(
    () =>
      knownProjectTags(
        Object.fromEntries(
          allProjects.map((project) => [project.domain, tagsForProject(projectTags, project.domain)]),
        ),
      ),
    [allProjects, projectTags],
  );
  const matchingProjects = useMemo(
    () => filterProjects(projects, query, projectTags),
    [projects, query, projectTags],
  );
  const filtersActive =
    sslFilter !== 'all' || phpFilter !== 'all' || httpEngineFilter !== 'all' || tagFilters.length > 0;
  const visibleProjects = useMemo(
    () =>
      matchingProjects.filter(
        (project) =>
          (sslFilter === 'all' ||
            (sslFilter === 'on'
              ? project.ssl
              : sslFilter === 'off'
                ? !project.ssl
                : project.tls === 'auto')) &&
          (phpFilter === 'all' || project.php === phpFilter) &&
          (httpEngineFilter === 'all' || project.type === httpEngineFilter) &&
          matchesProjectTags(tagsForProject(projectTags, project.domain), tagFilters, tagMatch),
      ),
    [matchingProjects, sslFilter, phpFilter, httpEngineFilter, projectTags, tagFilters, tagMatch],
  );
  const resetFilters = () => {
    setSslFilter('all');
    setPhpFilter('all');
    setHttpEngineFilter('all');
    setTagFilters([]);
    setTagMatch('any');
  };
  const activityGroups =
    sort === 'recent'
      ? groupProjectActivity(visibleProjects, activity, now)
      : [
          {
            key: 'sorted',
            kind: 'unknown',
            date: null,
            projects: sortTaggedProjects(visibleProjects, projectTags, sort, localeTag(lang)),
          },
        ];
  const visibleDomains = useMemo(
    () => new Set(visibleProjects.map((project) => project.domain)),
    [visibleProjects],
  );
  const selectedDomains = visibleProjects
    .filter((project) => selected.has(project.domain))
    .map((project) => project.domain);
  const allSelected = visibleProjects.length > 0 && selectedDomains.length === visibleProjects.length;
  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((domain) => visibleDomains.has(domain)));
      return next.size === current.size ? current : next;
    });
  }, [visibleDomains]);
  const toggleSelected = (domain: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(domain);
      else next.delete(domain);
      return next;
    });
  const changeTags = (
    domains: string[],
    tags: string[],
    action: 'add' | 'remove' | 'replace',
    colorEdits: ProjectTagColorEdits = {},
  ) => {
    try {
      let next = tagsRef.current;
      if (action === 'replace') {
        for (const domain of domains) {
          for (const tag of tagsForProject(next, domain)) {
            if (!tags.includes(tag)) next = editProjectTags(next, [domain], tag, 'remove');
          }
        }
      }
      for (const tag of tags) {
        next = editProjectTags(next, domains, tag, action === 'remove' ? 'remove' : 'add');
      }
      const nextColors = Object.entries(colorEdits).reduce(
        (current, [tag, color]) => setProjectTagColor(current, tag, color),
        colorsRef.current,
      );
      colorsRef.current = writeProjectTags(tagStorageKey, next, nextColors);
      tagsRef.current = next;
      setTagState({ key: tagStorageKey, tags: next, colors: colorsRef.current });
      return true;
    } catch (error) {
      notify(errorText(t, error, 'projects.tagsSaveFailed'));
      return false;
    }
  };
  // Editors for "Open in": looked up once when the page opens.
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [customEditors, setCustomEditors] = useState<Record<string, EditorInfo[]>>({});
  const loadCustomEditors = (project: OsPanelProject) => {
    listProjectEditors(project)
      .then((items) => setCustomEditors((current) => ({ ...current, [project.domain]: items })))
      .catch(() => setCustomEditors((current) => ({ ...current, [project.domain]: [] })));
  };

  useEffect(() => {
    listEditors()
      .then(setEditors)
      .catch(() => setEditors([]));
  }, []);

  const openProject = async (project: OsPanelProject) => {
    try {
      await openInBrowser(`${project.ssl ? 'https' : 'http'}://${project.domain}`);
      notify(t('projects.toastOpened', { domain: displayProjectDomain(project.domain) }));
    } catch (error) {
      notify(errorText(t, error, 'projects.toastOpenFailed'));
    }
  };
  const openConsole = async (project: OsPanelProject) => {
    try {
      await openProjectConsole(project.domain);
      notify(t('projects.toastConsoleOpened', { domain: displayProjectDomain(project.domain) }));
    } catch (error) {
      notify(errorText(t, error, 'projects.toastConsoleFailed'));
    }
  };
  const openProjectDir = async (project: OsPanelProject) => {
    try {
      await openProjectFolder(project.path);
      notify(t('projects.toastFolderOpened', { domain: displayProjectDomain(project.domain) }));
    } catch (error) {
      notify(errorText(t, error, 'projects.toastFolderFailed'));
    }
  };
  const openProjectIn = async (project: OsPanelProject, editor: ProjectEditor) => {
    try {
      if (editor.custom) await openProjectEditor(project, editor.id);
      else await openInEditor(editor.id, project.path);
      notify(
        t('projects.toastOpenedIn', { domain: displayProjectDomain(project.domain), editor: editor.name }),
      );
    } catch (error) {
      notify(errorText(t, error, 'projects.toastOpenInFailed'));
    }
  };

  const renderList = () => (
    <>
      <PageHeader
        eyebrow={t('nav.workspace')}
        heading={t('nav.projects')}
        description={t('projects.subtitle')}
        action={
          <Actions className="projects-header-actions">
            <Button type="button" className="secondary-button" onClick={() => setDialog('hosts')}>
              <Network size={15} />
              {t('hosts.open')}
            </Button>
            <Button type="button" className="secondary-button" onClick={openTemplates}>
              <Layers size={15} />
              {t('starter.title')}
            </Button>
            <Button
              variant="primary"
              type="button"
              className="primary-button"
              onClick={() => setDialog('create')}
            >
              <span className="plus">+</span>
              {t('projects.new')}
            </Button>
          </Actions>
        }
      />
      <Toolbar className="toolbar projects-toolbar">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t('projects.searchPlaceholder')}
          title={t('projects.tagsSearchHint')}
          iconSize={16}
        />
        <div className="project-ssl-filter">
          <FilterFacet
            icon={ShieldCheck}
            label={t('projects.colTls')}
            allLabel={t('projects.filterAll')}
            value={sslFilter}
            options={[
              { value: 'on', label: t('projects.sslOn') },
              { value: 'off', label: t('projects.sslOff') },
              { value: 'auto', label: t('projects.sslAuto') },
            ]}
            onChange={(value) => setSslFilter(value)}
          />
        </div>
        {(phpVersions.length > 1 || phpFilter !== 'all') && (
          <div className="project-php-filter">
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
          </div>
        )}
        {(httpEngines.length > 1 || httpEngineFilter !== 'all') && (
          <div className="project-http-filter">
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
          </div>
        )}
        <ProjectTagFilter
          available={tagCatalog}
          colors={tagColors}
          selected={tagFilters}
          match={tagMatch}
          onSelect={setTagFilters}
          onMatch={setTagMatch}
        />
        <div className="project-sort">
          <MenuSelect<ProjectSort>
            icon={ArrowDownWideNarrow}
            ariaLabel={t('projects.sortLabel')}
            value={sort}
            options={[
              { value: 'recent', label: t('projects.activitySortRecent') },
              { value: 'domain', label: t('projects.sortDomain') },
              { value: 'tags', label: t('projects.sortTags') },
              { value: 'tags-desc', label: t('projects.sortTagsDesc') },
            ]}
            onChange={setSort}
          />
        </div>
        {filtersActive && (
          <Button type="button" className="filter-button reset" onClick={resetFilters}>
            <X size={15} />
            {t('projects.filterReset')}
          </Button>
        )}
      </Toolbar>
      {selectedDomains.length > 0 && (
        <fieldset className="project-tags-bulk" aria-label={t('projects.tagsBulk')}>
          <strong role="status">{t('projects.tagsSelected', { count: selectedDomains.length })}</strong>
          <ProjectTagSelect
            value={bulkTags}
            onChange={setBulkTags}
            available={tagCatalog}
            colors={tagColors}
            ariaLabel={t('projects.tagsBulkName')}
          />
          <Button
            type="button"
            className="secondary-button"
            disabled={!bulkTags.length}
            onClick={() => changeTags(selectedDomains, bulkTags, 'add')}
          >
            {t('projects.tagsAssign')}
          </Button>
          <Button
            type="button"
            className="secondary-button"
            disabled={!bulkTags.length}
            onClick={() => changeTags(selectedDomains, bulkTags, 'remove')}
          >
            {t('projects.tagsUnassign')}
          </Button>
          <Button
            variant="ghost"
            square
            type="button"
            className="icon-button"
            aria-label={t('projects.tagsClearSelection')}
            onClick={() => {
              setSelected(new Set());
              setBulkTags([]);
            }}
          >
            <X size={16} />
          </Button>
        </fieldset>
      )}
      <DataTable className="project-table project-activity-table project-tags-table">
        <div className="table-head">
          <ProjectSelection
            all
            checked={allSelected}
            mixed={selectedDomains.length > 0 && !allSelected}
            label={t('projects.tagsSelectAll')}
            onChange={(checked) => setSelected(checked ? new Set(visibleDomains) : new Set())}
          />
          <span>{t('projects.colName')}</span>
          <span>{t('projects.tagsColumn')}</span>
          <span>{t('projects.colEnv')}</span>
          <span>{t('projects.colTls')}</span>
          <span>{t('projects.colActions')}</span>
        </div>
        {visibleProjects.length === 0 ? (
          <EmptyState className="empty-note">
            {filtersActive && matchingProjects.length > 0 ? t('projects.emptyFiltered') : t('projects.empty')}
          </EmptyState>
        ) : (
          activityGroups.flatMap((group) =>
            group.projects.map((project, index) => {
              const displayDomain = displayProjectDomain(project.domain);
              const projectEditors = mergeProjectEditors(editors, customEditors[project.domain] ?? []);
              const entry = activity[project.domain];
              const modified = activityDate(entry);
              const expanded = expandedProject === project.domain;
              const detailsId = `${activityId}-${project.domain}`;
              return (
                <Fragment key={project.domain}>
                  {index === 0 && sort === 'recent' && (
                    <h3 className="project-activity-group-heading" id={`${activityId}-group-${group.key}`}>
                      <b>{t(`projects.activity${group.kind[0].toUpperCase()}${group.kind.slice(1)}`)}</b>
                      {group.date && <time dateTime={group.key}>{dateFormat.format(group.date)}</time>}
                    </h3>
                  )}
                  <div
                    className="project-row"
                    aria-describedby={sort === 'recent' ? `${activityId}-group-${group.key}` : undefined}
                  >
                    <ProjectSelection
                      checked={selected.has(project.domain)}
                      label={t('projects.tagsSelectProject', { domain: displayDomain })}
                      onChange={(checked) => toggleSelected(project.domain, checked)}
                    />
                    <div className="project-activity-identity">
                      <div className="project-activity-title">
                        <b title={project.domain}>
                          <Button
                            variant="ghost"
                            type="button"
                            className="project-settings-link"
                            title={t('workspace.settingsFor', { domain: displayDomain })}
                            onClick={() => openSettings(project)}
                          >
                            {displayDomain}
                          </Button>
                        </b>
                        {modified && entry.lastFile ? (
                          <Button
                            variant="ghost"
                            type="button"
                            className="project-last-change"
                            onClick={() => setExpandedProject(expanded ? null : project.domain)}
                            aria-expanded={expanded}
                            aria-controls={detailsId}
                            aria-label={t(
                              expanded ? 'projects.activityHideFile' : 'projects.activityShowFile',
                              { domain: displayDomain },
                            )}
                            title={modified.toLocaleString(localeTag(lang))}
                          >
                            <Clock3 size={13} />
                            <time dateTime={modified.toISOString()}>{timeFormat.format(modified)}</time>
                            {entry.status === 'partial' && (
                              <AlertTriangle size={13} aria-label={t('projects.activityPartial')} />
                            )}
                            <ChevronDown size={12} className={expanded ? 'expanded' : ''} />
                          </Button>
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
                    <ProjectTagList
                      domain={displayDomain}
                      tags={tagsForProject(projectTags, project.domain)}
                      colors={tagColors}
                      selected={tagFilters}
                      editing={editingTags === project.domain}
                      onEdit={() => setEditingTags(editingTags === project.domain ? null : project.domain)}
                      onFilter={(tag) => setTagFilters([tag])}
                    />
                    <div className="project-environment">
                      <b>{isEngineUnset(project.php) ? '' : `PHP ${project.php}`}</b>
                      <span className="table-sub">{isEngineUnset(project.type) ? '' : project.type}</span>
                    </div>
                    <div className="project-ssl-cell">
                      <BadgeButton
                        tone={project.ssl ? 'success' : 'default'}
                        type="button"
                        className={`ssl-toggle ${project.ssl ? 'on' : ''}`}
                        onClick={() => onToggleSsl(project.domain, !project.ssl)}
                        aria-pressed={project.ssl}
                        title={t(project.ssl ? 'projects.sslToggleOff' : 'projects.sslToggleOn', {
                          domain: displayDomain,
                        })}
                      >
                        {project.ssl ? <ShieldCheck size={13} /> : <ShieldOff size={13} />}
                        {t(
                          project.tls === 'on'
                            ? 'projects.sslOn'
                            : project.tls === 'auto'
                              ? 'projects.sslAuto'
                              : project.tls === 'off'
                                ? 'projects.sslOff'
                                : project.ssl
                                  ? 'projects.sslOn'
                                  : 'projects.sslOff',
                        )}
                      </BadgeButton>
                    </div>
                    <Actions className="row-actions">
                      <span className="project-actions-label">{t('projects.colActions')}</span>
                      <Button
                        type="button"
                        className="secondary-button"
                        onClick={() => void openProject(project)}
                      >
                        <ArrowUpRight size={14} />
                        {t('projects.open')}
                      </Button>
                      <RowMenu
                        onOpen={() => loadCustomEditors(project)}
                        entries={[
                          {
                            label: t('workspace.settings'),
                            icon: SlidersHorizontal,
                            onSelect: () => openSettings(project),
                          },
                          {
                            label: t('projects.tagsEdit'),
                            icon: Tags,
                            onSelect: () => setEditingTags(project.domain),
                          },
                          {
                            label: t('projects.menuOpenBrowser'),
                            separatorBefore: true,
                            icon: Globe2,
                            onSelect: () => void openProject(project),
                          },
                          {
                            label: t('projects.menuOpenConsole'),
                            icon: Terminal,
                            onSelect: () => void openConsole(project),
                          },
                          {
                            label: t('projects.menuOpenFolder'),
                            icon: FolderOpen,
                            onSelect: () => void openProjectDir(project),
                          },
                          ...(projectEditors.length > 0
                            ? [
                                {
                                  label: t('projects.openIn'),
                                  icon: Code2,
                                  children: projectEditors.map((editor) => ({
                                    label: editor.name,
                                    onSelect: () => void openProjectIn(project, editor),
                                  })),
                                },
                              ]
                            : []),
                          {
                            label: t('projects.renameDomain'),
                            icon: Pencil,
                            separatorBefore: true,
                            onSelect: () => setRenameFor(project),
                          },
                          {
                            label: t('projects.menuCopyDomain'),
                            separatorBefore: true,
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
                            separatorBefore: true,
                            icon: Trash2,
                            danger: true,
                            onSelect: () => onProjectDeleted(project.domain),
                          },
                        ]}
                      />
                    </Actions>
                  </div>
                  {editingTags === project.domain && (
                    <ProjectTagEditor
                      domain={displayDomain}
                      tags={tagsForProject(projectTags, project.domain)}
                      available={tagCatalog}
                      colors={tagColors}
                      onSave={(tags, colorEdits) => changeTags([project.domain], tags, 'replace', colorEdits)}
                      onClose={() => setEditingTags(null)}
                    />
                  )}
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
      </DataTable>
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
            {t(
              sort === 'recent'
                ? 'projects.activitySortRecent'
                : sort === 'domain'
                  ? 'projects.sortDomain'
                  : 'projects.sortTagsHint',
            )}
          </span>
        </div>
      )}
      {renameFor && (
        <RenameProjectDialog
          project={renameFor}
          projects={allProjects}
          onClose={() => setRenameFor(null)}
          onRenamed={(renamed) => {
            const next = renameProjectTags(tagsRef.current, renameFor.domain, renamed.domain);
            let message = t('projects.toastRenamed', {
              from: displayProjectDomain(renameFor.domain),
              domain: displayProjectDomain(renamed.domain),
            });
            try {
              colorsRef.current = writeProjectTags(tagStorageKey, next, colorsRef.current);
            } catch (error) {
              message += ` ${errorText(t, error, 'projects.tagsSaveFailed')}`;
            }
            tagsRef.current = next;
            setTagState({ key: tagStorageKey, tags: next, colors: colorsRef.current });
            setEditingTags(null);
            setExpandedProject(null);
            onProjectRenamed(renameFor.domain, renamed);
            notify(message, { label: t('projects.restartPanel'), run: onRestartPanel });
          }}
        />
      )}
    </>
  );

  return (
    <>
      {startersOpen && (
        <Suspense fallback={<EmptyState className="empty-note">{t('common.loading')}</EmptyState>}>
          <ProjectStartersWorkspace
            notify={notify}
            onClose={() => {
              const scroll = startersScroll.current ?? 0;
              startersScroll.current = null;
              setStartersOpen(false);
              requestAnimationFrame(() => {
                const main = document.querySelector('.main-content');
                if (main) main.scrollTop = scroll;
              });
            }}
          />
        </Suspense>
      )}
      {modulesFor && (
        <div hidden={startersOpen}>
          <Suspense fallback={<EmptyState className="empty-note">{t('common.loading')}</EmptyState>}>
            <ProjectWorkspace
              project={modulesFor}
              notify={notify}
              onRestartPanel={onRestartPanel}
              blocked={blocked}
              onStateChange={onWorkspaceStateChange}
              onClose={() => {
                setModulesFor(null);
                requestAnimationFrame(() => {
                  const main = document.querySelector('.main-content');
                  if (main) main.scrollTop = listScroll.current;
                });
              }}
            />
          </Suspense>
        </div>
      )}
      {!modulesFor && !startersOpen && renderList()}
      {dialog === 'create' && (
        <CreateProjectDialog
          notify={notify}
          onCreated={onProjectCreated}
          onConfigure={
            modulesFor || startersOpen
              ? undefined
              : (created) => openSettings({ ...created, type: created.http })
          }
          onRestartPanel={onRestartPanel}
          onManageTemplates={() => {
            setDialog(null);
            openTemplates();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'hosts' && <HostsEditor notify={notify} onClose={() => setDialog(null)} />}
    </>
  );
}
