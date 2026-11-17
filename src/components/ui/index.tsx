import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from 'react';

export const cx = (...values: (string | false | null | undefined)[]) => values.filter(Boolean).join(' ');
type Tone = 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info';
const tones = {
  default: '',
  primary: 'badge-primary',
  success: 'badge-success',
  warning: 'badge-warning',
  error: 'badge-error',
  info: 'badge-info',
};
const variants = {
  primary: 'btn-primary',
  danger: 'btn-error',
  secondary: '',
  ghost: 'btn-ghost',
  link: 'btn-link',
};
const buttonLayouts = {
  inline: '',
  row: 'btn-block ui-button-row',
  column: 'ui-button-column',
  swatch: 'btn-circle ui-button-swatch',
};
type ButtonProps = ComponentPropsWithoutRef<'button'> & {
  variant?: keyof typeof variants;
  layout?: keyof typeof buttonLayouts;
  square?: boolean;
  selected?: boolean;
};

// Keep the native element, events and ref: existing focus traps, forms and keyboard handlers own behavior.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', layout = 'inline', square, selected, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      data-selected={selected || undefined}
      className={cx(
        'btn btn-sm ui-button',
        variants[variant],
        buttonLayouts[layout],
        square && 'btn-square',
        selected && 'btn-active',
        className,
      )}
    />
  );
});
export const ButtonLink = forwardRef<
  HTMLAnchorElement,
  ComponentPropsWithoutRef<'a'> & { variant?: keyof typeof variants }
>(function ButtonLink({ className, variant = 'secondary', ...props }, ref) {
  return <a {...props} ref={ref} className={cx('btn btn-sm ui-button', variants[variant], className)} />;
});
export const Input = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<'input'> & { embedded?: boolean }>(
  function Input({ className, type = 'text', embedded, ...props }, ref) {
    const style =
      type === 'checkbox'
        ? 'checkbox checkbox-sm checkbox-primary'
        : type === 'radio'
          ? 'radio radio-sm radio-primary'
          : type === 'range'
            ? 'range range-xs range-primary'
            : type === 'color' || type === 'hidden' || embedded
              ? ''
              : 'input input-sm';
    return (
      <input
        {...props}
        type={type}
        ref={ref}
        className={cx(!embedded && 'ui-input', embedded && 'ui-embedded-input', style, className)}
      />
    );
  },
);
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  ComponentPropsWithoutRef<'textarea'> & { code?: boolean }
>(function Textarea({ className, code, ...props }, ref) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={cx(code ? 'ui-code-input' : 'textarea textarea-sm ui-textarea', className)}
    />
  );
});
type SelectProps = ComponentPropsWithoutRef<'select'> & {
  displayLabel?: string;
  leadingIcon?: ReactNode;
  iconOnly?: boolean;
};
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, displayLabel, leadingIcon, iconOnly, style, onKeyDownCapture, ...props },
  ref,
) {
  const control = (
    <select
      {...props}
      ref={ref}
      onKeyDownCapture={(event) => {
        // Escape dismisses the native picker before the surrounding dialog.
        if (event.key === 'Escape' && event.currentTarget.matches(':open')) event.stopPropagation();
        onKeyDownCapture?.(event);
      }}
      style={{ ...style, ...(displayLabel !== undefined || iconOnly ? { color: 'transparent' } : {}) }}
      className={cx('select select-sm ui-select', className)}
    />
  );
  // Plain form controls stay direct children so existing responsive field layouts remain intact.
  if (displayLabel === undefined && !leadingIcon) return control;
  return (
    <span
      className={cx(
        'ui-select-wrap row-menu',
        !!leadingIcon && 'ui-select-with-icon',
        iconOnly && 'ui-select-icon-only',
      )}
    >
      {control}
      {leadingIcon && (
        <span className="ui-select-leading" aria-hidden="true">
          {leadingIcon}
        </span>
      )}
      {displayLabel !== undefined && (
        <span className="ui-select-label" aria-hidden="true">
          {displayLabel}
        </span>
      )}
    </span>
  );
});
export const Toggle = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<'button'> & { checked: boolean }
>(function Toggle({ className, checked, ...props }, ref) {
  const state = props.role === 'switch' ? { 'aria-checked': checked } : { 'aria-pressed': checked };
  return (
    <button
      {...props}
      ref={ref}
      className={cx('toggle toggle-sm toggle-primary ui-toggle', className)}
      data-state={checked ? 'on' : 'off'}
      {...state}
    />
  );
});
export const Tab = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<'button'>>(function Tab(
  { className, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      className={cx('tab ui-tab', props['aria-selected'] === true && 'tab-active', className)}
    />
  );
});
export const Badge = forwardRef<HTMLSpanElement, ComponentPropsWithoutRef<'span'> & { tone?: Tone }>(
  function Badge({ className, tone = 'default', ...props }, ref) {
    return (
      <span
        {...props}
        ref={ref}
        className={cx('badge badge-sm badge-soft ui-badge', tones[tone], className)}
      />
    );
  },
);
export const BadgeButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<'button'> & { tone?: Tone }
>(function BadgeButton({ className, tone = 'default', ...props }, ref) {
  return (
    <button
      {...props}
      ref={ref}
      className={cx('badge badge-sm badge-soft ui-badge ui-badge-button', tones[tone], className)}
    />
  );
});
export const StatusBadge = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'> & { tone?: Tone }>(
  function StatusBadge({ className, tone = 'default', ...props }, ref) {
    return (
      <div
        {...props}
        ref={ref}
        className={cx('badge badge-sm badge-soft ui-badge', tones[tone], className)}
      />
    );
  },
);

