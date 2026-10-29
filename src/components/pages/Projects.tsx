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
  Plus,
  Search,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { errorText, localeTag, useI18n } from '../../i18n';
import {
  type CreatedProject,
  type EditorInfo,
  filterProjects,
  isEngineUnset,
  listEditors,
  type OsPanelProject,
  openInBrowser,
  openInEditor,
  openProjectFolder,
} from '../../ospanel';
import {
  editProjectTags,
  knownProjectTags,
  matchesProjectTags,
  PROJECT_TAGS_KEY,
  type ProjectSort,
  readProjectTags,
  sortTaggedProjects,
  type TagMatch,
  tagsForProject,
  writeProjectTags,
} from '../../projectTags';
import { CreateProjectDialog } from '../dialogs/CreateProjectDialog';
import { ProjectModulesDialog } from '../dialogs/ProjectModulesDialog';
import { copyText, type Notify } from '../shared';
import { FilterFacet, facetValues } from '../widgets/FilterFacet';
import { PageHeader } from '../widgets/PageHeader';
import { ProjectSelection, ProjectTagEditor, ProjectTagFilter } from '../widgets/ProjectTags';
import { RowMenu } from '../widgets/RowMenu';
import { activityDate, groupProjectActivity, useProjectActivity } from './projectActivity';

