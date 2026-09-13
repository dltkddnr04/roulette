import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export type SettingsRowProps = {
  label?: ReactNode;
  htmlFor?: string;
  icon?: LucideIcon;
  className?: string;
  children: ReactNode;
};

export function SettingsRow({ label, htmlFor, icon, className, children }: SettingsRowProps) {
  const rowClassName = ['settings-row', className].filter(Boolean).join(' ');
  const Icon = icon;

  return (
    <div className={rowClassName}>
      {label !== undefined ? (
        <label className="settings-row-label" htmlFor={htmlFor}>
          {Icon ? <Icon className="settings-icon" aria-hidden="true" /> : null}
          {label}
        </label>
      ) : null}
      <div className="settings-row-control">{children}</div>
    </div>
  );
}
