import { useId } from 'react';
import { components, type GroupBase, type MultiValueRemoveProps } from 'react-select';
import CreatableSelect from 'react-select/creatable';
import { useI18n } from '../../i18n';
import {
  MAX_PROJECT_TAG_LENGTH,
  normalizeProjectTag,
  type ProjectTagColors,
  projectTagAppearance,
  projectTagKey,
} from '../../projectTags';

type TagOption = { value: string; label: string };

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
}: {
  value: string[];
  available: string[];
  colors: ProjectTagColors;
  onChange: (tags: string[]) => void;
  ariaLabel: string;
  autoFocus?: boolean;
  onColorSelect?: (tag: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const catalog = new Map([...available, ...value].map((tag) => [projectTagKey(tag), tag]));
  const option = (tag: string): TagOption => ({ value: tag, label: tag });
  return (
    <CreatableSelect<TagOption, true>
      instanceId={id}
      inputId={`${id}-input`}
      className="project-tag-select"
      classNamePrefix="tag-select"
      unstyled
      isMulti
      isClearable={false}
      closeMenuOnSelect={false}
      blurInputOnSelect={false}
      openMenuOnFocus
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
      components={{ MultiValueRemove: RemoveTag, IndicatorSeparator: null }}
      ariaLiveMessages={{
        guidance: () => t('projects.tagsSelectHelp'),
        onChange: ({ labels }) => t('projects.tagsSelection', { tags: labels?.join(', ') ?? '' }),
        onFocus: ({ focused }) => focused?.label ?? '',
        onFilter: ({ resultsMessage }) => resultsMessage,
      }}
      screenReaderStatus={({ count }) => t('projects.tagsOptions', { count })}
      styles={{
        multiValue: (base, { data }) => ({ ...base, ...projectTagAppearance(colors, data.value).style }),
        option: (base, { data }) => ({ ...base, ...projectTagAppearance(colors, data.value).style }),
      }}
      classNames={{
        multiValue: ({ data }) => projectTagAppearance(colors, data.value).className,
        option: ({ data }) => projectTagAppearance(colors, data.value).className,
      }}
      formatOptionLabel={(data, { context }) =>
        context === 'value' && onColorSelect ? (
          <button
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
          </button>
        ) : (
          data.label
        )
      }
    />
  );
}
