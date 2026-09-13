import type { Seed } from './utils/random';

export const FAIRNESS_DATA_VERSION = 1 as const;
export const STRICT_BALANCE_POLICY_ID = 'strict-balance-v1' as const;
export const STRICT_BALANCE_POLICY_VERSION = 1 as const;
const FAIRNESS_SEARCH_SUCCESS_TARGET = 0.95;
const MAX_FAIRNESS_SEARCH_ATTEMPTS = 3072;

export type FairnessMode = 'simple' | 'complete';

export type FairnessPolicyDescriptor = Readonly<{
  id: typeof STRICT_BALANCE_POLICY_ID;
  version: typeof STRICT_BALANCE_POLICY_VERSION;
}>;

export type FairnessParticipantSnapshot = Readonly<{
  participantId: string;
  displayName: string;
  rawInput: string;
  weight: number;
  count: number;
  marbleIds: readonly number[];
  active: boolean;
  excluded: boolean;
  included: boolean;
  effectiveBalance: number;
}>;

export type FairnessWinnerSnapshot = Readonly<{
  participantId: string;
  displayName: string;
  marbleId?: number;
}>;

type FairnessEventBase = Readonly<{
  version: typeof FAIRNESS_DATA_VERSION;
  eventId: string;
  timestamp: number;
}>;

export type FairnessEpochStartedEvent = FairnessEventBase &
  Readonly<{
    type: 'epochStarted';
    epochId: string;
  }>;

export type FairnessParticipantDiscoveredEvent = FairnessEventBase &
  Readonly<{
    type: 'participantDiscovered';
    participantId: string;
    displayName: string;
    active: boolean;
    excluded: boolean;
  }>;

export type FairnessParticipantRenamedEvent = FairnessEventBase &
  Readonly<{
    type: 'participantRenamed';
    participantId: string;
    displayName: string;
    rawInput?: string;
  }>;

export type FairnessParticipantParticipationChangedEvent = FairnessEventBase &
  Readonly<{
    type: 'participantParticipationChanged';
    participantId: string;
    active: boolean;
  }>;

export type FairnessParticipantInactiveEvent = FairnessEventBase &
  Readonly<{
    type: 'participantInactive';
    participantId: string;
  }>;

export type FairnessParticipantExclusionChangedEvent = FairnessEventBase &
  Readonly<{
    type: 'participantExclusionChanged';
    participantId: string;
    excluded: boolean;
  }>;

export type FairnessDrawPreparedEvent = FairnessEventBase &
  Readonly<{
    type: 'drawPrepared';
    drawId: string;
    epochId: string;
    seed: Seed;
    mapIndex: number;
    mapTitle: string;
    rawParticipantInputs: readonly string[];
    winnerRange: Readonly<{ start: number; end: number }>;
    skillsEnabled: boolean;
    fairnessEnabledAtDraw: boolean;
    policy: FairnessPolicyDescriptor;
    participants: readonly FairnessParticipantSnapshot[];
  }>;

export type FairnessDrawConfirmedEvent = FairnessEventBase &
  Readonly<{
    type: 'drawConfirmed';
    drawId: string;
    winners: readonly FairnessWinnerSnapshot[];
  }>;

export type FairnessDrawFailedEvent = FairnessEventBase &
  Readonly<{
    type: 'drawFailed';
    drawId: string;
    reason: string;
  }>;

export type FairnessDrawCancelledEvent = FairnessEventBase &
  Readonly<{
    type: 'drawCancelled';
    drawId: string;
    reason: string;
  }>;

export type FairnessDrawVoidedEvent = FairnessEventBase &
  Readonly<{
    type: 'drawVoided';
    drawId: string;
    reason?: string;
  }>;

export type FairnessEvent =
  | FairnessEpochStartedEvent
  | FairnessParticipantDiscoveredEvent
  | FairnessParticipantRenamedEvent
  | FairnessParticipantParticipationChangedEvent
  | FairnessParticipantInactiveEvent
  | FairnessParticipantExclusionChangedEvent
  | FairnessDrawPreparedEvent
  | FairnessDrawConfirmedEvent
  | FairnessDrawFailedEvent
  | FairnessDrawCancelledEvent
  | FairnessDrawVoidedEvent;

export type FairnessDrawStatus = 'prepared' | 'confirmed' | 'failed' | 'cancelled' | 'voided';

