import { Image as ImageIcon } from 'lucide-react';
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
    <div className="settings-branding">
      <SettingsRow
        className="settings-row-sponsors"
        label={<span data-trans>Branding &amp; Sponsors</span>}
        icon={ImageIcon}
      >
        <SettingsToggle
          id="chkSponsorsEnabled"
          label={<span data-trans>Enabled</span>}
          checked={state?.enabled ?? false}
          onChange={onEnabled}
          className="settings-sponsor-enabled"
        />
      </SettingsRow>
      <div className="settings-sponsor-controls">
        <SettingsRow
          className="settings-row-sponsor-asset"
          label={<span data-trans>Asset</span>}
          htmlFor="inSponsorFiles"
        >
          <input type="file" id="inSponsorFiles" accept="image/*" multiple onChange={onUpload} />
        </SettingsRow>
        <SettingsRow label={<span data-trans>Sponsor</span>} htmlFor="sltSponsor">
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
        </SettingsRow>
        <div className="settings-sponsor-actions">
          <button type="button" id="btnDeleteSponsor" disabled={!state?.selectedAssetId} onClick={onDelete}>
            Delete selected
          </button>
        </div>
      </div>
    </div>
  );
}
