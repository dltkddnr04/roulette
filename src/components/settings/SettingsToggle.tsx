import type { ReactNode } from 'react';

export type SettingsToggleProps = {
  id: string;
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  icon?: string;
  disabled?: boolean;
  className?: string;
};

export function SettingsToggle({ id, label, checked, onChange, icon, disabled, className }: SettingsToggleProps) {
  const toggleClassName = ['settings-toggle', className].filter(Boolean).join(' ');

  return (
    <label className={toggleClassName} htmlFor={id}>
      <span className="settings-toggle-label">
        {icon ? <i className={`icon ${icon}`} aria-hidden="true"></i> : null}
        {label}
      </span>
      <input
        type="checkbox"
        id={id}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}
