/**
 * The wire contract shared by the browser room client and the Worker.
 *
 * This module intentionally has no dependency on the roulette simulation. It
 * is safe to bundle in both a browser and a Cloudflare Worker.
 */

export const SHARED_ROOM_PROTOCOL_VERSION = 2 as const;
export const SHARED_ROOM_LEGACY_PROTOCOL_VERSION = 1 as const;
export const SHARED_ROOM_REPLAY_VERSION = 1 as const;
export const SHARED_ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const SHARED_ROOM_START_LEAD_MS = 1500;
export const SHARED_ROOM_CONTROL_LEAD_MS = 150;
export const SHARED_ROOM_MAX_PLAYBACK_SPEED = 8;

export const SHARED_ROOM_MAX_PARTICIPANTS = 1000;
export const SHARED_ROOM_MAX_PARTICIPANT_STRING_LENGTH = 256;
export const SHARED_ROOM_MAX_DISPLAY_NAME_LENGTH = 128;
export const SHARED_ROOM_MAX_TOKEN_LENGTH = 256;
export const SHARED_ROOM_MAX_REQUEST_ID_LENGTH = 128;
export const SHARED_ROOM_MAX_ROUND_ID_LENGTH = 160;
export const SHARED_ROOM_MAX_MESSAGE_BYTES = 512 * 1024;

