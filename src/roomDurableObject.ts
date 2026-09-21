import {
  isValidRoomCode,
  isValidRoomDisplayName,
  normalizeRoomDisplayName,
  parseRoomClientMessage,
  validateRoomReplay,
  SHARED_ROOM_MAX_MESSAGE_BYTES,
  SHARED_ROOM_MAX_PARTICIPANT_STRING_LENGTH,
  SHARED_ROOM_MAX_PARTICIPANTS,
  SHARED_ROOM_MAX_REQUEST_ID_LENGTH,
  SHARED_ROOM_MAX_ROUND_ID_LENGTH,
  SHARED_ROOM_MAX_TOKEN_LENGTH,
  SHARED_ROOM_LEGACY_PROTOCOL_VERSION,
  SHARED_ROOM_CONTROL_LEAD_MS,
  SHARED_ROOM_PROTOCOL_VERSION,
  SHARED_ROOM_START_LEAD_MS,
  SHARED_ROOM_TTL_MS,
  validateSharedPlaybackState,
  type ReplayDescriptor,
  type SharedPlaybackState,
  type RoomClientMessage,
  type RoomParticipant,
  type RoomRoundResult,
  type RoomServerMessage,
  type RoomSnapshot,
  type ScheduledRound,
} from './sharedRoomProtocol';

const ROOM_STATE_TABLE = 'room_state';
const ROOM_STATE_ID = 1;
const ROOM_TAG = 'room';
const HOST_DISCONNECT_GRACE_MS = 2500;
const MAX_INTERNAL_CREATE_BODY_BYTES = 16 * 1024;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

type RoomRole = 'unknown' | 'host' | 'guest';

type SocketAttachment = Readonly<{
  role: RoomRole;
  authenticated: boolean;
  participantId?: string;
}>;

type PersistedParticipant = RoomParticipant & {
  resumeTokenHash: string;
};

type PersistedScheduledRound = {
  roundId: string;
  sequence: number;
  replay: ReplayDescriptor;
  startAt: number;
  status: ScheduledRound['status'];
  playback: SharedPlaybackState;
  playbackEffectiveAt: number;
  playbackSequence: number;
};

type PersistedRoomState = {
  protocolVersion: typeof SHARED_ROOM_PROTOCOL_VERSION;
  roomCode: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  status: 'open' | 'closed' | 'expired';
  joinsOpen: boolean;
  participants: PersistedParticipant[];
  hostTokenHash: string;
  nextParticipantOrder: number;
  nextSequence: number;
  scheduledRound?: PersistedScheduledRound;
  lastResult?: RoomRoundResult;
  hostDisconnectCheckAt?: number;
};

interface SqlCursorLike {
  toArray?: () => unknown[];
  [Symbol.iterator]?: () => Iterator<unknown>;
}

interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): unknown;
}

interface DurableObjectStorageLike {
  sql: SqlStorageLike;
  setAlarm(timestamp: number): Promise<void> | void;
  deleteAlarm?: () => Promise<void> | void;
}

interface RoomWebSocket extends WebSocket {
  serializeAttachment?: (attachment: SocketAttachment) => void;
  deserializeAttachment?: () => unknown;
}

interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  acceptWebSocket(socket: RoomWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): RoomWebSocket[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function isBoundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximum &&
    !hasControlCharacter(value)
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function jsonError(code: string, message: string, status: number): Response {
  return jsonResponse({ error: code, code, message }, status);
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    result += BASE64URL_ALPHABET[(value >>> 18) & 63];
    result += BASE64URL_ALPHABET[(value >>> 12) & 63];
    if (second !== undefined) result += BASE64URL_ALPHABET[(value >>> 6) & 63];
    if (third !== undefined) result += BASE64URL_ALPHABET[value & 63];
  }
  return result;
}

function generateToken(byteLength = 32): string {
  return encodeBase64Url(randomBytes(byteLength));
}

function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

async function hashSecret(secret: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return bytesToHex(new Uint8Array(digest));
}

function equalSecrets(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function rowsFromSqlResult(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];

  const cursor = result as SqlCursorLike;
  if (typeof cursor.toArray === 'function') return cursor.toArray();
  if (typeof cursor[Symbol.iterator] === 'function') return Array.from(cursor as Iterable<unknown>);
  return [];
}

function isValidHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function refreshRoomExpiry(state: PersistedRoomState, now: number): boolean {
  const nextExpiry = Math.max(state.expiresAt, now + SHARED_ROOM_TTL_MS);
  if (nextExpiry === state.expiresAt) return false;
  state.expiresAt = nextExpiry;
  return true;
}

function cloneReplay(replay: ReplayDescriptor): ReplayDescriptor {
  return {
    version: replay.version,
    seed: replay.seed,
    mapIndex: replay.mapIndex,
    participants: replay.participants.slice(),
    winnerRange: { ...replay.winnerRange },
    skillsEnabled: replay.skillsEnabled,
  };
}

function cloneRound(round: PersistedScheduledRound): ScheduledRound {
  return {
    roundId: round.roundId,
    sequence: round.sequence,
    replay: cloneReplay(round.replay),
    startAt: round.startAt,
    status: round.status,
    playback: { ...round.playback },
    playbackEffectiveAt: round.playbackEffectiveAt,
    playbackSequence: round.playbackSequence,
  };
}

