import {
  SHARED_ROOM_PROTOCOL_VERSION,
  type ReplayDescriptor,
  type RoomParticipant,
  type RoomSnapshot,
  type RoomServerMessage,
  type ScheduledRound,
  parseRoomServerMessage,
  normalizeRoomDisplayName,
} from './sharedRoomProtocol';

export type SharedRoomRole = 'host' | 'guest';
export type SharedRoomConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';

export type SharedRoomClientEvent =
  | Readonly<{ type: 'snapshot'; snapshot: RoomSnapshot }>
  | Readonly<{ type: 'joined'; participantId: string; snapshot: RoomSnapshot }>
  | Readonly<{ type: 'scheduled'; requestId: string; round: ScheduledRound }>
  | Readonly<{ type: 'started'; round: ScheduledRound }>
  | Readonly<{ type: 'result'; result: RoomSnapshot['lastResult']; snapshot: RoomSnapshot }>
  | Readonly<{ type: 'cancelled'; roundId: string; reason: string; snapshot: RoomSnapshot }>
  | Readonly<{ type: 'closed'; reason: string; snapshot: RoomSnapshot }>
  | Readonly<{ type: 'error'; code: string; message: string }>
  | Readonly<{ type: 'connection'; status: SharedRoomConnectionStatus }>;

type PendingSchedule = {
  resolve: (round: ScheduledRound) => void;
  reject: (error: Error) => void;
};

const HOST_TOKEN_PREFIX = 'mbr_shared_room_host:';
const HOST_ROOM_CODE_KEY = 'mbr_shared_room_host_code';
const GUEST_SESSION_PREFIX = 'mbr_shared_room_guest:';

function readSession(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Session storage is an optional reconnect convenience. The live socket
    // remains usable when a privacy mode blocks it.
  }
}

function removeSession(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignore storage failures while leaving a room.
  }
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let value = '';
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
  return `${prefix}-${value}`;
}

function roomStorageKey(roomCode: string): string {
  return `${GUEST_SESSION_PREFIX}${roomCode}`;
}

export function getRoomCodeFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get('room');
  return value?.trim() || null;
}

export function createRoomJoinUrl(roomCode: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', roomCode);
  return url.toString();
}

export function getStoredGuestSession(roomCode: string): Readonly<{ participantId: string; resumeToken: string }> | null {
  const raw = readSession(roomStorageKey(roomCode));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { participantId?: unknown; resumeToken?: unknown };
    if (typeof parsed.participantId !== 'string' || typeof parsed.resumeToken !== 'string') return null;
    return { participantId: parsed.participantId, resumeToken: parsed.resumeToken };
  } catch {
    return null;
  }
}

export class SharedRoomClient extends EventTarget {
  public readonly roomCode: string;
  public readonly role: SharedRoomRole;
  private readonly hostToken: string | null;
  private participantId: string | null;
  private resumeToken: string | null;
  private displayName: string | null;
  private socket: WebSocket | null = null;
  private connectionStatus: SharedRoomConnectionStatus = 'idle';
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: number | null = null;
  private disposed = false;
  private suppressReconnect = false;
  private helloSent = false;
  private sawSnapshot = false;
  private snapshot: RoomSnapshot | null = null;
  private readonly pendingSchedules = new Map<string, PendingSchedule>();
  private pingTimer: number | null = null;
  private offsetSamples: number[] = [];
  private serverClockOffsetMs = 0;

  private constructor(roomCode: string, role: SharedRoomRole, hostToken: string | null, displayName: string | null) {
    super();
    this.roomCode = roomCode;
    this.role = role;
    this.hostToken = hostToken;
    const stored = role === 'guest' ? getStoredGuestSession(roomCode) : null;
    this.participantId = stored?.participantId ?? null;
    this.resumeToken = stored?.resumeToken ?? null;
    this.displayName = displayName;
  }

