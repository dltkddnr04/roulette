import type { ReactNode } from 'react';

export type SettingsRowProps = {
  label?: ReactNode;
  htmlFor?: string;
  icon?: string;
  className?: string;
  children: ReactNode;
};

export function SettingsRow({ label, htmlFor, icon, className, children }: SettingsRowProps) {
  const rowClassName = ['settings-row', className].filter(Boolean).join(' ');

  return (
    <div className={rowClassName}>
      {label !== undefined ? (
        <label className="settings-row-label" htmlFor={htmlFor}>
          {icon ? <i className={`icon ${icon}`} aria-hidden="true"></i> : null}
          {label}
        </label>
      ) : null}
      <div className="settings-row-control">{children}</div>
    </div>
  );
}