export type FairnessProjectedParticipant = {
  id: string;
  displayName: string;
  createdAt: number;
  active: boolean;
  excluded: boolean;
  actualWins: number;
  fairnessCountedWins: number;
  currentEpochWins: number;
  effectiveBalance: number;
  previousEffectiveBalance: number;
  participationHistory: Array<Readonly<{ timestamp: number; active: boolean }>>;
};

export type FairnessEpochProjection = {
  id: string;
  startedAt: number;
  balances: Record<string, number>;
  wins: Record<string, number>;
};

export type FairnessProjectedDraw = {
  id: string;
  epochId: string;
  status: FairnessDrawStatus;
  preparedAt: number;
  confirmedAt?: number;
  voidedAt?: number;
  seed: Seed;
  mapIndex: number;
  mapTitle: string;
  rawParticipantInputs: string[];
  winnerRange: { start: number; end: number };
  skillsEnabled: boolean;
  fairnessEnabledAtDraw: boolean;
  policy: FairnessPolicyDescriptor;
  participants: FairnessParticipantSnapshot[];
  winners: FairnessWinnerSnapshot[];
  failureReason?: string;
};

export type FairnessProjection = {
  version: typeof FAIRNESS_DATA_VERSION;
  participants: FairnessProjectedParticipant[];
  epochs: FairnessEpochProjection[];
  draws: FairnessProjectedDraw[];
  currentEpochId: string | null;
};

export type FairnessPublicParticipant = Readonly<{
  id: string;
  displayName: string;
  createdAt: number;
  active: boolean;
  excluded: boolean;
  actualWins: number;
  fairnessCountedWins: number;
  currentEpochWins: number;
  balanceCredit: number;
  effectiveBalance: number;
  participationHistory: readonly Readonly<{ timestamp: number; active: boolean }>[];
}>;

export type FairnessDrawSummary = Readonly<{
  id: string;
  epochId: string;
  status: FairnessDrawStatus;
  seed: Seed;
  mapIndex: number;
  mapTitle: string;
  rawParticipantInputs: readonly string[];
  winnerRange: Readonly<{ start: number; end: number }>;
  skillsEnabled: boolean;
  fairnessEnabledAtDraw: boolean;
  policy: FairnessPolicyDescriptor;
  participants: readonly FairnessParticipantSnapshot[];
  winners: readonly FairnessWinnerSnapshot[];
  participantCount: number;
  preparedAt: number;
  confirmedAt?: number;
  voidedAt?: number;
  failureReason?: string;
}>;

export type FairnessCurrentEpoch = Readonly<{
  id: string;
  startedAt: number;
  minimumEffectiveBalance: number;
  participantIds: readonly string[];
}>;

export type FairnessState = Readonly<{
  available: boolean;
  enabled: boolean;
  mode: FairnessMode;
  participants: readonly FairnessPublicParticipant[];
  recentDraws: readonly FairnessDrawSummary[];
  currentEpoch: FairnessCurrentEpoch | null;
  policy: FairnessPolicyDescriptor;
  error: string | null;
}>;

export type FairnessExport = Readonly<{
  version: typeof FAIRNESS_DATA_VERSION;
  mode: FairnessMode;
  events: readonly FairnessEvent[];
}>;

export type FairnessPolicyInput = Readonly<{
  id: string;
  active: boolean;
  excluded: boolean;
  effectiveBalance: number;
}>;

export type StrictBalanceEvaluation = Readonly<{
  minimumEffectiveBalance: number;
  eligibleIds: readonly string[];
  activeIncludedIds: readonly string[];
  activeExcludedIds: readonly string[];
}>;

const policyDescriptor: FairnessPolicyDescriptor = {
  id: STRICT_BALANCE_POLICY_ID,
  version: STRICT_BALANCE_POLICY_VERSION,
};

let fallbackIdCounter = 0;

function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeString(value: unknown, maxLength = 512): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isSeed(value: unknown): value is Seed {
  return (typeof value === 'string' && value.length <= 512) || (typeof value === 'number' && Number.isFinite(value));
}

function invalid(message: string): never {
  throw new Error(`Invalid fairness data: ${message}`);
}

export function createFairnessId(prefix = 'fair'): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject) {
    try {
      const values = new Uint32Array(4);
      cryptoObject.getRandomValues(values);
      return `${prefix}-${[...values].map((value) => value.toString(16).padStart(8, '0')).join('')}`;
    } catch {
      // The timestamp/counter fallback below keeps IDs unique enough for a local event log.
    }
  }

  fallbackIdCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
}