const ROOM_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const PARTICIPANT_PATTERN = /^\s*([^/*]+?)(?:(?:\/([0-9]+)(?:\*([0-9]+))?)|(?:\*([0-9]+)(?:\/([0-9]+))?))?\s*$/;

export type SharedRoomProtocolVersion = typeof SHARED_ROOM_PROTOCOL_VERSION;
export type SharedRoomReplayVersion = typeof SHARED_ROOM_REPLAY_VERSION;

export type SharedPlaybackState = Readonly<{
  speed: number;
  fastForward: boolean;
}>;

export type SharedPlaybackPatch = Readonly<Partial<SharedPlaybackState>>;

export type ReplayDescriptor = Readonly<{
  version: SharedRoomReplayVersion;
  seed: number | string;
  mapIndex: number;
  participants: readonly string[];
  winnerRange: Readonly<{
    start: number;
    end: number;
  }>;
  skillsEnabled: boolean;
}>;

export type RoomStatus = 'open' | 'closed' | 'expired';
export type RoomRoundStatus = 'scheduled' | 'running' | 'finished' | 'cancelled';

export type RoomParticipant = Readonly<{
  participantId: string;
  displayName: string;
  joinedAt: number;
  order: number;
}>;

export type ScheduledRound = Readonly<{
  roundId: string;
  sequence: number;
  replay: ReplayDescriptor;
  startAt: number;
  status: RoomRoundStatus;
  playback: SharedPlaybackState;
  playbackEffectiveAt: number;
  playbackSequence: number;
}>;

export type RoomRoundResult = Readonly<{
  roundId: string;
  winners: readonly string[];
  reportedAt: number;
}>;

export type RoomSnapshot = Readonly<{
  protocolVersion: SharedRoomProtocolVersion;
  roomCode: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  status: RoomStatus;
  joinsOpen: boolean;
  participants: readonly RoomParticipant[];
  scheduledRound?: ScheduledRound;
  lastResult?: RoomRoundResult;
}>;

export type RoomHelloMessage = Readonly<{
  type: 'hello';
  protocolVersion: SharedRoomProtocolVersion;
  role: 'host' | 'guest';
  hostToken?: string;
  resumeToken?: string;
  participantId?: string;
  displayName?: string;
}>;

export type RoomPingMessage = Readonly<{
  type: 'ping';
  id: string;
  clientSentAt: number;
}>;

export type RoomHostScheduleMessage = Readonly<{
  type: 'host.schedule';
  requestId: string;
  replay: ReplayDescriptor;
  playback: SharedPlaybackState;
}>;

export type RoomHostPlaybackControlMessage = Readonly<{
  type: 'host.playback-control';
  roundId: string;
  playback: SharedPlaybackPatch;
}>;

export type RoomHostResultMessage = Readonly<{
  type: 'host.result';
  requestId?: string;
  roundId: string;
  winners: readonly string[];
}>;

export type RoomHostCancelMessage = Readonly<{
  type: 'host.cancel';
  roundId: string;
}>;

export type RoomHostCloseMessage = Readonly<{
  type: 'host.close';
}>;

export type RoomLeaveMessage = Readonly<{
  type: 'leave';
}>;

export type RoomClientMessage =
  | RoomHelloMessage
  | RoomPingMessage
  | RoomHostScheduleMessage
  | RoomHostPlaybackControlMessage
  | RoomHostResultMessage
  | RoomHostCancelMessage
  | RoomHostCloseMessage
  | RoomLeaveMessage;

export type RoomSnapshotMessage = Readonly<{
  type: 'snapshot';
  snapshot: RoomSnapshot;
}>;

export type RoomJoinedMessage = Readonly<{
  type: 'joined';
  participantId: string;
  resumeToken: string;
  snapshot: RoomSnapshot;
}>;

export type RoomRoundScheduledMessage = Readonly<{
  type: 'round.scheduled';
  requestId: string;
  round: ScheduledRound;
}>;

export type RoomRoundStartedMessage = Readonly<{
  type: 'round.started';
  round: ScheduledRound;
}>;

export type RoomRoundPlaybackControlMessage = Readonly<{
  type: 'round.playback-control';
  roundId: string;
  controlSequence: number;
  effectiveAt: number;
  playback: SharedPlaybackState;
}>;

export type RoomRoundResultMessage = Readonly<{
  type: 'round.result';
  result: RoomRoundResult;
  snapshot: RoomSnapshot;
}>;

export type RoomRoundCancelledMessage = Readonly<{
  type: 'round.cancelled';
  roundId: string;
  reason: string;
  snapshot: RoomSnapshot;
}>;

export type RoomClosedMessage = Readonly<{
  type: 'room.closed';
  reason: string;
  snapshot: RoomSnapshot;
}>;

export type RoomPongMessage = Readonly<{
  type: 'pong';
  id: string;
  clientSentAt: number;
  serverTime: number;
}>;

export type RoomErrorMessage = Readonly<{
  type: 'error';
  code: string;
  message: string;
  requestId?: string;
}>;

export type RoomConnectionMessage = Readonly<{
  type: 'connection';
  status: 'open' | 'closed';
}>;

export type RoomServerMessage =
  | RoomSnapshotMessage
  | RoomJoinedMessage
  | RoomRoundScheduledMessage
  | RoomRoundStartedMessage
  | RoomRoundPlaybackControlMessage
  | RoomRoundResultMessage
  | RoomRoundCancelledMessage
  | RoomClosedMessage
  | RoomPongMessage
  | RoomErrorMessage
  | RoomConnectionMessage;

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
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

function hasRouletteGrammarCharacter(value: string): boolean {
  // Room participants are plain display names. Do not allow a guest to inject
  // weight, multiplicity, grouping, or input-separator syntax into the host's
  // roulette input.
  return /[,+*\/\\]/u.test(value);
}

function isBoundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximum &&
    !hasControlCharacter(value)
  );
}

function copyReplay(replay: ReplayDescriptor): ReplayDescriptor {
  return {
    version: SHARED_ROOM_REPLAY_VERSION,
    seed: replay.seed,
    mapIndex: replay.mapIndex,
    participants: replay.participants.slice(),
    winnerRange: {
      start: replay.winnerRange.start,
      end: replay.winnerRange.end,
    },
    skillsEnabled: replay.skillsEnabled,
  };
}

const DEFAULT_SHARED_PLAYBACK: SharedPlaybackState = Object.freeze({
  speed: 1,
  fastForward: false,
});

export function validateSharedPlaybackState(value: unknown): SharedPlaybackState | null {
  if (!isRecord(value)) return null;
  if (
    !isFiniteNumber(value.speed) ||
    value.speed <= 0 ||
    value.speed > SHARED_ROOM_MAX_PLAYBACK_SPEED ||
    typeof value.fastForward !== 'boolean'
  ) {
    return null;
  }
  return { speed: value.speed, fastForward: value.fastForward };
}

export function validateSharedPlaybackPatch(value: unknown): SharedPlaybackPatch | null {
  if (!isRecord(value)) return null;
  if (value.speed === undefined && value.fastForward === undefined) return null;
  if (
    (value.speed !== undefined &&
      (!isFiniteNumber(value.speed) ||
        value.speed <= 0 ||
        value.speed > SHARED_ROOM_MAX_PLAYBACK_SPEED)) ||
    (value.fastForward !== undefined && typeof value.fastForward !== 'boolean')
  ) {
    return null;
  }
  return {
    ...(value.speed !== undefined ? { speed: value.speed } : {}),
    ...(value.fastForward !== undefined ? { fastForward: value.fastForward } : {}),
  };
}

function copyPlayback(playback: SharedPlaybackState): SharedPlaybackState {
  return { speed: playback.speed, fastForward: playback.fastForward };
}

function parseReplayParticipant(value: unknown): { value: string; count: number } | null {
  if (!isBoundedString(value, SHARED_ROOM_MAX_PARTICIPANT_STRING_LENGTH)) return null;
  const match = PARTICIPANT_PATTERN.exec(value);
  if (!match) return null;

  const name = match[1].trim();
  const weight = Number(match[2] ?? match[5] ?? 1);
  const count = Number(match[3] ?? match[4] ?? 1);
  if (
    !name ||
    hasControlCharacter(name) ||
    !Number.isSafeInteger(weight) ||
    weight <= 0 ||
    !Number.isSafeInteger(count) ||
    count <= 0
  ) {
    return null;
  }

  return { value, count };
}

/** Validate and copy a replay so no caller-owned nested object is retained. */
export function validateRoomReplay(value: unknown): ReplayDescriptor | null {
  if (!isRecord(value) || value.version !== SHARED_ROOM_REPLAY_VERSION) return null;

  const seed = value.seed;
  if (
    !(
      (typeof seed === 'number' && Number.isFinite(seed)) ||
      (typeof seed === 'string' && isBoundedString(seed, 256, true))
    )
  ) {
    return null;
  }

  if (!isSafeInteger(value.mapIndex) || value.mapIndex < 0) return null;
  if (!Array.isArray(value.participants) || value.participants.length === 0) return null;
  if (value.participants.length > SHARED_ROOM_MAX_PARTICIPANTS) return null;

  let totalCount = 0;
  const participants: string[] = [];
  for (const participant of value.participants) {
    const parsed = parseReplayParticipant(participant);
    if (!parsed) return null;
    totalCount += parsed.count;
    if (!Number.isSafeInteger(totalCount) || totalCount > SHARED_ROOM_MAX_PARTICIPANTS) return null;
    participants.push(parsed.value);
  }
  if (totalCount <= 0) return null;

  if (!isRecord(value.winnerRange)) return null;
  const { start, end } = value.winnerRange;
  if (
    !isSafeInteger(start) ||
    !isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= SHARED_ROOM_MAX_PARTICIPANTS
  ) {
    return null;
  }
  if (typeof value.skillsEnabled !== 'boolean') return null;

  return {
    version: SHARED_ROOM_REPLAY_VERSION,
    seed,
    mapIndex: value.mapIndex,
    participants,
    winnerRange: { start, end },
    skillsEnabled: value.skillsEnabled,
  };
}

export function isValidRoomCode(value: unknown): value is string {
  return typeof value === 'string' && ROOM_CODE_PATTERN.test(value);
}

/** Normalize display names for storage and duplicate checks. */
export function normalizeRoomDisplayName(value: string): string {
  const normalized = typeof value.normalize === 'function' ? value.normalize('NFKC') : value;
  return normalized.trim().replace(/\s+/g, ' ');
}

export function isValidRoomDisplayName(value: unknown): value is string {
  if (!isBoundedString(value, SHARED_ROOM_MAX_DISPLAY_NAME_LENGTH)) return false;
  const normalized = normalizeRoomDisplayName(value);
  return (
    normalized.length > 0 &&
    normalized.length <= SHARED_ROOM_MAX_DISPLAY_NAME_LENGTH &&
    !hasRouletteGrammarCharacter(normalized)
  );
}

function isValidToken(value: unknown): value is string {
  return isBoundedString(value, SHARED_ROOM_MAX_TOKEN_LENGTH);
}

function isValidRequestId(value: unknown): value is string {
  return isBoundedString(value, SHARED_ROOM_MAX_REQUEST_ID_LENGTH);
}

function isValidRoundId(value: unknown): value is string {
  return isBoundedString(value, SHARED_ROOM_MAX_ROUND_ID_LENGTH);
}

function parseWinners(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > SHARED_ROOM_MAX_PARTICIPANTS) return null;
  const winners: string[] = [];
  for (const winner of value) {
    if (!isBoundedString(winner, SHARED_ROOM_MAX_PARTICIPANT_STRING_LENGTH)) return null;
    winners.push(winner);
  }
  return winners;
}

function parseHello(value: RecordLike): RoomHelloMessage | null {
  if (
    value.type !== 'hello' ||
    value.protocolVersion !== SHARED_ROOM_PROTOCOL_VERSION ||
    (value.role !== 'host' && value.role !== 'guest')
  ) {
    return null;
  }

  if (value.hostToken !== undefined && !isValidToken(value.hostToken)) return null;
  if (value.resumeToken !== undefined && !isValidToken(value.resumeToken)) return null;
  if (value.participantId !== undefined && !isValidToken(value.participantId)) return null;
  if (value.displayName !== undefined && !isValidRoomDisplayName(value.displayName)) return null;

  return {
    type: 'hello',
    protocolVersion: SHARED_ROOM_PROTOCOL_VERSION,
    role: value.role,
    ...(typeof value.hostToken === 'string' ? { hostToken: value.hostToken } : {}),
    ...(typeof value.resumeToken === 'string' ? { resumeToken: value.resumeToken } : {}),
    ...(typeof value.participantId === 'string' ? { participantId: value.participantId } : {}),
    ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
  } satisfies RoomHelloMessage;
}

function parseRoomSnapshot(value: unknown): RoomSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    value.protocolVersion !== SHARED_ROOM_PROTOCOL_VERSION ||
    !isValidRoomCode(value.roomCode) ||
    !isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt) ||
    !isFiniteNumber(value.expiresAt) ||
    (value.status !== 'open' && value.status !== 'closed' && value.status !== 'expired') ||
    typeof value.joinsOpen !== 'boolean' ||
    !Array.isArray(value.participants) ||
    value.participants.length > SHARED_ROOM_MAX_PARTICIPANTS
  ) {
    return null;
  }

  const participants: RoomParticipant[] = [];
  for (const participant of value.participants) {
    if (!isRecord(participant)) return null;
    if (
      !isValidToken(participant.participantId) ||
      !isValidRoomDisplayName(participant.displayName) ||
      !isFiniteNumber(participant.joinedAt) ||
      !isSafeInteger(participant.order) ||
      participant.order < 0
    ) {
      return null;
    }
    participants.push({
      participantId: participant.participantId,
      displayName: normalizeRoomDisplayName(participant.displayName),
      joinedAt: participant.joinedAt,
      order: participant.order,
    });
  }

  const scheduledRound = value.scheduledRound === undefined ? undefined : parseScheduledRound(value.scheduledRound);
  if (value.scheduledRound !== undefined && !scheduledRound) return null;

  const lastResult = value.lastResult === undefined ? undefined : parseRoomRoundResult(value.lastResult);
  if (value.lastResult !== undefined && !lastResult) return null;

  return {
    protocolVersion: SHARED_ROOM_PROTOCOL_VERSION,
    roomCode: value.roomCode,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
    status: value.status,
    joinsOpen: value.joinsOpen,
    participants,
    ...(scheduledRound ? { scheduledRound } : {}),
    ...(lastResult ? { lastResult } : {}),
  };
}

