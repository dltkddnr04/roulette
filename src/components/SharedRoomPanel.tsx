import QRCode from 'qrcode';
import { useEffect, useRef } from 'react';
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
  guestSessionState: SharedRoomGuestSessionState;
  error: string | null;
  onLeave: () => void;
};

export type SharedRoomGuestSessionState = 'restoring' | 'joined' | 'error';

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
}: Pick<SharedRoomPanelProps, 'client'>) {
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

  return (
    <div className="shared-room-host" aria-label="Shared room join code">
      <div className="shared-room-qr-wrap">
        <canvas ref={canvasRef} aria-label="Shared room join QR code" />
      </div>
      <code className="shared-room-code">{client?.roomCode}</code>
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
  guestSessionState,
  error,
  onLeave,
}: SharedRoomPanelProps) {
  const guestRoomCode = roomCode ?? client?.roomCode ?? null;
  const isGuest = client?.role === 'guest' || guestRoomCode !== null;
  const joined = guestSessionState === 'joined';
  const currentRoundStatus = roundStatus ?? snapshot?.scheduledRound?.status ?? null;

  if (client?.role === 'host') {
    return <HostRoom client={client} />;
  }

  if (isGuest) {
    if (!joined) {
      return (
        <div className="shared-room-guest shared-room-lobby">
          <div className="shared-room-header">
            <strong data-trans>Shared room</strong>
            {client ? <ConnectionLabel status={connectionStatus} /> : null}
          </div>
          <p data-trans>
            {guestSessionState === 'restoring' ? 'Restoring participant session…' : 'Participant session is not active.'}
          </p>
          {error ? <p className="shared-room-error">{error}</p> : null}
          {guestRoomCode ? (
            <button type="button" onClick={onLeave} data-trans>
              Join this room
            </button>
          ) : null}
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