export function createFairnessCandidateSeed(): string {
  return createFairnessId('seed');
}

export function getPolicyDescriptor(): FairnessPolicyDescriptor {
  return { ...policyDescriptor };
}

export class StrictBalancePolicy {
  readonly id = STRICT_BALANCE_POLICY_ID;
  readonly version = STRICT_BALANCE_POLICY_VERSION;

  evaluate(participants: readonly FairnessPolicyInput[]): StrictBalanceEvaluation {
    return evaluateStrictBalance(participants);
  }
}

export const strictBalancePolicy = new StrictBalancePolicy();

export function evaluateStrictBalance(participants: readonly FairnessPolicyInput[]): StrictBalanceEvaluation {
  const activeIncluded = participants.filter((participant) => participant.active && !participant.excluded);
  const activeExcluded = participants.filter((participant) => participant.active && participant.excluded);
  const minimumEffectiveBalance = activeIncluded.length
    ? Math.min(...activeIncluded.map((participant) => participant.effectiveBalance))
    : 0;
  const eligibleIds = activeIncluded
    .filter((participant) => participant.effectiveBalance === minimumEffectiveBalance)
    .map((participant) => participant.id);

  return {
    minimumEffectiveBalance,
    eligibleIds,
    activeIncludedIds: activeIncluded.map((participant) => participant.id),
    activeExcludedIds: activeExcluded.map((participant) => participant.id),
  };
}

export function canUseStrictBalanceFastPath(evaluation: StrictBalanceEvaluation): boolean {
  return (
    evaluation.activeIncludedIds.length > 0 &&
    evaluation.activeExcludedIds.length === 0 &&
    evaluation.eligibleIds.length === evaluation.activeIncludedIds.length
  );
}

/**
 * Finite candidate count for the strict policy. The budget targets a 95%
 * candidate-coverage probability using the conservative ratio of eligible
 * participants to all marbles, while the hard cap keeps an adversarial input
 * bounded on the main thread. Search yields between candidates.
 */
export function searchBudget(totalMarbles: number, participantCount: number, eligibleCount: number): number {
  if (
    !Number.isSafeInteger(totalMarbles) ||
    !Number.isSafeInteger(participantCount) ||
    !Number.isSafeInteger(eligibleCount) ||
    totalMarbles <= 0 ||
    participantCount <= 0 ||
    eligibleCount <= 0 ||
    eligibleCount > participantCount
  ) {
    return 0;
  }

  const participantProbability = eligibleCount / participantCount;
  const marbleProbability = eligibleCount / totalMarbles;
  const conservativeProbability = Math.min(participantProbability, marbleProbability);
  const targetAttempts = Math.ceil(Math.log(1 - FAIRNESS_SEARCH_SUCCESS_TARGET) / Math.log1p(-conservativeProbability));
  return Math.min(MAX_FAIRNESS_SEARCH_ATTEMPTS, Math.max(32, targetAttempts));
}

function getEpoch(projection: FairnessProjection, epochId: string | null): FairnessEpochProjection | undefined {
  return epochId ? projection.epochs.find((epoch) => epoch.id === epochId) : undefined;
}

function getParticipant(
  projection: FairnessProjection,
  participantId: string
): FairnessProjectedParticipant | undefined {
  return projection.participants.find((participant) => participant.id === participantId);
}

function getBalance(epoch: FairnessEpochProjection | undefined, participantId: string): number {
  return epoch?.balances[participantId] ?? 0;
}

function activeMinimum(projection: FairnessProjection, epoch: FairnessEpochProjection | undefined): number {
  const activeIncluded = projection.participants.filter((participant) => participant.active && !participant.excluded);
  if (activeIncluded.length === 0) return 0;
  return Math.min(...activeIncluded.map((participant) => getBalance(epoch, participant.id)));
}

function setCurrentEpochValues(projection: FairnessProjection): void {
  const epoch = getEpoch(projection, projection.currentEpochId);
  projection.participants.forEach((participant) => {
    participant.effectiveBalance = getBalance(epoch, participant.id);
    participant.currentEpochWins = epoch?.wins[participant.id] ?? 0;
  });
}

function copyWinnerSnapshots(winners: readonly FairnessWinnerSnapshot[]): FairnessWinnerSnapshot[] {
  return winners.map((winner) => ({ ...winner }));
}

