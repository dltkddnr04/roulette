import type { Seed } from './utils/random';

export const FAIRNESS_DATA_VERSION = 2 as const;
export const LEGACY_FAIRNESS_DATA_VERSION = 1 as const;
export const STRICT_BALANCE_POLICY_ID = 'strict-balance-v1' as const;
export const STRICT_BALANCE_POLICY_VERSION = 1 as const;
const FAIRNESS_SEARCH_SUCCESS_TARGET = 0.95;
const MAX_FAIRNESS_SEARCH_ATTEMPTS = 3072;

export type FairnessMode = 'simple' | 'complete';

export type FairnessPolicyDescriptor = Readonly<{
  id: typeof STRICT_BALANCE_POLICY_ID;
  version: typeof STRICT_BALANCE_POLICY_VERSION;
}>;

export type FairnessMemberSnapshot = Readonly<{
  participantId: string;
  displayName: string;
  active: boolean;
  excluded: boolean;
  included: boolean;
  effectiveBalance: number;
}>;

export type FairnessDrawEntrySnapshot = Readonly<{
  entryId: string;
  displayName: string;
  rawInput: string;
  memberIds: readonly string[];
  weight: number;
  count: number;
  marbleIds: readonly number[];
}>;

export type FairnessWinnerMemberSnapshot = Readonly<{
  participantId: string;
  displayName: string;
}>;

export type FairnessWinnerSnapshot = Readonly<{
  entryId: string;
  entryDisplayName: string;
  marbleId?: number;
  members: readonly FairnessWinnerMemberSnapshot[];
}>;

type FairnessEventBase = Readonly<{
  version: typeof FAIRNESS_DATA_VERSION;
  eventId: string;
  timestamp: number;
}>;

export type FairnessEpochStartedEvent = FairnessEventBase & Readonly<{ type: 'epochStarted'; epochId: string }>;

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
  Readonly<{ type: 'participantParticipationChanged'; participantId: string; active: boolean }>;

export type FairnessParticipantInactiveEvent = FairnessEventBase &
  Readonly<{ type: 'participantInactive'; participantId: string }>;

export type FairnessParticipantExclusionChangedEvent = FairnessEventBase &
  Readonly<{ type: 'participantExclusionChanged'; participantId: string; excluded: boolean }>;

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
    members: readonly FairnessMemberSnapshot[];
    entries: readonly FairnessDrawEntrySnapshot[];
  }>;

export type FairnessDrawConfirmedEvent = FairnessEventBase &
  Readonly<{ type: 'drawConfirmed'; drawId: string; winners: readonly FairnessWinnerSnapshot[] }>;

export type FairnessDrawFailedEvent = FairnessEventBase &
  Readonly<{ type: 'drawFailed'; drawId: string; reason: string }>;

export type FairnessDrawCancelledEvent = FairnessEventBase &
  Readonly<{ type: 'drawCancelled'; drawId: string; reason: string }>;

export type FairnessDrawVoidedEvent = FairnessEventBase &
  Readonly<{ type: 'drawVoided'; drawId: string; reason?: string }>;

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
  members: FairnessMemberSnapshot[];
  entries: FairnessDrawEntrySnapshot[];
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
  members: readonly FairnessMemberSnapshot[];
  entries: readonly FairnessDrawEntrySnapshot[];
  winners: readonly FairnessWinnerSnapshot[];
  entryCount: number;
  memberCount: number;
  /** Physical entry count retained under the old public field name. */
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

export type FairnessEntryPolicyInput = Readonly<{
  id: string;
  members: readonly FairnessPolicyInput[];
}>;

export type StrictBalanceEvaluation = Readonly<{
  minimumEffectiveBalance: number;
  eligibleIds: readonly string[];
  activeIncludedIds: readonly string[];
  activeExcludedIds: readonly string[];
}>;