function cloneResult(result: RoomRoundResult): RoomRoundResult {
  return {
    roundId: result.roundId,
    winners: result.winners.slice(),
    reportedAt: result.reportedAt,
  };
}

function parsePersistedRound(value: unknown): PersistedScheduledRound | undefined {
  if (!isRecord(value)) return undefined;
  const replay = validateRoomReplay(value.replay);
  const playback = value.playback === undefined ? { speed: 1, fastForward: false } : validateSharedPlaybackState(value.playback);
  const playbackEffectiveAt = value.playbackEffectiveAt === undefined ? value.startAt : value.playbackEffectiveAt;
  const playbackSequence = value.playbackSequence === undefined ? 0 : value.playbackSequence;
  if (
    !isBoundedString(value.roundId, SHARED_ROOM_MAX_ROUND_ID_LENGTH) ||
    !isSafeInteger(value.sequence) ||
    value.sequence <= 0 ||
    !replay ||
    !isFiniteNumber(value.startAt) ||
    !playback ||
    !isFiniteNumber(playbackEffectiveAt) ||
    !isSafeInteger(playbackSequence) ||
    playbackSequence < 0 ||
    (value.status !== 'scheduled' &&
      value.status !== 'running' &&
      value.status !== 'finished' &&
      value.status !== 'cancelled')
  ) {
    return undefined;
  }
  return {
    roundId: value.roundId,
    sequence: value.sequence,
    replay,
    startAt: value.startAt,
    status: value.status,
    playback,
    playbackEffectiveAt,
    playbackSequence,
  };
}

function parsePersistedResult(value: unknown): RoomRoundResult | undefined {
  if (!isRecord(value) || !isBoundedString(value.roundId, SHARED_ROOM_MAX_ROUND_ID_LENGTH)) return undefined;
  if (!Array.isArray(value.winners) || value.winners.length > SHARED_ROOM_MAX_PARTICIPANTS) return undefined;
  if (!isFiniteNumber(value.reportedAt)) return undefined;
  const winners: string[] = [];
  for (const winner of value.winners) {
    if (!isBoundedString(winner, SHARED_ROOM_MAX_PARTICIPANT_STRING_LENGTH)) return undefined;
    winners.push(winner);
  }
  return { roundId: value.roundId, winners, reportedAt: value.reportedAt };
}

function parsePersistedState(value: unknown): PersistedRoomState | null {
  if (!isRecord(value)) return null;
  if (
    (value.protocolVersion !== SHARED_ROOM_PROTOCOL_VERSION &&
      value.protocolVersion !== SHARED_ROOM_LEGACY_PROTOCOL_VERSION) ||
    !isValidRoomCode(value.roomCode) ||
    !isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt) ||
    !isFiniteNumber(value.expiresAt) ||
    (value.status !== 'open' && value.status !== 'closed' && value.status !== 'expired') ||
    typeof value.joinsOpen !== 'boolean' ||
    !Array.isArray(value.participants) ||
    value.participants.length > SHARED_ROOM_MAX_PARTICIPANTS ||
    !isValidHash(value.hostTokenHash) ||
    !isSafeInteger(value.nextParticipantOrder) ||
    value.nextParticipantOrder < 0 ||
    !isSafeInteger(value.nextSequence) ||
    value.nextSequence < 0
  ) {
    return null;
  }

  const participants: PersistedParticipant[] = [];
  for (const participant of value.participants) {
    if (!isRecord(participant)) return null;
    if (
      !isBoundedString(participant.participantId, SHARED_ROOM_MAX_TOKEN_LENGTH) ||
      !isValidRoomDisplayName(participant.displayName) ||
      !isFiniteNumber(participant.joinedAt) ||
      !isSafeInteger(participant.order) ||
      participant.order < 0 ||
      !isValidHash(participant.resumeTokenHash)
    ) {
      return null;
    }
    participants.push({
      participantId: participant.participantId,
      displayName: normalizeRoomDisplayName(participant.displayName),
      joinedAt: participant.joinedAt,
      order: participant.order,
      resumeTokenHash: participant.resumeTokenHash,
    });
  }

  const scheduledRound = value.scheduledRound === undefined ? undefined : parsePersistedRound(value.scheduledRound);
  if (value.scheduledRound !== undefined && !scheduledRound) return null;
  const lastResult = value.lastResult === undefined ? undefined : parsePersistedResult(value.lastResult);
  if (value.lastResult !== undefined && !lastResult) return null;

  if (value.hostDisconnectCheckAt !== undefined && !isFiniteNumber(value.hostDisconnectCheckAt)) return null;

  const state: PersistedRoomState = {
    protocolVersion: SHARED_ROOM_PROTOCOL_VERSION,
    roomCode: value.roomCode,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
    status: value.status,
    joinsOpen: value.joinsOpen,
    participants,
    hostTokenHash: value.hostTokenHash,
    nextParticipantOrder: value.nextParticipantOrder,
    nextSequence: value.nextSequence,
  };
  if (scheduledRound) state.scheduledRound = scheduledRound;
  if (lastResult) state.lastResult = lastResult;
  if (value.hostDisconnectCheckAt !== undefined) state.hostDisconnectCheckAt = value.hostDisconnectCheckAt;
  return state;
}

