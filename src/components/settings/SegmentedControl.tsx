import type { ReactNode } from 'react';

export type SegmentedControlOption = {
  value: string;
  label: ReactNode;
  active?: boolean;
  disabled?: boolean;
  className?: string;
};

export type SegmentedControlProps = {
  options?: readonly SegmentedControlOption[];
  value?: string;
  onChange?: (value: string) => void;
  children?: ReactNode;
  className?: string;
};

export function SegmentedControl({ options, value, onChange, children, className }: SegmentedControlProps) {
  const controlClassName = ['settings-segmented-control', 'btn-group', className].filter(Boolean).join(' ');

  return (
    <div className={controlClassName}>
      {options
        ? options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={[option.className, value === option.value || option.active ? 'active' : null]
                .filter(Boolean)
                .join(' ')}
              disabled={option.disabled}
              onClick={() => onChange?.(option.value)}
            >
              {option.label}
            </button>
          ))
        : children}
    </div>
  );
}
