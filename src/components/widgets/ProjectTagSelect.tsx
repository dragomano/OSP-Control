import { useId } from 'react';
import { components, type GroupBase, type MenuProps, type MultiValueRemoveProps } from 'react-select';
import CreatableSelect from 'react-select/creatable';
import { useI18n } from '../../i18n';
import {
  MAX_PROJECT_TAG_LENGTH,
  normalizeProjectTag,
  type ProjectTagColors,
  projectTagAppearance,
  projectTagKey,
} from '../../projectTags';
import { Button, cx } from '../ui';

type TagOption = { value: string; label: string };

function InlineMenu(props: MenuProps<TagOption, true, GroupBase<TagOption>>) {
  const { t } = useI18n();
  return (
    <components.Menu {...props}>
      <div className="tag-select-menu-caption" aria-hidden="true">
        {t('projects.tagsAvailable')}
      </div>
      {props.children}
    </components.Menu>
  );
}

function RemoveTag(props: MultiValueRemoveProps<TagOption, true, GroupBase<TagOption>>) {
  const { t } = useI18n();
  return (
    <components.MultiValueRemove
      {...props}
      innerProps={{ ...props.innerProps, 'aria-label': t('projects.tagsRemove', { tag: props.data.value }) }}
    />
  );
}

export function ProjectTagSelect({
  value,
  available,
  colors,
  onChange,
  ariaLabel,
  autoFocus = false,
  onColorSelect,
  inlineMenu = false,
}: {
  value: string[];
  available: string[];
  colors: ProjectTagColors;
  onChange: (tags: string[]) => void;
  ariaLabel: string;
  autoFocus?: boolean;
  onColorSelect?: (tag: string) => void;
  inlineMenu?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const catalog = new Map([...available, ...value].map((tag) => [projectTagKey(tag), tag]));
  const option = (tag: string): TagOption => ({ value: tag, label: tag });
  return (
    <CreatableSelect<TagOption, true>
      instanceId={id}
      inputId={`${id}-input`}
      className={cx('project-tag-select', inlineMenu && 'project-tag-select-inline')}
      classNamePrefix="tag-select"
      unstyled
      isMulti
      isClearable={false}
      closeMenuOnSelect={false}
      blurInputOnSelect={false}
      openMenuOnFocus
      menuShouldScrollIntoView={inlineMenu ? false : undefined}
      captureMenuScroll={inlineMenu ? false : undefined}
      maxMenuHeight={inlineMenu ? 160 : undefined}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      placeholder={t('projects.tagsPlaceholder')}
      noOptionsMessage={() => t('projects.tagsNoOptions')}
      formatCreateLabel={(input) => t('projects.tagsCreate', { tag: normalizeProjectTag(input) })}
      isValidNewOption={(input) => {
        const tag = normalizeProjectTag(input);
        return (
          !!tag &&
          [...tag].length <= MAX_PROJECT_TAG_LENGTH &&
          !/\p{Cc}/u.test(tag) &&
          !catalog.has(projectTagKey(tag))
        );
      }}
      getNewOptionData={(input, label) => ({ value: normalizeProjectTag(input), label: String(label) })}
      options={[...catalog.values()].map(option)}
      value={value.map(option)}
      onChange={(tags) => onChange(tags.map((tag) => tag.value))}
      components={{
        MultiValueRemove: RemoveTag,
        IndicatorSeparator: null,
        ...(inlineMenu ? { Menu: InlineMenu } : {}),
      }}
      ariaLiveMessages={{
        guidance: () => t('projects.tagsSelectHelp'),
        onChange: ({ labels }) => t('projects.tagsSelection', { tags: labels?.join(', ') ?? '' }),
        onFocus: ({ focused }) => focused?.label ?? '',
        onFilter: ({ resultsMessage }) => resultsMessage,
      }}
      screenReaderStatus={({ count }) => t('projects.tagsOptions', { count })}
      styles={{
        menu: (base) => (inlineMenu ? { ...base, position: 'static' } : base),
        multiValue: (base, { data }) => ({ ...base, ...projectTagAppearance(colors, data.value).style }),
        option: (base, { data }) => ({ ...base, ...projectTagAppearance(colors, data.value).style }),
      }}
      classNames={{
        multiValue: ({ data }) => projectTagAppearance(colors, data.value).className,
        option: ({ data, isFocused }) =>
          cx(projectTagAppearance(colors, data.value).className, isFocused && 'tag-select-option-focused'),
      }}
      formatOptionLabel={(data, { context }) =>
        context === 'value' && onColorSelect ? (
          <Button
            variant="ghost"
            type="button"
            className="tag-select-color"
            aria-label={t('projects.tagsColorFor', { tag: data.value })}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              onColorSelect(data.value);
            }}
          >
            {data.value}
          </Button>
        ) : (
          data.label
        )
      }
    />
  );
}