function parseScheduledRound(value: unknown): ScheduledRound | null {
  if (!isRecord(value)) return null;
  const replay = validateRoomReplay(value.replay);
  const playback = value.playback === undefined ? DEFAULT_SHARED_PLAYBACK : validateSharedPlaybackState(value.playback);
  const playbackEffectiveAt = value.playbackEffectiveAt === undefined ? value.startAt : value.playbackEffectiveAt;
  const playbackSequence = value.playbackSequence === undefined ? 0 : value.playbackSequence;
  if (
    !isValidRoundId(value.roundId) ||
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
    return null;
  }
  return {
    roundId: value.roundId,
    sequence: value.sequence,
    replay: copyReplay(replay),
    startAt: value.startAt,
    status: value.status,
    playback: copyPlayback(playback),
    playbackEffectiveAt,
    playbackSequence,
  };
}

function parseRoomRoundResult(value: unknown): RoomRoundResult | null {
  if (!isRecord(value)) return null;
  const winners = parseWinners(value.winners);
  if (!isValidRoundId(value.roundId) || !winners || !isFiniteNumber(value.reportedAt)) return null;
  return {
    roundId: value.roundId,
    winners,
    reportedAt: value.reportedAt,
  };
}

function parseRequestId(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return isValidRequestId(value) ? value : null;
}