  public static async createHost(): Promise<SharedRoomClient> {
    const response = await fetch('/api/rooms', { method: 'POST', headers: { Accept: 'application/json' } });
    const body = (await response.json().catch(() => null)) as {
      protocolVersion?: unknown;
      roomCode?: unknown;
      hostToken?: unknown;
    } | null;
    if (
      !response.ok ||
      !body ||
      body.protocolVersion !== SHARED_ROOM_PROTOCOL_VERSION ||
      typeof body.roomCode !== 'string' ||
      typeof body.hostToken !== 'string'
    ) {
      throw new Error('Shared room could not be created');
    }
    writeSession(`${HOST_TOKEN_PREFIX}${body.roomCode}`, body.hostToken);
    writeSession(HOST_ROOM_CODE_KEY, body.roomCode);
    const client = new SharedRoomClient(body.roomCode, 'host', body.hostToken, null);
    try {
      await client.connect();
      return client;
    } catch (error) {
      client.disconnect();
      throw error;
    }
  }

  public static forGuest(roomCode: string): SharedRoomClient {
    return new SharedRoomClient(roomCode, 'guest', null, null);
  }

  public static restoreHost(): SharedRoomClient | null {
    const roomCode = readSession(HOST_ROOM_CODE_KEY);
    if (!roomCode) return null;
    const hostToken = readSession(`${HOST_TOKEN_PREFIX}${roomCode}`);
    return hostToken ? new SharedRoomClient(roomCode, 'host', hostToken, null) : null;
  }

  public get status(): SharedRoomConnectionStatus {
    return this.connectionStatus;
  }

  public get currentSnapshot(): RoomSnapshot | null {
    return this.snapshot;
  }

  public get currentParticipantId(): string | null {
    return this.participantId;
  }

  public get currentDisplayName(): string | null {
    return this.displayName;
  }

  public setGuestDisplayName(value: string): void {
    this.displayName = normalizeRoomDisplayName(value);
  }

