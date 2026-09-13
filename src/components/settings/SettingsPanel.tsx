import type { BrandingSettingsProps } from './BrandingSettings';
import { BrandingSettings } from './BrandingSettings';
import type { FairnessSettingsProps } from './FairnessSettings';
import { FairnessSettings } from './FairnessSettings';
import type { GeneralSettingsProps } from './GeneralSettings';
import { GeneralSettings } from './GeneralSettings';
import { type SettingsTabDefinition, SettingsTabs } from './SettingsTabs';

export type SettingsPanelProps = {
  collapsed: boolean;
  onToggle: () => void;
  generalSettings: GeneralSettingsProps;
  brandingSettings: BrandingSettingsProps;
  fairnessSettings: FairnessSettingsProps;
};

export function SettingsPanel({
  collapsed,
  onToggle,
  generalSettings,
  brandingSettings,
  fairnessSettings,
}: SettingsPanelProps) {
  const tabs: readonly SettingsTabDefinition[] = [
    {
      id: 'general',
      label: 'General',
      content: <GeneralSettings {...generalSettings} />,
    },
    {
      id: 'fairness',
      label: 'Fairness',
      content: <FairnessSettings {...fairnessSettings} />,
    },
    {
      id: 'branding',
      label: 'Branding',
      content: <BrandingSettings {...brandingSettings} />,
    },
  ];

  return (
    <div className="settings-panel">
      <button
        type="button"
        className="btn-toggle-settings"
        aria-expanded={!collapsed}
        aria-controls="settings-tab-content"
        onClick={onToggle}
      >
        <span data-trans>Settings</span>
        <i className="toggle-arrow" aria-hidden="true">
          {collapsed ? '▲' : '▼'}
        </i>
      </button>
      <div id="settings-tab-content" className={`settings-collapsible${collapsed ? ' collapsed' : ''}`}>
        <SettingsTabs tabs={tabs} id="settings-tabs" defaultTabId="general" />
      </div>
    </div>
  );
}
