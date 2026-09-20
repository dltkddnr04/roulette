import { Scale } from 'lucide-react';
import { useState } from 'react';
import type { FairnessState } from '../../fairness';
import { SettingsRow } from './SettingsRow';
import { SettingsToggle } from './SettingsToggle';

export type FairnessSettingsProps = {
  state: FairnessState | null;
  onEnabled: (enabled: boolean) => void;
  onModeChange: (mode: FairnessState['mode']) => void;
  onProfileSelect: (profileId: string) => void;
  onProfileCreate: () => void;
  onProfileRename: () => void;
  onProfileDuplicate: () => void;
  onAddParticipant: (name: string) => void;
  onRename: (participantId: string, currentName: string) => void;
  onActive: (participantId: string, active: boolean) => void;
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
  onProfileSelect,
  onProfileCreate,
  onProfileRename,
  onProfileDuplicate,
  onAddParticipant,
  onRename,
  onActive,
  onExcluded,
  onNewEpoch,
  onVoid,
  onExport,
  onImport,
  onDelete,
}: FairnessSettingsProps) {
  const complete = state?.mode === 'complete';
  const [newParticipant, setNewParticipant] = useState('');

  return (
    <div className="settings-fairness">
      <SettingsRow className="settings-row-fairness" label={<span data-trans>Cumulative fairness</span>} icon={Scale}>
        <SettingsToggle
          id="chkFairness"
          label={<span data-trans>Enabled</span>}
          checked={state?.enabled ?? false}
          disabled={state !== null && !state.available}
          onChange={onEnabled}
          className="settings-fairness-enabled"
        />
      </SettingsRow>
      {state?.enabled ? (
        <div className="settings-fairness-details">
          <SettingsRow className="settings-row-fairness-profile" label={<span data-trans>Profile</span>}>
            <select
              id="sltFairnessProfile"
              value={state.activeProfileId}
              onChange={(event) => onProfileSelect(event.currentTarget.value)}
            >
              {state.profiles.map((profile) => (
                <option value={profile.id} key={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={onProfileCreate} data-trans>
              New
            </button>
            <button type="button" onClick={onProfileRename} data-trans>
              Rename
            </button>
            <button type="button" onClick={onProfileDuplicate} data-trans>
              Duplicate
            </button>
          </SettingsRow>
          <SettingsRow
            className="settings-row-fairness-mode"
            label={<span data-trans>Mode</span>}
            htmlFor="sltFairnessMode"
          >
            <select
              id="sltFairnessMode"
              value={state.mode}
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
          </SettingsRow>
          {state.error ? <div className="fairness-error">{state.error}</div> : null}
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
          <h4 className="settings-section-heading" data-trans>
            Participants
          </h4>
          <form
            className="settings-fairness-add-participant"
            onSubmit={(event) => {
              event.preventDefault();
              const name = newParticipant.trim();
              if (!name) return;
              onAddParticipant(name);
              setNewParticipant('');
            }}
          >
            <input
              value={newParticipant}
              onChange={(event) => setNewParticipant(event.currentTarget.value)}
              aria-label="Add fairness participant"
              placeholder="Add participant"
            />
            <button type="submit" data-trans>
              Add
            </button>
          </form>
          <div className="settings-table-wrapper settings-fairness-participants">
            <table className="settings-table settings-fairness-participant-table">
              <thead>
                <tr>
                  <th scope="col" data-trans>
                    Participant
                  </th>
                  {complete ? (
                    <>
                      <th scope="col" data-trans>
                        Actual
                      </th>
                      <th scope="col" data-trans>
                        Fairness
                      </th>
                      <th scope="col" data-trans>
                        Credit
                      </th>
                      <th scope="col" data-trans>
                        Effective
                      </th>
                    </>
                  ) : (
                    <th scope="col" data-trans>
                      Wins
                    </th>
                  )}
                  <th scope="col" data-trans>
                    Active
                  </th>
                  <th scope="col" data-trans>
                    Excluded
                  </th>
                  <th scope="col" data-trans>
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.participants.map((participant) => (
                  <tr className={`fairness-participant${participant.active ? '' : ' inactive'}`} key={participant.id}>
                    <th scope="row" className="fairness-participant-name-cell">
                      <span className="fairness-participant-name">{participant.displayName}</span>
                      {complete ? (
                        <>
                          <code className="fairness-participant-id">{participant.id}</code>
                          <span className="fairness-status">
                            {participant.active ? 'active' : 'inactive'} · {participant.participationHistory.length}{' '}
                            status changes
                          </span>
                        </>
                      ) : null}
                    </th>
                    {complete ? (
                      <>
                        <td>{participant.actualWins}</td>
                        <td>{participant.fairnessCountedWins}</td>
                        <td>{participant.balanceCredit}</td>
                        <td>{participant.effectiveBalance}</td>
                      </>
                    ) : (
                      <td>{participant.currentEpochWins}</td>
                    )}
                    <td>
                      <label htmlFor={`active-${participant.id}`}>
                        <input
                          type="checkbox"
                          id={`active-${participant.id}`}
                          aria-label={`Activate ${participant.displayName}`}
                          checked={participant.active}
                          onChange={(event) => onActive(participant.id, event.currentTarget.checked)}
                        />
                      </label>
                    </td>
                    <td>
                      <label className="settings-fairness-excluded" htmlFor={`exclude-${participant.id}`}>
                        <input
                          type="checkbox"
                          id={`exclude-${participant.id}`}
                          aria-label={`Exclude ${participant.displayName}`}
                          checked={participant.excluded}
                          onChange={(event) => onExcluded(participant.id, event.currentTarget.checked)}
                        />
                      </label>
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() => onRename(participant.id, participant.displayName)}
                        data-trans
                      >
                        Rename
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state.recentDraws.length > 0 ? (
            <>
              <h4 className="settings-section-heading" data-trans>
                History
              </h4>
              <div className="settings-table-wrapper settings-fairness-history">
                <table className="settings-table settings-fairness-history-table">
                  <thead>
                    <tr>
                      <th scope="col" data-trans>
                        Time
                      </th>
                      <th scope="col" data-trans>
                        Winner
                      </th>
                      <th scope="col" data-trans>
                        Status
                      </th>
                      {complete ? (
                        <>
                          <th scope="col" data-trans>
                            Map
                          </th>
                          <th scope="col" data-trans>
                            Seed
                          </th>
                          <th scope="col" data-trans>
                            Action
                          </th>
                        </>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {state.recentDraws.map((draw) => (
                      <tr className="fairness-draw" key={draw.id}>
                        <td className="fairness-draw-time">
                          <time dateTime={new Date(draw.confirmedAt ?? draw.preparedAt).toISOString()}>
                            {new Date(draw.confirmedAt ?? draw.preparedAt).toLocaleString()}
                          </time>
                          {complete ? (
                            <details className="fairness-draw-details">
                              <summary data-trans>Details</summary>
                              <div className="fairness-draw-details-content">
                                {draw.mapTitle} · {String(draw.seed)} · {draw.rawParticipantInputs.join(', ')} ·{' '}
                                {draw.policy.id} ·{' '}
                                {draw.entries
                                  .map(
                                    (entry) =>
                                      `${entry.displayName} (${entry.memberIds
                                        .map(
                                          (memberId) =>
                                            draw.members.find((member) => member.participantId === memberId)
                                              ?.displayName
                                        )
                                        .filter((name): name is string => name !== undefined)
                                        .join(' + ')})`
                                  )
                                  .join(', ')}
                              </div>
                            </details>
                          ) : null}
                        </td>
                        <td>{draw.winners.map((winner) => winner.entryDisplayName).join(', ') || '—'}</td>
                        <td>{draw.status}</td>
                        {complete ? (
                          <>
                            <td>{draw.mapTitle}</td>
                            <td>{String(draw.seed)}</td>
                            <td>
                              {draw.status === 'confirmed' ? (
                                <button type="button" onClick={() => onVoid(draw.id)} data-trans>
                                  Void
                                </button>
                              ) : null}
                            </td>
                          </>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