function uniqueWinners(winners: readonly FairnessWinnerSnapshot[]): FairnessWinnerSnapshot[] {
  const seen = new Set<string>();
  return winners.filter((winner) => {
    if (seen.has(winner.participantId)) return false;
    seen.add(winner.participantId);
    return true;
  });
}

function applyConfirmedDraw(projection: FairnessProjection, event: FairnessDrawConfirmedEvent): void {
  const draw = projection.draws.find((candidate) => candidate.id === event.drawId);
  if (!draw || draw.status !== 'prepared') return;

  const winners = uniqueWinners(event.winners);
  const epoch = projection.epochs.find((candidate) => candidate.id === draw.epochId);
  winners.forEach((winner) => {
    const participant = getParticipant(projection, winner.participantId);
    if (!participant) return;

    participant.actualWins += 1;
    const snapshot = draw.participants.find((candidate) => candidate.participantId === winner.participantId);
    if (!snapshot?.included || !epoch) return;

    participant.fairnessCountedWins += 1;
    epoch.balances[winner.participantId] = getBalance(epoch, winner.participantId) + 1;
    epoch.wins[winner.participantId] = (epoch.wins[winner.participantId] ?? 0) + 1;
  });

  draw.winners = copyWinnerSnapshots(winners);
  draw.status = 'confirmed';
  draw.confirmedAt = event.timestamp;
}

function applyVoidedDraw(projection: FairnessProjection, event: FairnessDrawVoidedEvent): void {
  const draw = projection.draws.find((candidate) => candidate.id === event.drawId);
  if (!draw || draw.status === 'voided') return;

  if (draw.status === 'confirmed') {
    const epoch = projection.epochs.find((candidate) => candidate.id === draw.epochId);
    uniqueWinners(draw.winners).forEach((winner) => {
      const participant = getParticipant(projection, winner.participantId);
      if (participant) participant.actualWins = Math.max(0, participant.actualWins - 1);

      const snapshot = draw.participants.find((candidate) => candidate.participantId === winner.participantId);
      if (!participant || !snapshot?.included || !epoch) return;

      participant.fairnessCountedWins = Math.max(0, participant.fairnessCountedWins - 1);
      epoch.balances[winner.participantId] = Math.max(0, getBalance(epoch, winner.participantId) - 1);
      epoch.wins[winner.participantId] = Math.max(0, (epoch.wins[winner.participantId] ?? 0) - 1);
    });
  }

  draw.status = 'voided';
  draw.voidedAt = event.timestamp;
}

function emptyProjection(): FairnessProjection {
  return {
    version: FAIRNESS_DATA_VERSION,
    participants: [],
    epochs: [],
    draws: [],
    currentEpochId: null,
  };
}

