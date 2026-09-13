import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export type SettingsToggleProps = {
  id: string;
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  icon?: LucideIcon;
  disabled?: boolean;
  className?: string;
};

export function SettingsToggle({ id, label, checked, onChange, icon, disabled, className }: SettingsToggleProps) {
  const toggleClassName = ['settings-toggle', className].filter(Boolean).join(' ');
  const Icon = icon;

  return (
    <label className={toggleClassName} htmlFor={id}>
      <span className="settings-toggle-label">
        {Icon ? <Icon className="settings-icon" aria-hidden="true" /> : null}
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