export type StrictBalanceEntryEvaluation = Readonly<{
  eligibleEntryIds: readonly string[];
  activeEntryIds: readonly string[];
  ineligibleEntryIds: readonly string[];
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

  evaluateEntries(entries: readonly FairnessEntryPolicyInput[]): StrictBalanceEntryEvaluation {
    return evaluateStrictBalanceEntries(entries);
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

type RationalBalance = Readonly<{ sum: number; count: number }>;

function entryBalance(entry: FairnessEntryPolicyInput): RationalBalance | null {
  const includedMembers = entry.members.filter((member) => member.active && !member.excluded);
  if (includedMembers.length === 0) return null;
  return {
    sum: includedMembers.reduce((sum, member) => sum + member.effectiveBalance, 0),
    count: includedMembers.length,
  };
}

function compareRationalBalances(left: RationalBalance, right: RationalBalance): number {
  // Continued-fraction comparison is exact for safe integer numerators and
  // avoids overflowing a cross-product when balances become large.
  let leftNumerator = left.sum;
  let leftDenominator = left.count;
  let rightNumerator = right.sum;
  let rightDenominator = right.count;
  let inverted = false;
  while (true) {
    const leftWhole = Math.floor(leftNumerator / leftDenominator);
    const rightWhole = Math.floor(rightNumerator / rightDenominator);
    if (leftWhole !== rightWhole) {
      const result = leftWhole < rightWhole ? -1 : 1;
      return inverted ? -result : result;
    }
    const leftRemainder = leftNumerator % leftDenominator;
    const rightRemainder = rightNumerator % rightDenominator;
    if (leftRemainder === 0 || rightRemainder === 0) {
      if (leftRemainder === rightRemainder) return 0;
      const result = leftRemainder === 0 ? -1 : 1;
      return inverted ? -result : result;
    }
    leftNumerator = leftDenominator;
    leftDenominator = leftRemainder;
    rightNumerator = rightDenominator;
    rightDenominator = rightRemainder;
    inverted = !inverted;
  }
}

export function evaluateStrictBalanceEntries(
  entries: readonly FairnessEntryPolicyInput[]
): StrictBalanceEntryEvaluation {
  const activeEntries = entries.filter((entry) => entry.members.some((member) => member.active));
  const activeEntryIds = activeEntries.map((entry) => entry.id);
  const scoredEntries = activeEntries
    .map((entry) => ({ entry, balance: entryBalance(entry) }))
    .filter((candidate): candidate is { entry: FairnessEntryPolicyInput; balance: RationalBalance } =>
      Boolean(candidate.balance)
    );
  const ineligibleEntryIds = activeEntries.filter((entry) => !entryBalance(entry)).map((entry) => entry.id);
  if (scoredEntries.length === 0) return { eligibleEntryIds: [], activeEntryIds, ineligibleEntryIds };
  const minimum = scoredEntries.reduce(
    (current, candidate) => (compareRationalBalances(candidate.balance, current) < 0 ? candidate.balance : current),
    scoredEntries[0].balance
  );
  return {
    eligibleEntryIds: scoredEntries
      .filter((candidate) => compareRationalBalances(candidate.balance, minimum) === 0)
      .map(({ entry }) => entry.id),
    activeEntryIds,
    ineligibleEntryIds,
  };
}

export function canUseStrictBalanceFastPath(evaluation: StrictBalanceEvaluation): boolean {
  return (
    evaluation.activeIncludedIds.length > 0 &&
    evaluation.activeExcludedIds.length === 0 &&
    evaluation.eligibleIds.length === evaluation.activeIncludedIds.length
  );
}

export function canUseStrictBalanceEntryFastPath(evaluation: StrictBalanceEntryEvaluation): boolean {
  return (
    evaluation.activeEntryIds.length > 0 &&
    evaluation.ineligibleEntryIds.length === 0 &&
    evaluation.eligibleEntryIds.length === evaluation.activeEntryIds.length
  );
}

/** Finite candidate count for the strict policy. Keep this formula stable. */
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
  return winners.map((winner) => ({ ...winner, members: winner.members.map((member) => ({ ...member })) }));
}

function uniqueWinners(winners: readonly FairnessWinnerSnapshot[]): FairnessWinnerSnapshot[] {
  const seen = new Set<string>();
  return winners.filter((winner) => {
    if (seen.has(winner.entryId)) return false;
    seen.add(winner.entryId);
    return true;
  });
}

function applyConfirmedDraw(projection: FairnessProjection, event: FairnessDrawConfirmedEvent): void {
  const draw = projection.draws.find((candidate) => candidate.id === event.drawId);
  if (!draw || draw.status !== 'prepared') return;
  const epoch = projection.epochs.find((candidate) => candidate.id === draw.epochId);
  uniqueWinners(event.winners).forEach((winner) => {
    const entry = draw.entries.find((candidate) => candidate.entryId === winner.entryId);
    if (!entry) return;
    const countedMembers = new Set<string>();
    entry.memberIds.forEach((participantId) => {
      if (countedMembers.has(participantId)) return;
      countedMembers.add(participantId);
      const participant = getParticipant(projection, participantId);
      if (!participant) return;
      participant.actualWins += 1;
      const snapshot = draw.members.find((candidate) => candidate.participantId === participantId);
      if (!snapshot?.included || !epoch) return;
      participant.fairnessCountedWins += 1;
      epoch.balances[participantId] = getBalance(epoch, participantId) + 1;
      epoch.wins[participantId] = (epoch.wins[participantId] ?? 0) + 1;
    });
  });
  draw.winners = copyWinnerSnapshots(uniqueWinners(event.winners));
  draw.status = 'confirmed';
  draw.confirmedAt = event.timestamp;
}

function applyVoidedDraw(projection: FairnessProjection, event: FairnessDrawVoidedEvent): void {
  const draw = projection.draws.find((candidate) => candidate.id === event.drawId);
  if (!draw || draw.status === 'voided') return;
  if (draw.status === 'confirmed') {
    const epoch = projection.epochs.find((candidate) => candidate.id === draw.epochId);
    uniqueWinners(draw.winners).forEach((winner) => {
      const entry = draw.entries.find((candidate) => candidate.entryId === winner.entryId);
      if (!entry) return;
      const countedMembers = new Set<string>();
      entry.memberIds.forEach((participantId) => {
        if (countedMembers.has(participantId)) return;
        countedMembers.add(participantId);
        const participant = getParticipant(projection, participantId);
        if (participant) participant.actualWins = Math.max(0, participant.actualWins - 1);
        const snapshot = draw.members.find((candidate) => candidate.participantId === participantId);
        if (!participant || !snapshot?.included || !epoch) return;
        participant.fairnessCountedWins = Math.max(0, participant.fairnessCountedWins - 1);
        epoch.balances[participantId] = Math.max(0, getBalance(epoch, participantId) - 1);
        epoch.wins[participantId] = Math.max(0, (epoch.wins[participantId] ?? 0) - 1);
      });
    });
  }
  draw.status = 'voided';
  draw.voidedAt = event.timestamp;
}

function emptyProjection(): FairnessProjection {
  return { version: FAIRNESS_DATA_VERSION, participants: [], epochs: [], draws: [], currentEpochId: null };
}

type LegacyParticipantSnapshot = Readonly<{
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

function legacyEntryId(participantId: string): string {
  return `legacy-entry:${participantId}`;
}

function migrateLegacyEvent(value: Record<string, unknown>): FairnessEvent {
  if (value.version !== LEGACY_FAIRNESS_DATA_VERSION) invalid('unsupported event version');
  if (!isSafeString(value.eventId, 256)) invalid('eventId is invalid');
  if (!isFiniteNumber(value.timestamp) || value.timestamp < 0) invalid('timestamp is invalid');
  if (!isSafeString(value.type, 80)) invalid('event type is invalid');
  const base = { version: FAIRNESS_DATA_VERSION, eventId: value.eventId, timestamp: value.timestamp } as const;
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
      if (value.rawInput !== undefined && (typeof value.rawInput !== 'string' || value.rawInput.length > 1024))
        invalid('participant rename input is invalid');
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
      validateCommonDrawFields(value);
      if (!Array.isArray(value.participants) || value.participants.length === 0)
        invalid('draw participant snapshot is empty');
      const members: FairnessMemberSnapshot[] = [];
      const entries: FairnessDrawEntrySnapshot[] = [];
      (value.participants as unknown[]).forEach((candidate) => {
        if (!isRecord(candidate)) invalid('draw participant snapshot is invalid');
        const participant = candidate as Partial<LegacyParticipantSnapshot>;
        if (
          !isSafeString(participant.participantId, 256) ||
          !isSafeString(participant.displayName) ||
          typeof participant.rawInput !== 'string' ||
          participant.rawInput.length > 1024 ||
          !isFiniteNumber(participant.weight) ||
          participant.weight <= 0 ||
          !isSafeInteger(participant.count) ||
          participant.count <= 0 ||
          !Array.isArray(participant.marbleIds) ||
          !participant.marbleIds.every((id) => isSafeInteger(id) && id >= 0) ||
          typeof participant.active !== 'boolean' ||
          typeof participant.excluded !== 'boolean' ||
          typeof participant.included !== 'boolean' ||
          !isSafeInteger(participant.effectiveBalance) ||
          participant.effectiveBalance < 0 ||
          participant.included !== (participant.active && !participant.excluded) ||
          participant.marbleIds.length !== participant.count
        ) {
          invalid('draw participant snapshot is invalid');
        }
        members.push({
          participantId: participant.participantId,
          displayName: participant.displayName,
          active: participant.active,
          excluded: participant.excluded,
          included: participant.included,
          effectiveBalance: participant.effectiveBalance,
        });
        entries.push({
          entryId: legacyEntryId(participant.participantId),
          displayName: participant.displayName,
          rawInput: participant.rawInput,
          memberIds: [participant.participantId],
          weight: participant.weight,
          count: participant.count,
          marbleIds: [...participant.marbleIds],
        });
      });
      const totalCount = entries.reduce((total, entry) => total + entry.count, 0);
      const winnerRange = value.winnerRange as { start: number; end: number };
      const marbleIds = new Set<number>();
      entries.forEach((entry) => entry.marbleIds.forEach((marbleId) => marbleIds.add(marbleId)));
      if (
        !Number.isSafeInteger(totalCount) ||
        winnerRange.end >= totalCount ||
        marbleIds.size !== totalCount ||
        !Array.from({ length: totalCount }, (_, index) => index).every((index) => marbleIds.has(index))
      ) {
        invalid('draw marble mapping is invalid');
      }
      return {
        ...base,
        type: value.type,
        drawId: value.drawId as string,
        epochId: value.epochId as string,
        seed: value.seed as Seed,
        mapIndex: value.mapIndex as number,
        mapTitle: value.mapTitle as string,
        rawParticipantInputs: [...(value.rawParticipantInputs as string[])],
        winnerRange: { ...(value.winnerRange as { start: number; end: number }) },
        skillsEnabled: value.skillsEnabled as boolean,
        fairnessEnabledAtDraw: value.fairnessEnabledAtDraw as boolean,
        policy: getPolicyDescriptor(),
        members,
        entries,
      };
    }
    case 'drawConfirmed': {
      if (!Array.isArray(value.winners) || value.winners.length === 0) invalid('draw confirmation is invalid');
      const winners = (value.winners as unknown[]).map((candidate) => {
        if (typeof candidate === 'string') {
          if (!isSafeString(candidate, 256)) invalid('draw winner is invalid');
          return {
            entryId: legacyEntryId(candidate),
            entryDisplayName: candidate,
            members: [{ participantId: candidate, displayName: candidate }],
          };
        }
        if (!isRecord(candidate) || !isSafeString(candidate.participantId, 256) || !isSafeString(candidate.displayName))
          invalid('draw winner is invalid');
        if (candidate.marbleId !== undefined && (!isSafeInteger(candidate.marbleId) || candidate.marbleId < 0))
          invalid('draw winner marble is invalid');
        return {
          entryId: legacyEntryId(candidate.participantId),
          entryDisplayName: candidate.displayName,
          ...(candidate.marbleId === undefined ? {} : { marbleId: candidate.marbleId }),
          members: [{ participantId: candidate.participantId, displayName: candidate.displayName }],
        };
      });
      return { ...base, type: value.type, drawId: value.drawId as string, winners };
    }
    case 'drawFailed':
    case 'drawCancelled':
      if (!isSafeString(value.drawId, 256) || !isSafeString(value.reason, 2048)) invalid('draw failure is invalid');
      return { ...base, type: value.type, drawId: value.drawId, reason: value.reason };
    case 'drawVoided':
      if (!isSafeString(value.drawId, 256)) invalid('draw void is invalid');
      return {
        ...base,
        type: value.type,
        drawId: value.drawId,
        ...(value.reason === undefined ? {} : { reason: value.reason as string }),
      };
    default:
      invalid('unsupported event type');
  }
}