export function parseRoomClientMessage(value: unknown): RoomClientMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  if (value.type === 'hello') return parseHello(value);
  if (value.type === 'ping') {
    if (!isValidRequestId(value.id) || !isFiniteNumber(value.clientSentAt)) return null;
    return { type: 'ping', id: value.id, clientSentAt: value.clientSentAt };
  }
  if (value.type === 'host.schedule') {
    const replay = validateRoomReplay(value.replay);
    const playback = validateSharedPlaybackState(value.playback);
    if (!isValidRequestId(value.requestId) || !replay || !playback) return null;
    return {
      type: 'host.schedule',
      requestId: value.requestId,
      replay: copyReplay(replay),
      playback: copyPlayback(playback),
    };
  }
  if (value.type === 'host.playback-control') {
    const playback = validateSharedPlaybackPatch(value.playback);
    if (!isValidRoundId(value.roundId) || !playback) return null;
    return { type: 'host.playback-control', roundId: value.roundId, playback };
  }
  if (value.type === 'host.result') {
    const requestId = parseRequestId(value.requestId);
    const winners = parseWinners(value.winners);
    if (requestId === null || !isValidRoundId(value.roundId) || !winners) return null;
    return {
      type: 'host.result',
      roundId: value.roundId,
      winners,
      ...(requestId !== undefined ? { requestId } : {}),
    } satisfies RoomHostResultMessage;
  }
  if (value.type === 'host.cancel') {
    if (!isValidRoundId(value.roundId)) return null;
    return { type: 'host.cancel', roundId: value.roundId };
  }
  if (value.type === 'host.close') return { type: 'host.close' };
  if (value.type === 'leave') return { type: 'leave' };
  return null;
}