export function projectFairnessEvents(events: readonly FairnessEvent[]): FairnessProjection {
  const projection = emptyProjection();

  events.forEach((event) => {
    switch (event.type) {
      case 'epochStarted': {
        projection.participants.forEach((participant) => {
          participant.previousEffectiveBalance = 0;
        });

        const epoch: FairnessEpochProjection = {
          id: event.epochId,
          startedAt: event.timestamp,
          balances: Object.create(null) as Record<string, number>,
          wins: Object.create(null) as Record<string, number>,
        };
        projection.participants.forEach((participant) => {
          if (participant.active) epoch.balances[participant.id] = 0;
        });
        projection.epochs.push(epoch);
        projection.currentEpochId = epoch.id;
        setCurrentEpochValues(projection);
        break;
      }
      case 'participantDiscovered': {
        if (getParticipant(projection, event.participantId)) break;

        const epoch = getEpoch(projection, projection.currentEpochId);
        const initialBalance = activeMinimum(projection, epoch);
        const participant: FairnessProjectedParticipant = {
          id: event.participantId,
          displayName: event.displayName,
          createdAt: event.timestamp,
          active: event.active,
          excluded: event.excluded,
          actualWins: 0,
          fairnessCountedWins: 0,
          currentEpochWins: 0,
          effectiveBalance: initialBalance,
          previousEffectiveBalance: 0,
          participationHistory: [{ timestamp: event.timestamp, active: event.active }],
        };
        projection.participants.push(participant);
        if (epoch && event.active) epoch.balances[event.participantId] = initialBalance;
        setCurrentEpochValues(projection);
        break;
      }
      case 'participantRenamed': {
        const participant = getParticipant(projection, event.participantId);
        if (participant) participant.displayName = event.displayName;
        break;
      }
      case 'participantParticipationChanged':
      case 'participantInactive': {
        const participant = getParticipant(projection, event.participantId);
        if (!participant) break;

        const nextActive = event.type === 'participantInactive' ? false : event.active;
        const epoch = getEpoch(projection, projection.currentEpochId);
        if (participant.active === nextActive) break;

        if (!nextActive) {
          participant.previousEffectiveBalance = getBalance(epoch, participant.id);
          participant.active = false;
        } else {
          const minimum = activeMinimum(projection, epoch);
          participant.active = true;
          const rejoinBalance = Math.max(participant.previousEffectiveBalance, minimum);
          participant.effectiveBalance = rejoinBalance;
          if (epoch) epoch.balances[participant.id] = rejoinBalance;
        }
        participant.participationHistory.push({ timestamp: event.timestamp, active: nextActive });
        setCurrentEpochValues(projection);
        break;
      }
      case 'participantExclusionChanged': {
        const participant = getParticipant(projection, event.participantId);
        if (participant) participant.excluded = event.excluded;
        break;
      }
      case 'drawPrepared': {
        if (projection.draws.some((draw) => draw.id === event.drawId)) break;
        projection.draws.push({
          id: event.drawId,
          epochId: event.epochId,
          status: 'prepared',
          preparedAt: event.timestamp,
          seed: event.seed,
          mapIndex: event.mapIndex,
          mapTitle: event.mapTitle,
          rawParticipantInputs: [...event.rawParticipantInputs],
          winnerRange: { ...event.winnerRange },
          skillsEnabled: event.skillsEnabled,
          fairnessEnabledAtDraw: event.fairnessEnabledAtDraw,
          policy: { ...event.policy },
          participants: event.participants.map((participant) => ({
            ...participant,
            marbleIds: [...participant.marbleIds],
          })),
          winners: [],
        });
        break;
      }
      case 'drawConfirmed':
        applyConfirmedDraw(projection, event);
        setCurrentEpochValues(projection);
        break;
      case 'drawFailed':
      case 'drawCancelled': {
        const draw = projection.draws.find((candidate) => candidate.id === event.drawId);
        if (draw && draw.status === 'prepared') {
          draw.status = event.type === 'drawFailed' ? 'failed' : 'cancelled';
          draw.failureReason = event.reason;
        }
        break;
      }
      case 'drawVoided':
        applyVoidedDraw(projection, event);
        setCurrentEpochValues(projection);
        break;
    }
  });

  setCurrentEpochValues(projection);
  return projection;
}

export function getCurrentEpoch(projection: FairnessProjection): FairnessCurrentEpoch | null {
  const epoch = getEpoch(projection, projection.currentEpochId);
  if (!epoch) return null;

  const participantIds = projection.participants
    .filter((participant) => participant.active)
    .map((participant) => participant.id);
  const activeIncluded = projection.participants.filter((participant) => participant.active && !participant.excluded);
  return {
    id: epoch.id,
    startedAt: epoch.startedAt,
    minimumEffectiveBalance: activeIncluded.length
      ? Math.min(...activeIncluded.map((participant) => getBalance(epoch, participant.id)))
      : 0,
    participantIds,
  };
}