type ProjectsProps = {
  projects: OsPanelProject[];
  allProjects: OsPanelProject[];
  query: string;
  setQuery: (value: string) => void;
  notify: Notify;
  onProjectCreated: (created: CreatedProject) => void;
  onProjectDeleted: (domain: string) => void;
  onToggleSsl: (domain: string, next: boolean) => void;
  onRestartPanel: () => void;
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
  onProjectCreated,
  onProjectDeleted,
  onToggleSsl,
  onRestartPanel,
  tagStorageKey,
}: ProjectsProps & { tagStorageKey: string }) {
  const { t, lang } = useI18n();
  const [modulesFor, setModulesFor] = useState<OsPanelProject | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [sslFilter, setSslFilter] = useState<'all' | 'on' | 'off'>('all');
  const [phpFilter, setPhpFilter] = useState('all');
  const [httpEngineFilter, setHttpEngineFilter] = useState('all');
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [tagState, setTagState] = useState(() => ({
    key: tagStorageKey,
    tags: readProjectTags(tagStorageKey),
  }));
  const projectTags = useMemo(
    () => (tagState.key === tagStorageKey ? tagState.tags : readProjectTags(tagStorageKey)),
    [tagState, tagStorageKey],
  );
  const tagsRef = useRef(projectTags);
  tagsRef.current = projectTags;
  const [tagFilters, setTagFilters] = useState<(string | null)[]>([]);
  const [tagMatch, setTagMatch] = useState<TagMatch>('any');
  const [sort, setSort] = useState<ProjectSort>('recent');
  const [editingTags, setEditingTags] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkTag, setBulkTag] = useState('');
  useEffect(() => {
    setTagState({ key: tagStorageKey, tags: readProjectTags(tagStorageKey) });
    setSelected(new Set());
    setEditingTags(null);
    setTagFilters([]);
  }, [tagStorageKey]);
  const activityId = useId();
  const bulkTagsId = useId();
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
          (sslFilter === 'all' || (sslFilter === 'on' ? project.ssl : !project.ssl)) &&
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
  const changeTags = (domains: string[], tag: string, action: 'add' | 'remove') => {
    try {
      const next = editProjectTags(tagsRef.current, domains, tag, action);
      writeProjectTags(tagStorageKey, next);
      tagsRef.current = next;
      setTagState({ key: tagStorageKey, tags: next });
      return true;
    } catch (error) {
      notify(errorText(t, error, 'projects.tagsSaveFailed'));
      return false;
    }
  };
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
      <div className="toolbar projects-toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('projects.searchPlaceholder')}
            title={t('projects.tagsSearchHint')}
          />
        </div>
        <div className="project-ssl-filter">
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
          selected={tagFilters}
          match={tagMatch}
          onSelect={setTagFilters}
          onMatch={setTagMatch}
        />
        <select
          className="filter-button project-sort"
          aria-label={t('projects.sortLabel')}
          value={sort}
          onChange={(event) => setSort(event.target.value as ProjectSort)}
        >
          <option value="recent">{t('projects.activitySortRecent')}</option>
          <option value="domain">{t('projects.sortDomain')}</option>
          <option value="tags">{t('projects.sortTags')}</option>
          <option value="tags-desc">{t('projects.sortTagsDesc')}</option>
        </select>
        {filtersActive && (
          <button type="button" className="filter-button reset" onClick={resetFilters}>
            <X size={15} />
            {t('projects.filterReset')}
          </button>
        )}
      </div>
      {selectedDomains.length > 0 && (
        <fieldset className="project-tags-bulk" aria-label={t('projects.tagsBulk')}>
          <strong role="status">{t('projects.tagsSelected', { count: selectedDomains.length })}</strong>
          <input
            className="project-tag-input"
            aria-label={t('projects.tagsBulkName')}
            placeholder={t('projects.tagsPlaceholder')}
            value={bulkTag}
            onChange={(event) => setBulkTag(event.target.value)}
            list={bulkTagsId}
          />
          <datalist id={bulkTagsId}>
            {tagCatalog.map((tag) => (
              <option value={tag} key={tag} />
            ))}
          </datalist>
          <button
            type="button"
            className="secondary-button"
            disabled={!bulkTag.trim()}
            onClick={() => changeTags(selectedDomains, bulkTag, 'add')}
          >
            {t('projects.tagsAssign')}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!bulkTag.trim()}
            onClick={() => changeTags(selectedDomains, bulkTag, 'remove')}
          >
            {t('projects.tagsUnassign')}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('projects.tagsClearSelection')}
            onClick={() => setSelected(new Set())}
          >
            <X size={16} />
          </button>
        </fieldset>
      )}
      <div className="project-table project-activity-table project-tags-table">
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
          <span>{t('projects.colSsl')}</span>
          <span>{t('projects.colActions')}</span>
        </div>
        {visibleProjects.length === 0 ? (
          <div className="empty-note">
            {filtersActive && matchingProjects.length > 0 ? t('projects.emptyFiltered') : t('projects.empty')}
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
                      label={t('projects.tagsSelectProject', { domain: project.domain })}
                      onChange={(checked) => toggleSelected(project.domain, checked)}
                    />
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
                    <div className="project-tags-cell">
                      <div className="project-tags-list">
                        {tagsForProject(projectTags, project.domain).map((tag) => (
                          <button
                            type="button"
                            className={`project-tag-chip ${tagFilters.includes(tag) ? 'active' : ''}`}
                            key={tag}
                            aria-label={t('projects.tagsFilterBy', { tag })}
                            onClick={() => setTagFilters([tag])}
                          >
                            {tag}
                          </button>
                        ))}
                        <button
                          type="button"
                          className="project-tag-add"
                          aria-label={t('projects.tagsEditFor', { domain: project.domain })}
                          aria-expanded={editingTags === project.domain}
                          onClick={() =>
                            setEditingTags(editingTags === project.domain ? null : project.domain)
                          }
                        >
                          <Plus size={12} />
                          {t('projects.tagsTag')}
                        </button>
                      </div>
                    </div>
                    <div className="project-environment">
                      <b>{isEngineUnset(project.php) ? '' : `PHP ${project.php}`}</b>
                      <span className="table-sub">{isEngineUnset(project.type) ? '' : project.type}</span>
                    </div>
                    <div className="project-ssl-cell">
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
                      <span className="project-actions-label">{t('projects.colActions')}</span>
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
                            label: t('projects.tagsEdit'),
                            icon: Tags,
                            onSelect: () => setEditingTags(project.domain),
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
                  {editingTags === project.domain && (
                    <ProjectTagEditor
                      domain={project.domain}
                      tags={tagsForProject(projectTags, project.domain)}
                      available={tagCatalog}
                      onChange={(tag, action) => changeTags([project.domain], tag, action)}
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
