import { Share2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { SharedRoomConnectionStatus } from '../../sharedRoomClient';
import { SettingsRow } from './SettingsRow';
import { SettingsToggle } from './SettingsToggle';

export type SharingSettingsProps = {
  disabled?: boolean;
  active: boolean;
  creating: boolean;
  connectionStatus: SharedRoomConnectionStatus;
  participantCount: number;
  error: string | null;
  onEnabled: (enabled: boolean) => void;
  onJoinRoom: (roomCode: string) => void;
};

function connectionLabel(status: SharedRoomConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'error':
      return 'Connection error';
    case 'closed':
      return 'Closed';
    default:
      return 'Not connected';
  }
}

export function SharingSettings({
  disabled = false,
  active,
  creating,
  connectionStatus,
  participantCount,
  error,
  onEnabled,
  onJoinRoom,
}: SharingSettingsProps) {
  const [roomCode, setRoomCode] = useState('');

  const handleJoin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = roomCode.replace(/\s+/g, '').toUpperCase();
    if (!normalized) return;
    onJoinRoom(normalized);
  };

  return (
    <div className="settings-sharing">
      <SettingsRow className="settings-row-sharing" label={<span data-trans>Shared room</span>} icon={Share2}>
        <SettingsToggle
          id="chkSharedRoom"
          label={<span data-trans>Enabled</span>}
          checked={active}
          disabled={disabled || creating}
          onChange={onEnabled}
          className="settings-sharing-enabled"
        />
      </SettingsRow>
      {creating ? (
        <p className="settings-sharing-help" data-trans>
          Creating room…
        </p>
      ) : active ? (
        <div className="settings-sharing-status">
          <div>
            <span data-trans>Status</span>: {connectionLabel(connectionStatus)}
          </div>
          <div>
            <span data-trans>Participants</span>: {participantCount}
          </div>
          <p className="settings-sharing-help" data-trans>
            The QR code and entry code are shown in the top-right corner.
          </p>
        </div>
      ) : (
        <>
          <p className="settings-sharing-help" data-trans>
            Host a shared roulette with a QR code or entry code.
          </p>
          <form className="settings-sharing-join" onSubmit={handleJoin}>
            <label htmlFor="inSharedRoomCode" data-trans>
              Join a room
            </label>
            <div className="settings-sharing-join-controls">
              <input
                id="inSharedRoomCode"
                value={roomCode}
                maxLength={16}
                autoComplete="off"
                spellCheck={false}
                placeholder="Entry code"
                disabled={disabled || creating}
                onChange={(event) => setRoomCode(event.currentTarget.value)}
              />
              <button type="submit" disabled={disabled || creating || !roomCode.trim()} data-trans>
                Join
              </button>
            </div>
          </form>
        </>
      )}
      {error ? <p className="shared-room-error settings-sharing-error">{error}</p> : null}
    </div>
  );
}
