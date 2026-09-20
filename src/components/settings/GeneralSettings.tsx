import { Camera, Gauge, Map as MapIcon, Moon, Sparkles, Sun } from 'lucide-react';
import { isRenderScale, type RenderScale } from '../../options';
import type { Roulette } from '../../roulette';
import { SettingsRow } from './SettingsRow';
import { SettingsToggle } from './SettingsToggle';
import type { WinnerSettingsProps } from './WinnerSettings';
import { WinnerSettings } from './WinnerSettings';

export type GeneralSettingsProps = {
  disabled?: boolean;
  maps: ReturnType<Roulette['getMaps']>;
  mapIndex: number;
  onMapChange: (index: number) => void;
  renderScale: RenderScale;
  onRenderScaleChange: (value: RenderScale) => void;
  autoRecording: boolean;
  onAutoRecordingChange: (value: boolean) => void;
  useSkills: boolean;
  onSkillsChange: (value: boolean) => void;
  darkMode: boolean;
  onDarkModeChange: (value: boolean) => void;
  winnerSettings: WinnerSettingsProps;
};

export function GeneralSettings({
  disabled = false,
  maps,
  mapIndex,
  onMapChange,
  renderScale,
  onRenderScaleChange,
  autoRecording,
  onAutoRecordingChange,
  useSkills,
  onSkillsChange,
  darkMode,
  onDarkModeChange,
  winnerSettings,
}: GeneralSettingsProps) {
  return (
    <div className="settings-general">
      <div className="settings-general-list">
        <div className="settings-general-group settings-general-group-map">
          <SettingsRow label={<span data-trans>Map</span>} htmlFor="sltMap" icon={MapIcon}>
            <select
              id="sltMap"
              value={mapIndex}
              disabled={disabled}
              onChange={(event) => onMapChange(Number(event.currentTarget.value))}
            >
              {maps.map((map) => (
                <option key={map.index} value={map.index} data-trans>
                  {map.title}
                </option>
              ))}
            </select>
          </SettingsRow>
          <SettingsRow label={<span data-trans>Render quality</span>} htmlFor="sltRenderScale" icon={Gauge}>
            <select
              id="sltRenderScale"
              value={renderScale}
              disabled={disabled}
              onChange={(event) => {
                const value = Number(event.currentTarget.value);
                if (isRenderScale(value)) onRenderScaleChange(value);
              }}
            >
              <option value="0.5" data-trans>
                Performance
              </option>
              <option value="1" data-trans>
                Native
              </option>
            </select>
          </SettingsRow>
        </div>
        <div className="settings-general-group settings-general-group-toggles">
          <SettingsToggle
            id="chkAutoRecording"
            label={<span data-trans>Recording</span>}
            icon={Camera}
            checked={autoRecording}
            disabled={disabled}
            onChange={onAutoRecordingChange}
          />
          <SettingsToggle
            id="chkSkill"
            label={<span data-trans>Using skills</span>}
            icon={Sparkles}
            checked={useSkills}
            disabled={disabled}
            onChange={onSkillsChange}
          />
        </div>
        <div className="settings-general-group settings-general-group-winner">
          <WinnerSettings {...winnerSettings} disabled={disabled} />
        </div>
        <div className="settings-general-group settings-general-group-theme">
          <SettingsRow className="settings-row-theme" label={<span data-trans>Theme</span>} htmlFor="chkDarkMode">
            <div className="theme">
              <Sun className="settings-icon" aria-hidden="true" />
              <input
                type="checkbox"
                id="chkDarkMode"
                checked={darkMode}
                disabled={disabled}
                aria-label="Dark mode"
                onChange={(event) => onDarkModeChange(event.currentTarget.checked)}
              />
              <Moon className="settings-icon" aria-hidden="true" />
            </div>
          </SettingsRow>
        </div>
      </div>
    </div>
  );
}
