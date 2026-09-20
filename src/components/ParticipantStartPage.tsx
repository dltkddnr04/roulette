import { useEffect, useRef, useState, type FormEvent } from 'react';
import { translateTree } from '../localization';
import {
  createRoomPlaybackUrl,
  getRoomCodeFromLocation,
  normalizeRoomCode,
  SharedRoomClient,
} from '../sharedRoomClient';
import {
  isValidRoomCode,
  isValidRoomDisplayName,
  normalizeRoomDisplayName,
} from '../sharedRoomProtocol';

export function ParticipantStartPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [roomCode, setRoomCode] = useState(() => getRoomCodeFromLocation() ?? '');
  const [displayName, setDisplayName] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (rootRef.current) translateTree(rootRef.current);
  });

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (joining) return;

    const normalizedRoomCode = normalizeRoomCode(roomCode);
    if (!isValidRoomCode(normalizedRoomCode)) {
      setError('Enter a valid room code');
      return;
    }

    const normalizedName = normalizeRoomDisplayName(displayName);
    if (!isValidRoomDisplayName(normalizedName)) {
      setError('Enter a valid participant name');
      return;
    }

    setJoining(true);
    setError(null);
    const client = SharedRoomClient.forGuest(normalizedRoomCode);
    try {
      await client.join(normalizedName);
      // Guest disconnect intentionally preserves the room-local resume session;
      // the playback page creates a fresh client from that session.
      client.disconnect();
      window.location.replace(createRoomPlaybackUrl(normalizedRoomCode));
    } catch (joinError) {
      client.disconnect();
      setJoining(false);
      setError(joinError instanceof Error ? joinError.message : 'Could not join the shared room');
    }
  };

  return (
    <main ref={rootRef} className="participant-start-page">
      <section className="participant-start-card" aria-labelledby="participant-start-title">
        <h1 id="participant-start-title">Marble Roulette</h1>
        <p className="participant-start-description" data-trans>
          Join the shared roulette
        </p>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <label htmlFor="participant-room-code" data-trans>
            Entry code
          </label>
          <input
            id="participant-room-code"
            value={roomCode}
            maxLength={16}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            onChange={(event) => setRoomCode(event.currentTarget.value)}
            disabled={joining}
            autoFocus={!roomCode}
          />

          <label htmlFor="participant-display-name" data-trans>
            Your name
          </label>
          <input
            id="participant-display-name"
            value={displayName}
            maxLength={128}
            autoComplete="name"
            onChange={(event) => setDisplayName(event.currentTarget.value)}
            disabled={joining}
            autoFocus={Boolean(roomCode)}
          />

          <button type="submit" disabled={joining} data-trans>
            {joining ? 'Joining…' : 'Join'}
          </button>
        </form>
        {error ? (
          <p className="participant-start-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  );
}