export function createFairnessState(
  projection: FairnessProjection,
  options: Readonly<{ available: boolean; enabled: boolean; mode: FairnessMode; error?: string | null }>
): FairnessState {
  const draws =
    options.mode === 'complete' ? projection.draws.slice().reverse() : projection.draws.slice(-20).reverse();
  return {
    available: options.available,
    enabled: options.enabled,
    mode: options.mode,
    participants: projection.participants.map((participant) => ({
      id: participant.id,
      displayName: participant.displayName,
      createdAt: participant.createdAt,
      active: participant.active,
      excluded: participant.excluded,
      actualWins: participant.actualWins,
      fairnessCountedWins: participant.fairnessCountedWins,
      currentEpochWins: participant.currentEpochWins,
      balanceCredit: Math.max(0, participant.effectiveBalance - participant.currentEpochWins),
      effectiveBalance: participant.effectiveBalance,
      participationHistory: participant.participationHistory.map((change) => ({ ...change })),
    })),
    recentDraws: draws.map((draw) => ({
      id: draw.id,
      epochId: draw.epochId,
      status: draw.status,
      seed: draw.seed,
      mapIndex: draw.mapIndex,
      mapTitle: draw.mapTitle,
      rawParticipantInputs: draw.rawParticipantInputs.slice(),
      winnerRange: { ...draw.winnerRange },
      skillsEnabled: draw.skillsEnabled,
      fairnessEnabledAtDraw: draw.fairnessEnabledAtDraw,
      policy: { ...draw.policy },
      participants: draw.participants.map((participant) => ({
        ...participant,
        marbleIds: [...participant.marbleIds],
      })),
      winners: copyWinnerSnapshots(draw.winners),
      participantCount: draw.participants.length,
      preparedAt: draw.preparedAt,
      confirmedAt: draw.confirmedAt,
      voidedAt: draw.voidedAt,
      failureReason: draw.failureReason,
    })),
    currentEpoch: getCurrentEpoch(projection),
    policy: getPolicyDescriptor(),
    error: options.error ?? null,
  };
}