export function parseRoomServerMessage(value: unknown): RoomServerMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  if (value.type === 'snapshot') {
    const snapshot = parseRoomSnapshot(value.snapshot);
    return snapshot ? { type: 'snapshot', snapshot } : null;
  }
  if (value.type === 'joined') {
    const snapshot = parseRoomSnapshot(value.snapshot);
    if (!isValidToken(value.participantId) || !isValidToken(value.resumeToken) || !snapshot) return null;
    return { type: 'joined', participantId: value.participantId, resumeToken: value.resumeToken, snapshot };
  }
  if (value.type === 'round.scheduled') {
    const round = parseScheduledRound(value.round);
    if (!isValidRequestId(value.requestId) || !round || round.status !== 'scheduled') return null;
    return { type: 'round.scheduled', requestId: value.requestId, round };
  }
  if (value.type === 'round.started') {
    const round = parseScheduledRound(value.round);
    return round && round.status === 'running' ? { type: 'round.started', round } : null;
  }
  if (value.type === 'round.playback-control') {
    const playback = validateSharedPlaybackState(value.playback);
    if (
      !isValidRoundId(value.roundId) ||
      !isSafeInteger(value.controlSequence) ||
      value.controlSequence <= 0 ||
      !isFiniteNumber(value.effectiveAt) ||
      !playback
    ) {
      return null;
    }
    return {
      type: 'round.playback-control',
      roundId: value.roundId,
      controlSequence: value.controlSequence,
      effectiveAt: value.effectiveAt,
      playback: copyPlayback(playback),
    };
  }
  if (value.type === 'round.result') {
    const result = parseRoomRoundResult(value.result);
    const snapshot = parseRoomSnapshot(value.snapshot);
    return result && snapshot ? { type: 'round.result', result, snapshot } : null;
  }
  if (value.type === 'round.cancelled') {
    const snapshot = parseRoomSnapshot(value.snapshot);
    if (!isValidRoundId(value.roundId) || !isBoundedString(value.reason, 256) || !snapshot) return null;
    return { type: 'round.cancelled', roundId: value.roundId, reason: value.reason, snapshot };
  }
  if (value.type === 'room.closed') {
    const snapshot = parseRoomSnapshot(value.snapshot);
    if (!isBoundedString(value.reason, 256) || !snapshot) return null;
    return { type: 'room.closed', reason: value.reason, snapshot };
  }
  if (value.type === 'pong') {
    if (!isValidRequestId(value.id) || !isFiniteNumber(value.clientSentAt) || !isFiniteNumber(value.serverTime)) {
      return null;
    }
    return {
      type: 'pong',
      id: value.id,
      clientSentAt: value.clientSentAt,
      serverTime: value.serverTime,
    };
  }
  if (value.type === 'error') {
    const requestId = parseRequestId(value.requestId);
    if (
      requestId === null ||
      !isBoundedString(value.code, 96) ||
      !isBoundedString(value.message, 512)
    ) {
      return null;
    }
    return {
      type: 'error',
      code: value.code,
      message: value.message,
      ...(requestId !== undefined ? { requestId } : {}),
    } satisfies RoomErrorMessage;
  }
  if (value.type === 'connection') {
    if (value.status !== 'open' && value.status !== 'closed') return null;
    return { type: 'connection', status: value.status };
  }
  return null;
}