function normalizeEvent(event: FairnessEvent | unknown): FairnessEvent {
  if (!isRecord(event)) invalid('event must be an object');
  return event.version === LEGACY_FAIRNESS_DATA_VERSION ? migrateLegacyEvent(event) : (event as FairnessEvent);
}

export function projectFairnessEvents(events: readonly FairnessEvent[]): FairnessProjection {
  const projection = emptyProjection();
  events.forEach((rawEvent) => {
    const event = normalizeEvent(rawEvent);
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
        projection.participants.push({
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
        });
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
      case 'drawPrepared':
        if (!projection.draws.some((draw) => draw.id === event.drawId)) {
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
            members: event.members.map((member) => ({ ...member })),
            entries: event.entries.map((entry) => ({
              ...entry,
              memberIds: [...entry.memberIds],
              marbleIds: [...entry.marbleIds],
            })),
            winners: [],
          });
        }
        break;
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
      members: draw.members.map((member) => ({ ...member })),
      entries: draw.entries.map((entry) => ({
        ...entry,
        memberIds: [...entry.memberIds],
        marbleIds: [...entry.marbleIds],
      })),
      winners: copyWinnerSnapshots(draw.winners),
      entryCount: draw.entries.length,
      memberCount: draw.members.length,
      participantCount: draw.entries.length,
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

function validateMemberSnapshot(candidate: unknown): FairnessMemberSnapshot {
  if (!isRecord(candidate)) invalid('draw member snapshot is invalid');
  if (
    !isSafeString(candidate.participantId, 256) ||
    !isSafeString(candidate.displayName) ||
    typeof candidate.active !== 'boolean' ||
    typeof candidate.excluded !== 'boolean' ||
    typeof candidate.included !== 'boolean' ||
    !isSafeInteger(candidate.effectiveBalance) ||
    candidate.effectiveBalance < 0 ||
    candidate.included !== (candidate.active && !candidate.excluded)
  ) {
    invalid('draw member snapshot is invalid');
  }
  return {
    participantId: candidate.participantId,
    displayName: candidate.displayName,
    active: candidate.active,
    excluded: candidate.excluded,
    included: candidate.included,
    effectiveBalance: candidate.effectiveBalance,
  };
}

function validateEntrySnapshot(candidate: unknown, memberIds: Set<string>): FairnessDrawEntrySnapshot {
  if (!isRecord(candidate)) invalid('draw entry snapshot is invalid');
  if (
    !isSafeString(candidate.entryId, 256) ||
    !isSafeString(candidate.displayName) ||
    typeof candidate.rawInput !== 'string' ||
    candidate.rawInput.length > 1024 ||
    !Array.isArray(candidate.memberIds) ||
    candidate.memberIds.length === 0 ||
    !candidate.memberIds.every((id) => isSafeString(id, 256)) ||
    new Set(candidate.memberIds).size !== candidate.memberIds.length ||
    !candidate.memberIds.every((id) => memberIds.has(id)) ||
    !isFiniteNumber(candidate.weight) ||
    candidate.weight <= 0 ||
    !isSafeInteger(candidate.count) ||
    candidate.count <= 0 ||
    !Array.isArray(candidate.marbleIds) ||
    candidate.marbleIds.length !== candidate.count ||
    !candidate.marbleIds.every((id) => isSafeInteger(id) && id >= 0)
  ) {
    invalid('draw entry snapshot is invalid');
  }
  return {
    entryId: candidate.entryId,
    displayName: candidate.displayName,
    rawInput: candidate.rawInput,
    memberIds: [...candidate.memberIds],
    weight: candidate.weight,
    count: candidate.count,
    marbleIds: [...candidate.marbleIds],
  };
}

function validateCommonDrawFields(value: Record<string, unknown>): void {
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
    value.policy.version !== STRICT_BALANCE_POLICY_VERSION
  ) {
    invalid('draw preparation is invalid');
  }
}

