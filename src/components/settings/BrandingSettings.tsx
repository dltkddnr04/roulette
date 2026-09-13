import type { ChangeEvent } from 'react';
import type { SponsorState } from '../../sponsorStore';
import { SettingsRow } from './SettingsRow';
import { SettingsToggle } from './SettingsToggle';

export type BrandingSettingsProps = {
  state: SponsorState | null;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onSelect: (assetId: string | null) => void;
  onEnabled: (enabled: boolean) => void;
  onDelete: () => void;
};

export function BrandingSettings({ state, onUpload, onSelect, onEnabled, onDelete }: BrandingSettingsProps) {
  return (
    <SettingsRow
      className="settings-row-sponsors"
      label={<span data-trans>Branding &amp; Sponsors</span>}
      htmlFor="inSponsorFiles"
    >
      <div className="settings-sponsor-controls">
        <input type="file" id="inSponsorFiles" accept="image/*" multiple onChange={onUpload} />
        <select
          id="sltSponsor"
          value={state?.selectedAssetId ?? ''}
          onChange={(event) => onSelect(event.currentTarget.value || null)}
        >
          <option value="">No sponsor selected</option>
          {state?.assets.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.name}
            </option>
          ))}
        </select>
        <div className="settings-sponsor-actions">
          <SettingsToggle
            id="chkSponsorsEnabled"
            label={<span>Enabled</span>}
            checked={state?.enabled ?? false}
            onChange={onEnabled}
            className="settings-sponsor-enabled"
          />
          <button type="button" id="btnDeleteSponsor" disabled={!state?.selectedAssetId} onClick={onDelete}>
            Delete selected
          </button>
        </div>
      </div>
    </SettingsRow>
  );
}