  public async connect(): Promise<void> {
    if (this.disposed) throw new Error('Shared room client is closed');
    if (this.connectPromise) return this.connectPromise;
    this.setStatus(this.socket ? 'reconnecting' : 'connecting');
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/rooms/${encodeURIComponent(this.roomCode)}/ws`);
      this.socket = socket;
      this.helloSent = false;
      this.sawSnapshot = false;

      socket.addEventListener('open', () => {
        this.setStatus('connected');
        this.sendHello();
        this.startClockSync();
      });
      socket.addEventListener('message', (event) => {
        this.handleMessage(event.data, resolve, reject);
      });
      socket.addEventListener('error', () => {
        if (!this.sawSnapshot) reject(new Error('Shared room connection failed'));
        this.setStatus('error');
      });
      socket.addEventListener('close', () => {
        this.stopClockSync();
        this.socket = null;
        this.connectPromise = null;
        const suppressReconnect = this.suppressReconnect;
        this.suppressReconnect = false;
        if (this.disposed) {
          this.setStatus('closed');
          return;
        }
        if (suppressReconnect) {
          this.setStatus('idle');
          return;
        }
        this.setStatus('reconnecting');
        this.scheduleReconnect();
      });
    }).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  public disconnect(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopClockSync();
    this.socket?.close();
    this.socket = null;
    if (this.role === 'host') {
      removeSession(HOST_ROOM_CODE_KEY);
      removeSession(`${HOST_TOKEN_PREFIX}${this.roomCode}`);
    }
    for (const pending of this.pendingSchedules.values()) pending.reject(new Error('Shared room disconnected'));
    this.pendingSchedules.clear();
    this.setStatus('closed');
  }

  public async join(displayName: string): Promise<void> {
    const normalized = normalizeRoomDisplayName(displayName);
    if (!normalized) throw new Error('Enter a valid participant name');
    this.displayName = normalized;
    await this.connect();
  }

  public async scheduleRound(replay: ReplayDescriptor): Promise<ScheduledRound> {
    await this.connect();
    const requestId = randomId('schedule');
    let rejectSchedule!: (error: Error) => void;
    const promise = new Promise<ScheduledRound>((resolve, reject) => {
      rejectSchedule = reject;
      this.pendingSchedules.set(requestId, { resolve, reject });
    });
    try {
      this.send({ type: 'host.schedule', requestId, replay });
    } catch (error) {
      this.pendingSchedules.delete(requestId);
      rejectSchedule(error instanceof Error ? error : new Error('Shared room is not connected'));
      throw error;
    }
    return promise;
  }

  public reportResult(roundId: string, winners: readonly string[]): void {
    try {
      this.send({ type: 'host.result', roundId, winners: [...winners] });
    } catch (error) {
      this.emit({
        type: 'error',
        code: 'connection_lost',
        message: error instanceof Error ? error.message : 'Shared room connection was lost',
      });
    }
  }

  public cancelRound(roundId: string): void {
    try {
      this.send({ type: 'host.cancel', roundId });
    } catch {
      // The room will cancel a scheduled round after the host disconnects.
    }
  }

  public closeRoom(): void {
    try {
      this.send({ type: 'host.close' });
    } catch {
      // Closing the local socket still releases the host connection.
    }
  }

  public leave(): void {
    try {
      this.send({ type: 'leave' });
    } catch {
      // The local session is cleared below even if the socket is already gone.
    }
    removeSession(roomStorageKey(this.roomCode));
    this.participantId = null;
    this.resumeToken = null;
  }

  public getLocalStartTime(startAt: number): number {
    return startAt - this.serverClockOffsetMs;
  }

  /** Schedule against a performance.now deadline derived from the room clock. */
  public scheduleAt(startAt: number, callback: () => void): () => void {
    const target = performance.now() + (startAt - (Date.now() + this.serverClockOffsetMs));
    let timer: number | null = null;
    let frame: number | null = null;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const remaining = target - performance.now();
      if (remaining <= 0) {
        callback();
        return;
      }
      if (remaining > 32) {
        timer = window.setTimeout(tick, Math.min(remaining - 8, 250));
      } else if (typeof window.requestAnimationFrame === 'function') {
        frame = window.requestAnimationFrame(tick);
      } else {
        timer = window.setTimeout(tick, Math.max(1, remaining));
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }

  private sendHello(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const message = this.role === 'host'
      ? { type: 'hello' as const, protocolVersion: SHARED_ROOM_PROTOCOL_VERSION, role: 'host' as const, hostToken: this.hostToken ?? '' }
      : {
          type: 'hello' as const,
          protocolVersion: SHARED_ROOM_PROTOCOL_VERSION,
          role: 'guest' as const,
          ...(this.participantId && this.resumeToken
            ? { participantId: this.participantId, resumeToken: this.resumeToken }
            : this.displayName
              ? { displayName: this.displayName }
              : {}),
        };
    this.helloSent = true;
    this.send(message);
  }

  private send(message: object): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Shared room is not connected');
    this.socket.send(JSON.stringify(message));
  }

  private handleMessage(data: unknown, resolve: () => void, reject: (error: Error) => void): void {
    let value: unknown = data;
    if (typeof data === 'string') {
      try {
        value = JSON.parse(data);
      } catch {
        return;
      }
    }
    const message = parseRoomServerMessage(value);
    if (!message) return;
    switch (message.type) {
      case 'snapshot':
        if (!this.acceptSnapshot(message.snapshot)) {
          this.sawSnapshot = true;
          resolve();
          return;
        }
        this.snapshot = message.snapshot;
        this.updateOwnDisplayName(message.snapshot);
        this.sawSnapshot = true;
        this.emit({ type: 'snapshot', snapshot: message.snapshot });
        resolve();
        break;
      case 'joined':
        this.participantId = message.participantId;
        this.resumeToken = message.resumeToken;
        writeSession(roomStorageKey(this.roomCode), JSON.stringify({ participantId: this.participantId, resumeToken: this.resumeToken }));
        if (!this.acceptSnapshot(message.snapshot)) {
          this.sawSnapshot = true;
          resolve();
          return;
        }
        this.snapshot = message.snapshot;
        this.updateOwnDisplayName(message.snapshot);
        this.sawSnapshot = true;
        this.emit({ type: 'joined', participantId: message.participantId, snapshot: message.snapshot });
        resolve();
        break;
      case 'round.scheduled':
        if (!this.acceptRound(message.round)) return;
        this.emit({ type: 'scheduled', requestId: message.requestId, round: message.round });
        this.pendingSchedules.get(message.requestId)?.resolve(message.round);
        this.pendingSchedules.delete(message.requestId);
        break;
      case 'round.started':
        if (!this.acceptRound(message.round)) return;
        this.emit({ type: 'started', round: message.round });
        break;
      case 'round.result':
        if (!this.acceptSnapshot(message.snapshot)) return;
        this.snapshot = message.snapshot;
        this.emit({ type: 'result', result: message.result, snapshot: message.snapshot });
        break;
      case 'round.cancelled':
        if (!this.acceptSnapshot(message.snapshot)) return;
        this.snapshot = message.snapshot;
        this.emit({ type: 'cancelled', roundId: message.roundId, reason: message.reason, snapshot: message.snapshot });
        break;
      case 'room.closed':
        if (!this.acceptSnapshot(message.snapshot)) return;
        this.snapshot = message.snapshot;
        this.disposed = true;
        if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.emit({ type: 'closed', reason: message.reason, snapshot: message.snapshot });
        this.socket?.close(4002, 'room closed');
        break;
      case 'pong': {
        const receivedAt = Date.now();
        const roundTrip = Math.max(0, receivedAt - message.clientSentAt);
        const estimate = message.serverTime - (message.clientSentAt + roundTrip / 2);
        this.offsetSamples = [...this.offsetSamples, estimate].slice(-5).sort((a, b) => Math.abs(a) - Math.abs(b));
        this.serverClockOffsetMs = this.offsetSamples[0] ?? estimate;
        break;
      }
      case 'error':
        this.emit({ type: 'error', code: message.code, message: message.message });
        if (message.requestId) {
          this.pendingSchedules.get(message.requestId)?.reject(new Error(message.message));
          this.pendingSchedules.delete(message.requestId);
        }
        if (!this.sawSnapshot) {
          this.suppressReconnect = true;
          this.socket?.close(4003, 'room authentication failed');
          reject(new Error(message.message));
        }
        break;
    }
  }

  private emit(event: SharedRoomClientEvent): void {
    this.dispatchEvent(new CustomEvent<SharedRoomClientEvent>('room', { detail: event }));
  }

  private acceptSnapshot(snapshot: RoomSnapshot): boolean {
    return !this.snapshot || snapshot.revision >= this.snapshot.revision;
  }

  private acceptRound(round: ScheduledRound): boolean {
    const current = this.snapshot?.scheduledRound;
    if (!current) return true;
    if (round.sequence < current.sequence) return false;
    if (round.sequence !== current.sequence || round.roundId !== current.roundId) return true;
    const statusRank: Record<ScheduledRound['status'], number> = {
      scheduled: 0,
      running: 1,
      finished: 2,
      cancelled: 2,
    };
    return statusRank[round.status] >= statusRank[current.status];
  }

  private updateOwnDisplayName(snapshot: RoomSnapshot): void {
    if (!this.participantId) return;
    this.displayName =
      snapshot.participants.find((participant) => participant.participantId === this.participantId)?.displayName ??
      this.displayName;
  }

  private setStatus(status: SharedRoomConnectionStatus): void {
    if (this.connectionStatus === status) return;
    this.connectionStatus = status;
    this.emit({ type: 'connection', status });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, 1000);
  }

  private startClockSync(): void {
    this.stopClockSync();
    const ping = () => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        const clientSentAt = Date.now();
        try {
          this.send({ type: 'ping', id: randomId('ping'), clientSentAt });
        } catch {
          // The close handler owns reconnect scheduling.
        }
      }
    };
    ping();
    this.pingTimer = window.setInterval(ping, 15_000);
  }

  private stopClockSync(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}

export type { RoomParticipant };