export function validateFairnessEvent(value: unknown): FairnessEvent {
  if (!isRecord(value)) invalid('event must be an object');
  if (value.version !== FAIRNESS_DATA_VERSION) invalid('unsupported event version');
  if (!isSafeString(value.eventId, 256)) invalid('eventId is invalid');
  if (!isFiniteNumber(value.timestamp) || value.timestamp < 0) invalid('timestamp is invalid');
  if (!isSafeString(value.type, 80)) invalid('event type is invalid');

  const base = {
    version: FAIRNESS_DATA_VERSION,
    eventId: value.eventId,
    timestamp: value.timestamp,
  } as const;

  switch (value.type) {
    case 'epochStarted':
      if (!isSafeString(value.epochId, 256)) invalid('epochId is invalid');
      return { ...base, type: value.type, epochId: value.epochId };
    case 'participantDiscovered':
      if (!isSafeString(value.participantId, 256) || !isSafeString(value.displayName))
        invalid('participant discovery is invalid');
      if (typeof value.active !== 'boolean' || typeof value.excluded !== 'boolean')
        invalid('participant status is invalid');
      return {
        ...base,
        type: value.type,
        participantId: value.participantId,
        displayName: value.displayName,
        active: value.active,
        excluded: value.excluded,
      };
    case 'participantRenamed':
      if (!isSafeString(value.participantId, 256) || !isSafeString(value.displayName))
        invalid('participant rename is invalid');
      if (value.rawInput !== undefined && (typeof value.rawInput !== 'string' || value.rawInput.length > 1024)) {
        invalid('participant rename input is invalid');
      }
      return {
        ...base,
        type: value.type,
        participantId: value.participantId,
        displayName: value.displayName,
        ...(value.rawInput === undefined ? {} : { rawInput: value.rawInput }),
      };
    case 'participantParticipationChanged':
      if (!isSafeString(value.participantId, 256) || typeof value.active !== 'boolean')
        invalid('participant participation is invalid');
      return { ...base, type: value.type, participantId: value.participantId, active: value.active };
    case 'participantInactive':
      if (!isSafeString(value.participantId, 256)) invalid('inactive participant is invalid');
      return { ...base, type: value.type, participantId: value.participantId };
    case 'participantExclusionChanged':
      if (!isSafeString(value.participantId, 256) || typeof value.excluded !== 'boolean')
        invalid('participant exclusion is invalid');
      return { ...base, type: value.type, participantId: value.participantId, excluded: value.excluded };
    case 'drawPrepared': {
      if (
        !isSafeString(value.drawId, 256) ||
        !isSafeString(value.epochId, 256) ||
        !isSeed(value.seed) ||
        !isSafeInteger(value.mapIndex) ||
        value.mapIndex < 0 ||
        !isSafeString(value.mapTitle) ||
        !Array.isArray(value.rawParticipantInputs) ||
        !value.rawParticipantInputs.every((input) => typeof input === 'string' && input.length <= 1024) ||
        !isRecord(value.winnerRange) ||
        !isSafeInteger(value.winnerRange.start) ||
        !isSafeInteger(value.winnerRange.end) ||
        value.winnerRange.start < 0 ||
        value.winnerRange.end < value.winnerRange.start ||
        typeof value.skillsEnabled !== 'boolean' ||
        typeof value.fairnessEnabledAtDraw !== 'boolean' ||
        !isRecord(value.policy) ||
        value.policy.id !== STRICT_BALANCE_POLICY_ID ||
        value.policy.version !== STRICT_BALANCE_POLICY_VERSION ||
        !Array.isArray(value.participants)
      ) {
        invalid('draw preparation is invalid');
      }

      const participants = value.participants.map((candidate) => {
        if (!isRecord(candidate)) invalid('draw participant snapshot is invalid');
        if (
          !isSafeString(candidate.participantId, 256) ||
          !isSafeString(candidate.displayName) ||
          typeof candidate.rawInput !== 'string' ||
          candidate.rawInput.length > 1024 ||
          !isFiniteNumber(candidate.weight) ||
          candidate.weight <= 0 ||
          !isSafeInteger(candidate.count) ||
          candidate.count <= 0 ||
          !Array.isArray(candidate.marbleIds) ||
          !candidate.marbleIds.every((id) => isSafeInteger(id) && id >= 0) ||
          typeof candidate.active !== 'boolean' ||
          typeof candidate.excluded !== 'boolean' ||
          typeof candidate.included !== 'boolean' ||
          !isFiniteNumber(candidate.effectiveBalance) ||
          !Number.isSafeInteger(candidate.effectiveBalance) ||
          candidate.effectiveBalance < 0 ||
          candidate.included !== (candidate.active && !candidate.excluded) ||
          candidate.marbleIds.length !== candidate.count
        ) {
          invalid('draw participant snapshot is invalid');
        }
        return {
          participantId: candidate.participantId,
          displayName: candidate.displayName,
          rawInput: candidate.rawInput,
          weight: candidate.weight,
          count: candidate.count,
          marbleIds: [...candidate.marbleIds],
          active: candidate.active,
          excluded: candidate.excluded,
          included: candidate.included,
          effectiveBalance: candidate.effectiveBalance,
        };
      });

      if (participants.length === 0) invalid('draw participant snapshot is empty');

      const marbleIds = new Set<number>();
      let totalCount = 0;
      participants.forEach((participant) => {
        totalCount += participant.count;
        participant.marbleIds.forEach((marbleId) => {
          if (marbleIds.has(marbleId)) invalid('draw marble mapping is not unique');
          marbleIds.add(marbleId);
        });
      });
      if (
        !Number.isSafeInteger(totalCount) ||
        marbleIds.size !== totalCount ||
        !Array.from({ length: totalCount }, (_, index) => index).every((index) => marbleIds.has(index)) ||
        value.winnerRange.end >= totalCount
      ) {
        invalid('draw marble mapping is invalid');
      }

      return {
        ...base,
        type: value.type,
        drawId: value.drawId,
        epochId: value.epochId,
        seed: value.seed,
        mapIndex: value.mapIndex,
        mapTitle: value.mapTitle,
        rawParticipantInputs: [...value.rawParticipantInputs],
        winnerRange: { start: value.winnerRange.start, end: value.winnerRange.end },
        skillsEnabled: value.skillsEnabled,
        fairnessEnabledAtDraw: value.fairnessEnabledAtDraw,
        policy: getPolicyDescriptor(),
        participants,
      };
    }
    case 'drawConfirmed': {
      if (!isSafeString(value.drawId, 256) || !Array.isArray(value.winners) || value.winners.length === 0) {
        invalid('draw confirmation is invalid');
      }
      const winners = value.winners.map((candidate) => {
        if (typeof candidate === 'string') {
          if (!isSafeString(candidate, 256)) invalid('draw winner is invalid');
          return { participantId: candidate, displayName: candidate };
        }
        if (
          !isRecord(candidate) ||
          !isSafeString(candidate.participantId, 256) ||
          !isSafeString(candidate.displayName)
        ) {
          invalid('draw winner is invalid');
        }
        if (candidate.marbleId !== undefined && (!isSafeInteger(candidate.marbleId) || candidate.marbleId < 0)) {
          invalid('draw winner marble is invalid');
        }
        return {
          participantId: candidate.participantId,
          displayName: candidate.displayName,
          ...(candidate.marbleId === undefined ? {} : { marbleId: candidate.marbleId }),
        };
      });
      return { ...base, type: value.type, drawId: value.drawId, winners };
    }
    case 'drawFailed':
    case 'drawCancelled':
      if (!isSafeString(value.drawId, 256) || !isSafeString(value.reason, 2048)) invalid('draw failure is invalid');
      return { ...base, type: value.type, drawId: value.drawId, reason: value.reason };
    case 'drawVoided':
      if (!isSafeString(value.drawId, 256)) invalid('draw void is invalid');
      if (value.reason !== undefined && !isSafeString(value.reason, 2048)) invalid('draw void reason is invalid');
      return {
        ...base,
        type: value.type,
        drawId: value.drawId,
        ...(value.reason === undefined ? {} : { reason: value.reason }),
      };
    default:
      invalid('unsupported event type');
  }
}

