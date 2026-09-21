import { Share2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { createRoomJoinUrl, type SharedRoomConnectionStatus } from '../../sharedRoomClient';
import { SettingsRow } from './SettingsRow';
import { SettingsToggle } from './SettingsToggle';

export type SharingSettingsProps = {
  disabled?: boolean;
  active: boolean;
  creating: boolean;
  roomCode: string | null;
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
  roomCode: hostRoomCode,
  connectionStatus,
  participantCount,
  error,
  onEnabled,
  onJoinRoom,
}: SharingSettingsProps) {
  const [joinRoomCode, setJoinRoomCode] = useState('');
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const shareUrl = hostRoomCode ? createRoomJoinUrl(hostRoomCode) : null;

  useEffect(() => {
    setShareLinkCopied(false);
  }, [hostRoomCode]);

  const handleJoin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = joinRoomCode.replace(/\s+/g, '').toUpperCase();
    if (!normalized) return;
    onJoinRoom(normalized);
  };

  const handleCopyShareLink = async () => {
    if (!shareUrl) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(shareUrl);
      setShareLinkCopied(true);
    } catch {
      window.prompt('Copy this share link', shareUrl);
    }
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
          {shareUrl ? (
            <div className="settings-sharing-actions">
              <a href={shareUrl} target="_blank" rel="noopener noreferrer" data-trans>
                Open participant page
              </a>
              <button
                type="button"
                onClick={() => void handleCopyShareLink()}
                data-trans
              >
                {shareLinkCopied ? 'Copied' : 'Copy share link'}
              </button>
            </div>
          ) : null}
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
                value={joinRoomCode}
                maxLength={16}
                autoComplete="off"
                spellCheck={false}
                placeholder="Entry code"
                disabled={disabled || creating}
                onChange={(event) => setJoinRoomCode(event.currentTarget.value)}
              />
              <button type="submit" disabled={disabled || creating || !joinRoomCode.trim()} data-trans>
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