// Structural primitives preserve page-specific grid/flex rules and semantic HTML.
function divComponent(base: string) {
  // biome-ignore lint/correctness/noComponentHookFactories: All calls are module-scope constants, so component identities never change during rendering.
  return forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(function UIBlock(
    { className, ...props },
    ref,
  ) {
    return <div {...props} ref={ref} className={cx(base, className)} />;
  });
}
type PanelLayout = 'block' | 'column' | 'row' | 'grid';
export const Panel = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'> & { layout?: PanelLayout }>(
  function Panel({ className, layout = 'block', ...props }, ref) {
    return <div {...props} ref={ref} className={cx('card ui-panel', `ui-panel-${layout}`, className)} />;
  },
);
export const CardButton = forwardRef<HTMLButtonElement, ButtonProps>(function CardButton(
  { className, variant: _variant, layout: _layout, square: _square, selected: _selected, ...props },
  ref,
) {
  return <button {...props} ref={ref} className={cx('card ui-panel ui-panel-column', className)} />;
});
export const DialogOverlay = divComponent('modal modal-open ui-dialog-overlay');
type DialogSize = 'sm' | 'md' | 'lg' | 'xl';
export const DialogPanel = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<'div'> & { size?: DialogSize }
>(function DialogPanel({ className, size = 'md', ...props }, ref) {
  return (
    <div {...props} ref={ref} className={cx('modal-box ui-dialog-panel', `ui-dialog-${size}`, className)} />
  );
});
export const DialogHeader = divComponent('ui-dialog-header');
export const DialogBody = divComponent('ui-dialog-body');
export const DialogFooter = divComponent('modal-action ui-dialog-footer');
export const Tabs = divComponent('tabs tabs-border ui-tabs');
export const FormRow = divComponent('ui-form-row');
export const SectionHeader = divComponent('ui-section-header');
export const Actions = divComponent('ui-actions');
export const Toolbar = divComponent('ui-toolbar');
export const DataTable = divComponent('ui-data-table');
export const Notice = divComponent('alert alert-soft ui-notice');
export const EmptyState = divComponent('ui-empty-state');
export const MenuSurface = divComponent('menu menu-sm ui-menu');
export const MenuItem = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<'button'>>(function MenuItem(
  { className, ...props },
  ref,
) {
  return <button {...props} ref={ref} className={cx('btn btn-sm btn-ghost ui-menu-item', className)} />;
});
export const NavItem = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<'button'>>(function NavItem(
  { className, ...props },
  ref,
) {
  return <button {...props} ref={ref} className={cx('btn btn-sm btn-ghost ui-nav-item', className)} />;
});
export const SectionPanel = forwardRef<HTMLElement, ComponentPropsWithoutRef<'section'>>(
  function SectionPanel({ className, ...props }, ref) {
    return <section {...props} ref={ref} className={cx('card ui-panel', className)} />;
  },
);
export const AsidePanel = forwardRef<HTMLElement, ComponentPropsWithoutRef<'aside'>>(function AsidePanel(
  { className, ...props },
  ref,
) {
  return <aside {...props} ref={ref} className={cx('card ui-panel', className)} />;
});
export const DialogForm = forwardRef<HTMLFormElement, ComponentPropsWithoutRef<'form'>>(function DialogForm(
  { className, ...props },
  ref,
) {
  return <form {...props} ref={ref} className={cx('modal-box ui-dialog-panel', className)} />;
});
export const Field = forwardRef<HTMLLabelElement, ComponentPropsWithoutRef<'label'>>(function Field(
  { className, htmlFor, children, ...props },
  ref,
) {
  return (
    <label {...props} htmlFor={htmlFor} ref={ref} className={cx('ui-field', className)}>
      {children}
    </label>
  );
});
export const Table = forwardRef<HTMLTableElement, ComponentPropsWithoutRef<'table'>>(function Table(
  { className, ...props },
  ref,
) {
  return <table {...props} ref={ref} className={cx('table table-sm ui-table', className)} />;
});
export const NoticeText = forwardRef<HTMLParagraphElement, ComponentPropsWithoutRef<'p'>>(function NoticeText(
  { className, ...props },
  ref,
) {
  return <p {...props} ref={ref} className={cx('alert alert-soft ui-notice', className)} />;
});