function attachmentRole(value: unknown): SocketAttachment {
  if (!isRecord(value)) return { role: 'unknown', authenticated: false };
  const role = value.role;
  const participantId = value.participantId;
  if (
    (role !== 'unknown' && role !== 'host' && role !== 'guest') ||
    typeof value.authenticated !== 'boolean' ||
    (participantId !== undefined && !isBoundedString(participantId, SHARED_ROOM_MAX_TOKEN_LENGTH))
  ) {
    return { role: 'unknown', authenticated: false };
  }
  return typeof participantId === 'string'
    ? { role, authenticated: value.authenticated, participantId }
    : { role, authenticated: value.authenticated };
}

function requestIdFromUnknown(value: unknown): string | undefined {
  if (!isRecord(value) || !isBoundedString(value.requestId, SHARED_ROOM_MAX_REQUEST_ID_LENGTH)) return undefined;
  return value.requestId;
}

function protocolMismatch(value: unknown): boolean {
  return isRecord(value) && value.type === 'hello' && value.protocolVersion !== SHARED_ROOM_PROTOCOL_VERSION;
}

function messageByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export class RoomDurableObject {
  private readonly fallbackAttachments = new WeakMap<object, SocketAttachment>();

  constructor(private readonly state: DurableObjectStateLike) {
    this.ensureTable();
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/internal/create') return await this.handleCreate(request);
      if (url.pathname !== '/ws') return jsonError('not_found', 'Room route not found', 404);
      return await this.handleWebSocket(request);
    } catch {
      return jsonError('room_unavailable', 'The room service is temporarily unavailable', 503);
    }
  }

  async alarm(): Promise<void> {
    const state = this.readState();
    if (!state) return;

    const now = Date.now();
    if (now >= state.expiresAt) {
      await this.expireRoom(state);
      return;
    }

    if (state.hostDisconnectCheckAt !== undefined && now >= state.hostDisconnectCheckAt) {
      state.hostDisconnectCheckAt = undefined;
      if (state.scheduledRound?.status === 'scheduled' && !this.isHostConnected()) {
        await this.cancelRound(state, state.scheduledRound.roundId, 'host_unavailable');
        return;
      }
      this.writeState(state);
    }

    const scheduledRound = state.scheduledRound;
    if (scheduledRound?.status === 'scheduled') {
      if (now < scheduledRound.startAt) {
        await this.scheduleAlarm(state);
        return;
      }
      if (!this.isHostConnected()) {
        await this.cancelRound(state, scheduledRound.roundId, 'host_unavailable');
        return;
      }

      scheduledRound.status = 'running';
      state.revision += 1;
      state.updatedAt = now;
      state.hostDisconnectCheckAt = undefined;
      this.writeState(state);
      await this.scheduleAlarm(state);
      this.broadcast({ type: 'round.started', round: cloneRound(scheduledRound) });
      this.broadcast({ type: 'snapshot', snapshot: this.snapshot(state) });
      return;
    }

    await this.scheduleAlarm(state);
  }

  async webSocketMessage(webSocket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const socket = webSocket as RoomWebSocket;
    if (typeof message !== 'string') {
      this.sendError(socket, 'invalid_message', 'Only JSON text messages are supported');
      return;
    }
    if (messageByteLength(message) > SHARED_ROOM_MAX_MESSAGE_BYTES) {
      this.sendError(socket, 'message_too_large', 'Message exceeds the room message limit');
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(message) as unknown;
    } catch {
      this.sendError(socket, 'invalid_message', 'Message must be valid JSON');
      return;
    }

    if (protocolMismatch(raw)) {
      this.sendError(socket, 'protocol_mismatch', 'Unsupported room protocol version');
      return;
    }

    const parsed = parseRoomClientMessage(raw);
    if (!parsed) {
      if (isRecord(raw) && raw.type === 'host.schedule' && !validateRoomReplay(raw.replay)) {
        this.sendError(socket, 'invalid_replay', 'Replay descriptor is invalid', requestIdFromUnknown(raw));
      } else if (isRecord(raw) && raw.type === 'host.result') {
        this.sendError(socket, 'invalid_winners', 'Winner list is invalid', requestIdFromUnknown(raw));
      } else {
        this.sendError(socket, 'invalid_message', 'Message does not match the room protocol');
      }
      return;
    }

    try {
      await this.handleMessage(socket, parsed);
    } catch {
      this.sendError(socket, 'room_unavailable', 'The room service could not process the message');
    }
  }

  async webSocketClose(webSocket: WebSocket): Promise<void> {
    const socket = webSocket as RoomWebSocket;
    const attachment = this.getAttachment(socket);
    this.fallbackAttachments.delete(socket);
    if (!attachment.authenticated || attachment.role !== 'host') return;

    const state = this.readState();
    if (!state || state.status !== 'open' || state.scheduledRound?.status !== 'scheduled') return;
    if (this.isHostConnected()) return;

    state.hostDisconnectCheckAt = Date.now() + HOST_DISCONNECT_GRACE_MS;
    this.writeState(state);
    await this.scheduleAlarm(state);
  }

  async webSocketError(webSocket: WebSocket): Promise<void> {
    await this.webSocketClose(webSocket);
  }

  private ensureTable(): void {
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ROOM_STATE_TABLE} (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        value TEXT NOT NULL
      )`,
    );
  }

  private readState(): PersistedRoomState | null {
    this.ensureTable();
    const result = this.state.storage.sql.exec(`SELECT value FROM ${ROOM_STATE_TABLE} WHERE id = ?`, ROOM_STATE_ID);
    const rows = rowsFromSqlResult(result);
    if (rows.length === 0) return null;

    const row = rows[0];
    const serialized = typeof row === 'string' ? row : isRecord(row) ? row.value : undefined;
    if (typeof serialized !== 'string') return null;
    try {
      return parsePersistedState(JSON.parse(serialized) as unknown);
    } catch {
      return null;
    }
  }

  private writeState(state: PersistedRoomState): void {
    this.ensureTable();
    this.state.storage.sql.exec(
      `INSERT INTO ${ROOM_STATE_TABLE} (id, value) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET value = excluded.value`,
      ROOM_STATE_ID,
      JSON.stringify(state),
    );
  }

  private deleteState(): void {
    this.ensureTable();
    this.state.storage.sql.exec(`DELETE FROM ${ROOM_STATE_TABLE} WHERE id = ?`, ROOM_STATE_ID);
  }

  private async handleCreate(request: Request): Promise<Response> {
    if (request.method !== 'POST') return jsonError('method_not_allowed', 'Room creation requires POST', 405);
    const body = await this.readJsonBody(request, MAX_INTERNAL_CREATE_BODY_BYTES);
    if (!body || !isBoundedString(body.hostToken, SHARED_ROOM_MAX_TOKEN_LENGTH)) {
      return jsonError('invalid_request', 'Room creation payload is invalid', 400);
    }
    if (!isValidRoomCode(body.roomCode) || !isFiniteNumber(body.expiresAt)) {
      return jsonError('invalid_request', 'Room creation payload is invalid', 400);
    }

    const existing = this.readState();
    if (existing) return jsonError('room_exists', 'Room already exists', 409);

    const now = Date.now();
    if (body.expiresAt <= now || body.expiresAt > now + SHARED_ROOM_TTL_MS + 60_000) {
      return jsonError('invalid_request', 'Room expiration is invalid', 400);
    }

    const state: PersistedRoomState = {
      protocolVersion: SHARED_ROOM_PROTOCOL_VERSION,
      roomCode: body.roomCode,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: body.expiresAt,
      status: 'open',
      joinsOpen: true,
      participants: [],
      hostTokenHash: await hashSecret(body.hostToken),
      nextParticipantOrder: 0,
      nextSequence: 0,
    };
    this.writeState(state);
    await this.scheduleAlarm(state);
    return jsonResponse({
      protocolVersion: SHARED_ROOM_PROTOCOL_VERSION,
      roomCode: state.roomCode,
      expiresAt: state.expiresAt,
    });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    if (request.method !== 'GET') return jsonError('method_not_allowed', 'WebSocket rooms require GET', 405);
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return jsonError('upgrade_required', 'A WebSocket upgrade is required', 426);
    }

    const state = this.readState();
    if (!state) return jsonError('room_not_found', 'Room was not found', 404);
    if (Date.now() >= state.expiresAt) {
      await this.expireRoom(state);
      return jsonError('room_expired', 'Room has expired', 410);
    }

    const pairConstructor = (globalThis as unknown as {
      WebSocketPair?: new () => { 0: RoomWebSocket; 1: RoomWebSocket };
    }).WebSocketPair;
    if (!pairConstructor) return jsonError('websocket_unavailable', 'WebSockets are unavailable', 503);

    const pair = new pairConstructor();
    const clientSocket = pair[0];
    const serverSocket = pair[1];
    this.state.acceptWebSocket(serverSocket, [ROOM_TAG]);
    this.setAttachment(serverSocket, { role: 'unknown', authenticated: false });
    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
    } as ResponseInit & { webSocket: RoomWebSocket });
  }

  private async readJsonBody(request: Request, maximumBytes: number): Promise<JsonRecord | null> {
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > maximumBytes) return null;
    const text = await request.text();
    if (messageByteLength(text) > maximumBytes) return null;
    try {
      const parsed = JSON.parse(text) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async handleMessage(socket: RoomWebSocket, message: RoomClientMessage): Promise<void> {
    if (message.type === 'ping') {
      this.send(socket, {
        type: 'pong',
        id: message.id,
        clientSentAt: message.clientSentAt,
        serverTime: Date.now(),
      });
      return;
    }
    if (message.type === 'hello') {
      await this.handleHello(socket, message);
      return;
    }

    const attachment = this.getAttachment(socket);
    if (message.type === 'host.schedule') {
      await this.handleSchedule(socket, attachment, message);
    } else if (message.type === 'host.playback-control') {
      await this.handlePlaybackControl(socket, attachment, message);
    } else if (message.type === 'host.result') {
      await this.handleResult(socket, attachment, message);
    } else if (message.type === 'host.cancel') {
      await this.handleCancel(socket, attachment, message);
    } else if (message.type === 'host.close') {
      await this.handleClose(socket, attachment);
    } else if (message.type === 'leave') {
      await this.handleLeave(socket, attachment);
    }
  }

  private async handleHello(
    socket: RoomWebSocket,
    message: Extract<RoomClientMessage, { type: 'hello' }>,
  ): Promise<void> {
    const currentAttachment = this.getAttachment(socket);
    if (currentAttachment.authenticated) {
      this.sendError(socket, 'already_authenticated', 'Connection is already authenticated');
      return;
    }

    const state = this.readState();
    if (!state) {
      this.sendError(socket, 'room_not_found', 'Room was not found');
      return;
    }
    if (Date.now() >= state.expiresAt) {
      await this.expireRoom(state);
      this.sendError(socket, 'room_expired', 'Room has expired');
      return;
    }

    if (message.role === 'host') {
      await this.handleHostHello(socket, message, state);
    } else {
      await this.handleGuestHello(socket, message, state);
    }
  }

  private async handleHostHello(
    socket: RoomWebSocket,
    message: Extract<RoomClientMessage, { type: 'hello' }> & { role: 'host' },
    state: PersistedRoomState,
  ): Promise<void> {
    if (!message.hostToken) {
      this.sendError(socket, 'invalid_host_token', 'Host credentials are required');
      return;
    }
    const suppliedHash = await hashSecret(message.hostToken);
    if (!equalSecrets(suppliedHash, state.hostTokenHash)) {
      this.sendError(socket, 'invalid_host_token', 'Host credentials are invalid');
      return;
    }
    if (state.status === 'expired') {
      this.sendError(socket, 'room_expired', 'Room has expired');
      return;
    }
    if (state.status === 'closed') {
      this.sendError(socket, 'room_closed', 'Room is closed');
      return;
    }

    this.setAttachment(socket, { role: 'host', authenticated: true });
    this.replaceOlderHostSockets(socket);
    const now = Date.now();
    const expiryRefreshed = refreshRoomExpiry(state, now);
    if (expiryRefreshed) {
      state.revision += 1;
      state.updatedAt = now;
    }
    if (state.hostDisconnectCheckAt !== undefined) {
      state.hostDisconnectCheckAt = undefined;
      state.revision += 1;
      state.updatedAt = now;
      this.writeState(state);
      await this.scheduleAlarm(state);
    } else if (expiryRefreshed) {
      this.writeState(state);
      await this.scheduleAlarm(state);
    }
    this.send(socket, { type: 'snapshot', snapshot: this.snapshot(state) });
  }

  private async handleGuestHello(
    socket: RoomWebSocket,
    message: Extract<RoomClientMessage, { type: 'hello' }> & { role: 'guest' },
    state: PersistedRoomState,
  ): Promise<void> {
    if (state.status === 'expired') {
      this.sendError(socket, 'room_expired', 'Room has expired');
      return;
    }
    if (state.status === 'closed' || !state.joinsOpen) {
      this.sendError(socket, 'room_closed', 'Room is not accepting guests');
      return;
    }

    if (message.participantId && message.resumeToken) {
      const participant = state.participants.find((candidate) => candidate.participantId === message.participantId);
      if (participant) {
        const suppliedHash = await hashSecret(message.resumeToken);
        if (equalSecrets(suppliedHash, participant.resumeTokenHash)) {
          this.setAttachment(socket, {
            role: 'guest',
            authenticated: true,
            participantId: participant.participantId,
          });
          this.replaceOlderGuestSockets(socket, participant.participantId);
          const now = Date.now();
          if (refreshRoomExpiry(state, now)) {
            state.revision += 1;
            state.updatedAt = now;
            this.writeState(state);
            await this.scheduleAlarm(state);
          }
          this.send(socket, {
            type: 'joined',
            participantId: participant.participantId,
            resumeToken: message.resumeToken,
            snapshot: this.snapshot(state),
          });
          return;
        }
      }
    }

    if (!message.displayName || !isValidRoomDisplayName(message.displayName)) {
      this.sendError(socket, 'invalid_name', 'Display name is invalid');
      return;
    }
    if (state.participants.length >= SHARED_ROOM_MAX_PARTICIPANTS) {
      this.sendError(socket, 'room_full', 'Room participant limit reached');
      return;
    }

    const displayName = normalizeRoomDisplayName(message.displayName);
    const displayNameKey = displayName.toLowerCase();
    if (state.participants.some((participant) => participant.displayName.toLowerCase() === displayNameKey)) {
      this.sendError(socket, 'name_duplicate', 'Display name is already in use');
      return;
    }

    const participantId = generateToken(18);
    const resumeToken = generateToken(32);
    const participant: PersistedParticipant = {
      participantId,
      displayName,
      joinedAt: Date.now(),
      order: state.nextParticipantOrder,
      resumeTokenHash: await hashSecret(resumeToken),
    };
    state.nextParticipantOrder += 1;
    state.participants.push(participant);
    state.revision += 1;
    state.updatedAt = participant.joinedAt;
    refreshRoomExpiry(state, participant.joinedAt);
    state.hostDisconnectCheckAt = undefined;
    this.writeState(state);
    await this.scheduleAlarm(state);

    this.setAttachment(socket, { role: 'guest', authenticated: true, participantId });
    this.send(socket, {
      type: 'joined',
      participantId,
      resumeToken,
      snapshot: this.snapshot(state),
    });
    this.broadcast({ type: 'snapshot', snapshot: this.snapshot(state) }, socket);
  }

  private async handleSchedule(
    socket: RoomWebSocket,
    attachment: SocketAttachment,
    message: Extract<RoomClientMessage, { type: 'host.schedule' }>,
  ): Promise<void> {
    if (!this.requireHost(socket, attachment, message.requestId)) return;
    const state = this.readState();
    if (!state) {
      this.sendError(socket, 'room_not_found', 'Room was not found', message.requestId);
      return;
    }
    if (Date.now() >= state.expiresAt) {
      await this.expireRoom(state);
      this.sendError(socket, 'room_expired', 'Room has expired', message.requestId);
      return;
    }
    if (state.status !== 'open' || !state.joinsOpen) {
      this.sendError(socket, 'room_closed', 'Room is closed', message.requestId);
      return;
    }
    if (state.scheduledRound?.status === 'scheduled' || state.scheduledRound?.status === 'running') {
      this.sendError(socket, 'round_active', 'A round is already active', message.requestId);
      return;
    }

    const replay = validateRoomReplay(message.replay);
    if (!replay) {
      this.sendError(socket, 'invalid_replay', 'Replay descriptor is invalid', message.requestId);
      return;
    }

    const now = Date.now();
    const sequence = state.nextSequence + 1;
    const round: PersistedScheduledRound = {
      roundId: `r-${sequence}-${generateToken(9)}`,
      sequence,
      replay: cloneReplay(replay),
      startAt: now + SHARED_ROOM_START_LEAD_MS,
      status: 'scheduled',
      playback: { ...message.playback },
      playbackEffectiveAt: now + SHARED_ROOM_START_LEAD_MS,
      playbackSequence: 0,
    };
    state.nextSequence = sequence;
    state.scheduledRound = round;
    state.revision += 1;
    state.updatedAt = now;
    refreshRoomExpiry(state, now);
    state.hostDisconnectCheckAt = undefined;
    this.writeState(state);
    await this.scheduleAlarm(state);

    this.broadcast({ type: 'round.scheduled', requestId: message.requestId, round: cloneRound(round) });
    this.broadcast({ type: 'snapshot', snapshot: this.snapshot(state) });
  }

  private async handlePlaybackControl(
    socket: RoomWebSocket,
    attachment: SocketAttachment,
    message: Extract<RoomClientMessage, { type: 'host.playback-control' }>,
  ): Promise<void> {
    if (!this.requireHost(socket, attachment)) return;
    const state = this.readState();
    if (!state) {
      this.sendError(socket, 'room_not_found', 'Room was not found');
      return;
    }
    const now = Date.now();
    if (now >= state.expiresAt) {
      await this.expireRoom(state);
      this.sendError(socket, 'room_expired', 'Room has expired');
      return;
    }

    const round = state.scheduledRound;
    if (!round || round.roundId !== message.roundId) {
      this.sendError(socket, 'round_not_found', 'Round was not found');
      return;
    }
    if (round.status !== 'scheduled' && round.status !== 'running') {
      this.sendError(socket, 'round_not_active', 'Round is not active');
      return;
    }

    const playback = validateSharedPlaybackState({ ...round.playback, ...message.playback });
    if (!playback) {
      this.sendError(socket, 'invalid_playback', 'Playback state is invalid');
      return;
    }
    if (playback.speed === round.playback.speed && playback.fastForward === round.playback.fastForward) return;

    const effectiveAt = Math.max(now + SHARED_ROOM_CONTROL_LEAD_MS, round.startAt);
    round.playback = playback;
    round.playbackEffectiveAt = effectiveAt;
    round.playbackSequence += 1;
    state.revision += 1;
    state.updatedAt = now;
    refreshRoomExpiry(state, now);
    this.writeState(state);
    await this.scheduleAlarm(state);
    this.broadcast({
      type: 'round.playback-control',
      roundId: round.roundId,
      controlSequence: round.playbackSequence,
      effectiveAt,
      playback: { ...playback },
    });
  }

  private async handleResult(
    socket: RoomWebSocket,
    attachment: SocketAttachment,
    message: Extract<RoomClientMessage, { type: 'host.result' }>,
  ): Promise<void> {
    if (!this.requireHost(socket, attachment, message.requestId)) return;
    const state = this.readState();
    if (!state) {
      this.sendError(socket, 'room_not_found', 'Room was not found', message.requestId);
      return;
    }
    if (Date.now() >= state.expiresAt) {
      await this.expireRoom(state);
      this.sendError(socket, 'room_expired', 'Room has expired', message.requestId);
      return;
    }

    const round = state.scheduledRound;
    if (!round || round.roundId !== message.roundId) {
      this.sendError(socket, 'round_not_found', 'Round was not found', message.requestId);
      return;
    }
    if (round.status === 'finished' && state.lastResult?.roundId === message.roundId) {
      this.send(socket, { type: 'snapshot', snapshot: this.snapshot(state) });
      return;
    }
    if (round.status !== 'running') {
      this.sendError(socket, 'round_not_running', 'Round is not running', message.requestId);
      return;
    }
    if (!message.winners.every((winner) => isBoundedString(winner, SHARED_ROOM_MAX_PARTICIPANT_STRING_LENGTH))) {
      this.sendError(socket, 'invalid_winners', 'Winner list is invalid', message.requestId);
      return;
    }

    const result: RoomRoundResult = {
      roundId: round.roundId,
      winners: message.winners.slice(),
      reportedAt: Date.now(),
    };
    round.status = 'finished';
    state.lastResult = result;
    state.revision += 1;
    state.updatedAt = result.reportedAt;
    refreshRoomExpiry(state, result.reportedAt);
    state.hostDisconnectCheckAt = undefined;
    this.writeState(state);
    await this.scheduleAlarm(state);
    this.broadcast({ type: 'round.result', result: cloneResult(result), snapshot: this.snapshot(state) });
  }

  private async handleCancel(
    socket: RoomWebSocket,
    attachment: SocketAttachment,
    message: Extract<RoomClientMessage, { type: 'host.cancel' }>,
  ): Promise<void> {
    if (!this.requireHost(socket, attachment)) return;
    const state = this.readState();
    if (!state) {
      this.sendError(socket, 'room_not_found', 'Room was not found');
      return;
    }
    if (Date.now() >= state.expiresAt) {
      await this.expireRoom(state);
      this.sendError(socket, 'room_expired', 'Room has expired');
      return;
    }
    if (!state.scheduledRound || state.scheduledRound.roundId !== message.roundId) {
      this.sendError(socket, 'round_not_found', 'Round was not found');
      return;
    }
    if (state.scheduledRound.status === 'cancelled') {
      this.send(socket, { type: 'snapshot', snapshot: this.snapshot(state) });
      return;
    }
    if (state.scheduledRound.status === 'finished') {
      this.sendError(socket, 'round_not_active', 'Round is already finished');
      return;
    }
    await this.cancelRound(state, message.roundId, 'host_cancelled');
  }

  private async handleClose(socket: RoomWebSocket, attachment: SocketAttachment): Promise<void> {
    if (!this.requireHost(socket, attachment)) return;
    const state = this.readState();
    if (!state) {
      this.sendError(socket, 'room_not_found', 'Room was not found');
      return;
    }
    if (state.status === 'expired') {
      this.sendError(socket, 'room_expired', 'Room has expired');
      return;
    }
    if (state.status === 'closed') {
      this.send(socket, { type: 'snapshot', snapshot: this.snapshot(state) });
      return;
    }

    const now = Date.now();
    state.status = 'closed';
    state.joinsOpen = false;
    if (state.scheduledRound?.status === 'scheduled' || state.scheduledRound?.status === 'running') {
      state.scheduledRound.status = 'cancelled';
    }
    state.revision += 1;
    state.updatedAt = now;
    state.hostDisconnectCheckAt = undefined;
    this.writeState(state);
    await this.scheduleAlarm(state);
    this.broadcast({ type: 'room.closed', reason: 'host_closed', snapshot: this.snapshot(state) });
    for (const connectedSocket of this.liveSockets()) this.safeClose(connectedSocket, 4002, 'room closed');
  }

  private async handleLeave(socket: RoomWebSocket, attachment: SocketAttachment): Promise<void> {
    if (!attachment.authenticated || attachment.role !== 'guest' || !attachment.participantId) {
      this.sendError(socket, 'not_authenticated', 'Guest authentication is required');
      return;
    }
    const state = this.readState();
    if (!state) {
      this.sendError(socket, 'room_not_found', 'Room was not found');
      return;
    }
    const participantIndex = state.participants.findIndex(
      (participant) => participant.participantId === attachment.participantId,
    );
    if (participantIndex < 0) {
      this.setAttachment(socket, { role: 'guest', authenticated: false });
      this.safeClose(socket, 1000, 'left');
      return;
    }

    state.participants.splice(participantIndex, 1);
    state.revision += 1;
    state.updatedAt = Date.now();
    refreshRoomExpiry(state, state.updatedAt);
    this.writeState(state);
    await this.scheduleAlarm(state);
    this.setAttachment(socket, { role: 'guest', authenticated: false });
    this.broadcast({ type: 'snapshot', snapshot: this.snapshot(state) });
    this.safeClose(socket, 1000, 'left');
  }

  private async cancelRound(state: PersistedRoomState, roundId: string, reason: string): Promise<void> {
    const round = state.scheduledRound;
    if (!round || round.roundId !== roundId) return;
    if (round.status !== 'scheduled' && round.status !== 'running') return;

    round.status = 'cancelled';
    state.revision += 1;
    state.updatedAt = Date.now();
    refreshRoomExpiry(state, state.updatedAt);
    state.hostDisconnectCheckAt = undefined;
    this.writeState(state);
    await this.scheduleAlarm(state);
    this.broadcast({
      type: 'round.cancelled',
      roundId,
      reason,
      snapshot: this.snapshot(state),
    });
  }

  private async expireRoom(state: PersistedRoomState): Promise<void> {
    if (state.status === 'expired') return;
    state.status = 'expired';
    state.joinsOpen = false;
    if (state.scheduledRound?.status === 'scheduled' || state.scheduledRound?.status === 'running') {
      state.scheduledRound.status = 'cancelled';
    }
    state.revision += 1;
    state.updatedAt = Date.now();
    state.hostDisconnectCheckAt = undefined;
    this.writeState(state);
    this.broadcast({ type: 'room.closed', reason: 'expired', snapshot: this.snapshot(state) });
    for (const connectedSocket of this.liveSockets()) this.safeClose(connectedSocket, 4002, 'room expired');

    try {
      this.deleteState();
      if (this.state.storage.deleteAlarm) await this.state.storage.deleteAlarm();
    } catch {
      this.writeState(state);
    }
  }

  private async scheduleAlarm(state: PersistedRoomState): Promise<void> {
    const alarmTimes = [state.expiresAt];
    if (state.scheduledRound?.status === 'scheduled') alarmTimes.push(state.scheduledRound.startAt);
    if (state.hostDisconnectCheckAt !== undefined) alarmTimes.push(state.hostDisconnectCheckAt);

    const nextAlarm = Math.min(...alarmTimes);
    await this.state.storage.setAlarm(Math.max(Date.now() + 1, nextAlarm));
  }

  private snapshot(state: PersistedRoomState): RoomSnapshot {
    return {
      protocolVersion: SHARED_ROOM_PROTOCOL_VERSION,
      roomCode: state.roomCode,
      revision: state.revision,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      expiresAt: state.expiresAt,
      status: state.status,
      joinsOpen: state.joinsOpen,
      participants: state.participants
        .map(({ participantId, displayName, joinedAt, order }) => ({ participantId, displayName, joinedAt, order }))
        .sort((left, right) => left.order - right.order),
      ...(state.scheduledRound ? { scheduledRound: cloneRound(state.scheduledRound) } : {}),
      ...(state.lastResult ? { lastResult: cloneResult(state.lastResult) } : {}),
    };
  }

  private send(socket: RoomWebSocket, message: RoomServerMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A socket can disappear between getWebSockets() and send().
    }
  }

  private sendError(socket: RoomWebSocket, code: string, message: string, requestId?: string): void {
    const error: RoomServerMessage = requestId
      ? { type: 'error', code, message, requestId }
      : { type: 'error', code, message };
    this.send(socket, error);
  }

  private broadcast(message: RoomServerMessage, except?: RoomWebSocket): void {
    for (const socket of this.liveSockets()) {
      if (socket !== except) this.send(socket, message);
    }
  }

  private liveSockets(): RoomWebSocket[] {
    try {
      return this.state.getWebSockets(ROOM_TAG).map((socket) => socket as RoomWebSocket);
    } catch {
      return [];
    }
  }

  private isHostConnected(): boolean {
    return this.liveSockets().some((socket) => {
      const attachment = this.getAttachment(socket);
      return attachment.authenticated && attachment.role === 'host';
    });
  }

  private replaceOlderHostSockets(current: RoomWebSocket): void {
    for (const socket of this.liveSockets()) {
      if (socket === current) continue;
      const attachment = this.getAttachment(socket);
      if (attachment.authenticated && attachment.role === 'host') this.safeClose(socket, 4001, 'replaced');
    }
  }

  private replaceOlderGuestSockets(current: RoomWebSocket, participantId: string): void {
    for (const socket of this.liveSockets()) {
      if (socket === current) continue;
      const attachment = this.getAttachment(socket);
      if (
        attachment.authenticated &&
        attachment.role === 'guest' &&
        attachment.participantId === participantId
      ) {
        this.safeClose(socket, 4001, 'replaced');
      }
    }
  }

  private requireHost(socket: RoomWebSocket, attachment: SocketAttachment, requestId?: string): boolean {
    if (attachment.authenticated && attachment.role === 'host') return true;
    this.sendError(socket, 'not_authenticated', 'Host authentication is required', requestId);
    return false;
  }

  private setAttachment(socket: RoomWebSocket, attachment: SocketAttachment): void {
    const copy: SocketAttachment = attachment.participantId
      ? { role: attachment.role, authenticated: attachment.authenticated, participantId: attachment.participantId }
      : { role: attachment.role, authenticated: attachment.authenticated };
    this.fallbackAttachments.set(socket, copy);
    try {
      socket.serializeAttachment?.(copy);
    } catch {
      // The fallback is used by local test doubles without hibernation methods.
    }
  }

  private getAttachment(socket: RoomWebSocket): SocketAttachment {
    try {
      if (socket.deserializeAttachment) {
        const serialized = socket.deserializeAttachment();
        if (serialized !== undefined) return attachmentRole(serialized);
      }
    } catch {
      // Fall through to the local fallback for a socket without a readable attachment.
    }
    return this.fallbackAttachments.get(socket) ?? { role: 'unknown', authenticated: false };
  }

  private safeClose(socket: RoomWebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // The socket is already closed.
    }
  }
}
