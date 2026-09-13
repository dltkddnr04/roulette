import type { FairnessState } from '../../fairness';
import { SettingsRow } from './SettingsRow';
import { SettingsToggle } from './SettingsToggle';

export type FairnessSettingsProps = {
  state: FairnessState | null;
  onEnabled: (enabled: boolean) => void;
  onModeChange: (mode: FairnessState['mode']) => void;
  onRename: (participantId: string, currentName: string) => void;
  onExcluded: (participantId: string, excluded: boolean) => void;
  onNewEpoch: () => void;
  onVoid: (drawId: string) => void;
  onExport: () => void;
  onImport: (value: string) => void;
  onDelete: () => void;
};

export function FairnessSettings({
  state,
  onEnabled,
  onModeChange,
  onRename,
  onExcluded,
  onNewEpoch,
  onVoid,
  onExport,
  onImport,
  onDelete,
}: FairnessSettingsProps) {
  const complete = state?.mode === 'complete';

  return (
    <SettingsRow className="settings-row-fairness" label={<span data-trans>Cumulative fairness</span>}>
      <div className="settings-fairness-controls">
        <div className="settings-fairness-toolbar">
          <SettingsToggle
            id="chkFairness"
            label={<span data-trans>Enabled</span>}
            checked={state?.enabled ?? false}
            disabled={state !== null && !state.available}
            onChange={onEnabled}
            className="settings-fairness-enabled"
          />
          <select
            id="sltFairnessMode"
            value={state?.mode ?? 'simple'}
            onChange={(event) => {
              if (event.currentTarget.value === 'simple' || event.currentTarget.value === 'complete') {
                onModeChange(event.currentTarget.value);
              }
            }}
          >
            <option value="simple" data-trans>
              Simple
            </option>
            <option value="complete" data-trans>
              Complete
            </option>
          </select>
        </div>
        {state?.error ? <div className="fairness-error">{state.error}</div> : null}
        {state?.enabled ? (
          <>
            <div className="settings-fairness-actions">
              <button type="button" onClick={onNewEpoch} data-trans>
                Start a new fairness period
              </button>
              {complete ? (
                <>
                  <button type="button" onClick={onExport} data-trans>
                    Export
                  </button>
                  <label className="settings-fairness-import" htmlFor="inFairnessImport">
                    <span data-trans>Import</span>
                    <input
                      type="file"
                      id="inFairnessImport"
                      accept="application/json,.json"
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = '';
                        if (!file) return;
                        void file
                          .text()
                          .then(onImport)
                          .catch(() => undefined);
                      }}
                    />
                  </label>
                  <button type="button" onClick={onDelete} data-trans>
                    Delete history
                  </button>
                </>
              ) : null}
            </div>
            <div className="settings-fairness-participants">
              {state.participants.map((participant) => (
                <div className={`fairness-participant${participant.active ? '' : ' inactive'}`} key={participant.id}>
                  <span className="fairness-participant-name">{participant.displayName}</span>
                  {complete ? <code>{participant.id}</code> : null}
                  <span className="fairness-stats">
                    {complete
                      ? `actual ${participant.actualWins} · fairness ${participant.fairnessCountedWins} · credit ${participant.balanceCredit} · effective ${participant.effectiveBalance}`
                      : `wins ${participant.currentEpochWins}`}
                  </span>
                  {complete ? (
                    <span className="fairness-status">
                      {participant.active ? 'active' : 'inactive'} · {participant.participationHistory.length} status
                      changes
                    </span>
                  ) : null}
                  <label className="settings-fairness-excluded" htmlFor={`exclude-${participant.id}`}>
                    <span data-trans>Excluded</span>
                    <input
                      type="checkbox"
                      id={`exclude-${participant.id}`}
                      checked={participant.excluded}
                      onChange={(event) => onExcluded(participant.id, event.currentTarget.checked)}
                    />
                  </label>
                  <button type="button" onClick={() => onRename(participant.id, participant.displayName)} data-trans>
                    Rename
                  </button>
                </div>
              ))}
            </div>
            {state.recentDraws.length > 0 ? (
              <div className="settings-fairness-history">
                {state.recentDraws.map((draw) => (
                  <div className="fairness-draw" key={draw.id}>
                    <span>
                      {new Date(draw.confirmedAt ?? draw.preparedAt).toLocaleString()} · {draw.status} ·{' '}
                      {draw.winners.map((winner) => winner.entryDisplayName).join(', ') || '—'}
                    </span>
                    {complete ? (
                      <span className="fairness-draw-details">
                        {draw.mapTitle} · {String(draw.seed)} · {draw.rawParticipantInputs.join(', ')} ·{' '}
                        {draw.policy.id} ·{' '}
                        {draw.entries
                          .map(
                            (entry) =>
                              `${entry.displayName} (${entry.memberIds
                                .map(
                                  (memberId) =>
                                    draw.members.find((member) => member.participantId === memberId)?.displayName
                                )
                                .filter((name): name is string => name !== undefined)
                                .join(' + ')})`
                          )
                          .join(', ')}
                      </span>
                    ) : null}
                    {complete && draw.status === 'confirmed' ? (
                      <button type="button" onClick={() => onVoid(draw.id)} data-trans>
                        Void
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </SettingsRow>
  );
}