export function validateFairnessExport(value: unknown): FairnessExport {
  if (!isRecord(value)) invalid('export must be an object');
  if (value.version !== FAIRNESS_DATA_VERSION) invalid('unsupported export version');
  const mode = value.mode === undefined ? 'simple' : value.mode;
  if (mode !== 'simple' && mode !== 'complete') invalid('mode is invalid');
  if (!Array.isArray(value.events)) invalid('events must be an array');

  const events = value.events.map((event) => validateFairnessEvent(event));
  validateFairnessEventSequence(events);
  return { version: FAIRNESS_DATA_VERSION, mode, events: copyJson(events) };
}

function validateFairnessEventSequence(events: readonly FairnessEvent[]): void {
  const eventIds = new Set<string>();
  const epochs = new Set<string>();
  const participants = new Set<string>();
  const draws = new Map<string, 'prepared' | 'confirmed' | 'failed' | 'cancelled' | 'voided'>();

  for (const event of events) {
    if (eventIds.has(event.eventId)) invalid('eventId must be unique');
    eventIds.add(event.eventId);

    switch (event.type) {
      case 'epochStarted':
        if (epochs.has(event.epochId)) invalid('epochId must be unique');
        epochs.add(event.epochId);
        break;
      case 'participantDiscovered':
        if (participants.has(event.participantId)) invalid('participantId must be unique');
        participants.add(event.participantId);
        break;
      case 'participantRenamed':
      case 'participantParticipationChanged':
      case 'participantInactive':
      case 'participantExclusionChanged':
        if (!participants.has(event.participantId)) invalid('participant event references an unknown participant');
        break;
      case 'drawPrepared': {
        if (!epochs.has(event.epochId)) invalid('draw references an unknown epoch');
        if (draws.has(event.drawId)) invalid('drawId must be unique');
        const snapshotIds = new Set<string>();
        event.participants.forEach((participant) => {
          if (!participants.has(participant.participantId)) invalid('draw references an unknown participant');
          if (snapshotIds.has(participant.participantId)) invalid('draw participant snapshot must be unique');
          snapshotIds.add(participant.participantId);
        });
        draws.set(event.drawId, 'prepared');
        break;
      }
      case 'drawConfirmed': {
        const status = draws.get(event.drawId);
        if (status !== 'prepared') invalid('draw confirmation references a non-prepared draw');
        const prepared = events.find(
          (candidate): candidate is FairnessDrawPreparedEvent =>
            candidate.type === 'drawPrepared' && candidate.drawId === event.drawId
        );
        if (!prepared) invalid('draw confirmation references a missing preparation');
        event.winners.forEach((winner) => {
          const participant = prepared.participants.find(
            (candidate) => candidate.participantId === winner.participantId
          );
          if (!participant) {
            invalid('draw winner is not in the prepared participant snapshot');
          }
          if (winner.marbleId !== undefined && !participant.marbleIds.includes(winner.marbleId)) {
            invalid('draw winner marble is not in the prepared participant snapshot');
          }
        });
        draws.set(event.drawId, 'confirmed');
        break;
      }
      case 'drawFailed':
      case 'drawCancelled':
        if (draws.get(event.drawId) !== 'prepared') invalid('draw terminal event references a non-prepared draw');
        draws.set(event.drawId, event.type === 'drawFailed' ? 'failed' : 'cancelled');
        break;
      case 'drawVoided': {
        const status = draws.get(event.drawId);
        if (status !== 'confirmed') invalid('only confirmed draws can be voided');
        draws.set(event.drawId, 'voided');
        break;
      }
    }
  }
}

export function createFairnessExport(events: readonly FairnessEvent[], mode: FairnessMode): FairnessExport {
  return validateFairnessExport({ version: FAIRNESS_DATA_VERSION, mode, events: copyJson(events) });
}
