import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import type { RoomRoundStatus, RoomSnapshot } from '../sharedRoomProtocol';
import {
  createRoomJoinUrl,
  type SharedRoomClient,
  type SharedRoomConnectionStatus,
} from '../sharedRoomClient';

export type SharedRoomPanelProps = {
  client: SharedRoomClient | null;
  snapshot: RoomSnapshot | null;
  connectionStatus: SharedRoomConnectionStatus;
  roomCode: string | null;
  roundStatus: RoomRoundStatus | null;
  playbackActive: boolean;
  error: string | null;
  onJoin: (name: string) => void;
  onLeave: () => void;
};

function ConnectionLabel({ status }: { status: SharedRoomConnectionStatus }) {
  switch (status) {
    case 'connected':
      return <span className="shared-room-status connected">Connected</span>;
    case 'connecting':
      return <span className="shared-room-status">Connecting…</span>;
    case 'reconnecting':
      return <span className="shared-room-status">Reconnecting…</span>;
    case 'error':
      return <span className="shared-room-status error">Connection error</span>;
    case 'closed':
      return <span className="shared-room-status">Closed</span>;
    default:
      return <span className="shared-room-status">Not connected</span>;
  }
}

function HostRoom({
  client,
  snapshot,
  connectionStatus,
}: Pick<SharedRoomPanelProps, 'client' | 'snapshot' | 'connectionStatus'>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const joinUrl = client ? createRoomJoinUrl(client.roomCode) : '';

  useEffect(() => {
    if (!canvasRef.current || !joinUrl) return;
    void QRCode.toCanvas(canvasRef.current, joinUrl, {
      errorCorrectionLevel: 'M',
      margin: 3,
      width: 220,
      color: { dark: '#111111', light: '#ffffff' },
    }).catch(() => undefined);
  }, [joinUrl]);

  const copyLink = async () => {
    if (!joinUrl) return;
    try {
      await navigator.clipboard.writeText(joinUrl);
    } catch {
      window.prompt('Copy this room link', joinUrl);
    }
  };

  return (
    <div className="shared-room-host">
      <div className="shared-room-header">
        <strong data-trans>Shared room</strong>
        <ConnectionLabel status={connectionStatus} />
      </div>
      <div className="shared-room-qr-wrap">
        <canvas ref={canvasRef} aria-label="Shared room join QR code" />
      </div>
      <div className="shared-room-entry-code">
        <span className="shared-room-entry-code-label" data-trans>
          Entry code
        </span>
        <code className="shared-room-code">{client?.roomCode}</code>
      </div>
      <div className="shared-room-link" title={joinUrl}>
        {joinUrl}
      </div>
      <div className="shared-room-actions">
        <button type="button" onClick={() => void copyLink()} data-trans>
          Copy link
        </button>
      </div>
      <div className="shared-room-roster">
        <span data-trans>Joined participants</span> ({snapshot?.participants.length ?? 0})
        {snapshot?.participants.length ? (
          <ul>
            {snapshot.participants.map((participant) => (
              <li key={participant.participantId}>{participant.displayName}</li>
            ))}
          </ul>
        ) : (
          <p data-trans>Scan the QR code to join.</p>
        )}
      </div>
    </div>
  );
}

export function SharedRoomPanel({
  client,
  snapshot,
  connectionStatus,
  roomCode,
  roundStatus,
  playbackActive,
  error,
  onJoin,
  onLeave,
}: SharedRoomPanelProps) {
  const [name, setName] = useState('');
  const guestRoomCode = roomCode ?? client?.roomCode ?? null;
  const isGuest = client?.role === 'guest' || guestRoomCode !== null;
  const joined = Boolean(client?.currentParticipantId);
  const currentRoundStatus = roundStatus ?? snapshot?.scheduledRound?.status ?? null;

  if (client?.role === 'host') {
    return <HostRoom client={client} snapshot={snapshot} connectionStatus={connectionStatus} />;
  }

  if (isGuest) {
    if (!joined) {
      return (
        <div className="shared-room-guest shared-room-join">
          <div className="shared-room-header">
            <strong data-trans>Join shared room</strong>
            {client ? <ConnectionLabel status={connectionStatus} /> : null}
          </div>
          <div className="shared-room-code">Room {guestRoomCode}</div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) onJoin(name);
            }}
          >
            <label htmlFor="shared-room-name" data-trans>Your name</label>
            <input
              id="shared-room-name"
              value={name}
              maxLength={128}
              autoComplete="name"
              onChange={(event) => setName(event.currentTarget.value)}
              autoFocus
            />
            <button type="submit" data-trans>
              Join
            </button>
          </form>
          {error ? <p className="shared-room-error">{error}</p> : null}
        </div>
      );
    }

    if (playbackActive) return null;

    return (
      <div className="shared-room-guest shared-room-lobby">
        <div className="shared-room-header">
          <strong data-trans>Shared room</strong>
          <ConnectionLabel status={connectionStatus} />
        </div>
        <p>
          <span data-trans>Joined as</span> {client?.currentDisplayName}
        </p>
        <p data-trans>
          {currentRoundStatus === 'scheduled'
            ? 'Starting…'
            : currentRoundStatus === 'running'
              ? "Round in progress — you'll join the next round."
              : 'Waiting for the host to start the next round.'}
        </p>
        <p>
          <span data-trans>Participants</span>: {snapshot?.participants.length ?? 0}
        </p>
        <button type="button" onClick={onLeave} data-trans>
          Leave room
        </button>
        {error ? <p className="shared-room-error">{error}</p> : null}
      </div>
    );
  }

  return null;
}