export function validateFairnessEvent(value: unknown): FairnessEvent {
  if (!isRecord(value)) invalid('event must be an object');
  if (value.version === LEGACY_FAIRNESS_DATA_VERSION) return validateFairnessEvent(migrateLegacyEvent(value));
  if (value.version !== FAIRNESS_DATA_VERSION) invalid('unsupported event version');
  if (!isSafeString(value.eventId, 256)) invalid('eventId is invalid');
  if (!isFiniteNumber(value.timestamp) || value.timestamp < 0) invalid('timestamp is invalid');
  if (!isSafeString(value.type, 80)) invalid('event type is invalid');
  const base = { version: FAIRNESS_DATA_VERSION, eventId: value.eventId, timestamp: value.timestamp } as const;
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
      if (value.rawInput !== undefined && (typeof value.rawInput !== 'string' || value.rawInput.length > 1024))
        invalid('participant rename input is invalid');
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
      validateCommonDrawFields(value);
      if (!Array.isArray(value.members) || value.members.length === 0 || !Array.isArray(value.entries))
        invalid('draw preparation is invalid');
      const members = value.members.map(validateMemberSnapshot);
      const memberIds = new Set(members.map((member) => member.participantId));
      if (memberIds.size !== members.length) invalid('draw member snapshot must be unique');
      const entries = value.entries.map((entry) => validateEntrySnapshot(entry, memberIds));
      if (entries.length === 0 || new Set(entries.map((entry) => entry.entryId)).size !== entries.length)
        invalid('draw entry snapshot must be unique');
      const seenMemberIds = new Set<string>();
      entries.forEach((entry) =>
        entry.memberIds.forEach((memberId) => {
          if (seenMemberIds.has(memberId)) invalid('draw member appears in multiple entries');
          seenMemberIds.add(memberId);
        })
      );
      const marbleIds = new Set<number>();
      const totalCount = entries.reduce((total, entry) => total + entry.count, 0);
      entries.forEach((entry) =>
        entry.marbleIds.forEach((marbleId) => {
          if (marbleIds.has(marbleId)) invalid('draw marble mapping is not unique');
          marbleIds.add(marbleId);
        })
      );
      if (
        !Number.isSafeInteger(totalCount) ||
        marbleIds.size !== totalCount ||
        !Array.from({ length: totalCount }, (_, index) => index).every((index) => marbleIds.has(index)) ||
        (value.winnerRange as { end: number }).end >= totalCount
      ) {
        invalid('draw marble mapping is invalid');
      }
      const drawId = value.drawId as string;
      const epochId = value.epochId as string;
      const seed = value.seed as Seed;
      const mapIndex = value.mapIndex as number;
      const mapTitle = value.mapTitle as string;
      const rawParticipantInputs = value.rawParticipantInputs as string[];
      const winnerRange = value.winnerRange as { start: number; end: number };
      return {
        ...base,
        type: value.type,
        drawId,
        epochId,
        seed,
        mapIndex,
        mapTitle,
        rawParticipantInputs: [...rawParticipantInputs],
        winnerRange: { start: winnerRange.start, end: winnerRange.end },
        skillsEnabled: value.skillsEnabled as boolean,
        fairnessEnabledAtDraw: value.fairnessEnabledAtDraw as boolean,
        policy: getPolicyDescriptor(),
        members,
        entries,
      };
    }
    case 'drawConfirmed': {
      if (!isSafeString(value.drawId, 256) || !Array.isArray(value.winners) || value.winners.length === 0)
        invalid('draw confirmation is invalid');
      const winners = value.winners.map((candidate) => {
        if (!isRecord(candidate) || !isSafeString(candidate.entryId, 256) || !isSafeString(candidate.entryDisplayName))
          invalid('draw winner is invalid');
        if (candidate.marbleId !== undefined && (!isSafeInteger(candidate.marbleId) || candidate.marbleId < 0))
          invalid('draw winner marble is invalid');
        if (!Array.isArray(candidate.members) || candidate.members.length === 0)
          invalid('draw winner members are invalid');
        const members = candidate.members.map((member) => {
          if (!isRecord(member) || !isSafeString(member.participantId, 256) || !isSafeString(member.displayName))
            invalid('draw winner member is invalid');
          return { participantId: member.participantId, displayName: member.displayName };
        });
        if (new Set(members.map((member) => member.participantId)).size !== members.length)
          invalid('draw winner members must be unique');
        return {
          entryId: candidate.entryId,
          entryDisplayName: candidate.entryDisplayName,
          ...(candidate.marbleId === undefined ? {} : { marbleId: candidate.marbleId }),
          members,
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
  if (value.version !== LEGACY_FAIRNESS_DATA_VERSION && value.version !== FAIRNESS_DATA_VERSION)
    invalid('unsupported export version');
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
  const draws = new Map<string, FairnessDrawStatus>();
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
      case 'drawPrepared':
        if (!epochs.has(event.epochId)) invalid('draw references an unknown epoch');
        if (draws.has(event.drawId)) invalid('drawId must be unique');
        event.members.forEach((member) => {
          if (!participants.has(member.participantId)) invalid('draw references an unknown participant');
        });
        draws.set(event.drawId, 'prepared');
        break;
      case 'drawConfirmed': {
        if (draws.get(event.drawId) !== 'prepared') invalid('draw confirmation references a non-prepared draw');
        const prepared = events.find(
          (candidate): candidate is FairnessDrawPreparedEvent =>
            candidate.type === 'drawPrepared' && candidate.drawId === event.drawId
        );
        if (!prepared) invalid('draw confirmation references a missing preparation');
        event.winners.forEach((winner) => {
          const entry = prepared.entries.find((candidate) => candidate.entryId === winner.entryId);
          if (!entry) invalid('draw winner is not in the prepared entry snapshot');
          if (winner.entryDisplayName !== entry.displayName) invalid('draw winner entry snapshot is inconsistent');
          if (winner.marbleId !== undefined && !entry.marbleIds.includes(winner.marbleId))
            invalid('draw winner marble is not in the prepared participant snapshot');
          const winnerMemberIds = winner.members.map((member) => member.participantId);
          if (
            winnerMemberIds.length !== entry.memberIds.length ||
            winnerMemberIds.some((participantId) => !entry.memberIds.includes(participantId))
          ) {
            invalid('draw winner member snapshot is inconsistent');
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
      case 'drawVoided':
        if (draws.get(event.drawId) !== 'confirmed') invalid('only confirmed draws can be voided');
        draws.set(event.drawId, 'voided');
        break;
    }
  }
}

export function createFairnessExport(events: readonly FairnessEvent[], mode: FairnessMode): FairnessExport {
  return validateFairnessExport({ version: FAIRNESS_DATA_VERSION, mode, events: copyJson(events) });
}
