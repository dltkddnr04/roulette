import type { StageDef } from './data/maps';
import {
  applyFairnessEvent,
  canUseStrictBalanceEntryFastPath,
  createFairnessCandidateSeed,
  createFairnessExport,
  createFairnessId,
  createFairnessState,
  evaluateStrictBalanceEntries,
  FAIRNESS_DATA_VERSION,
  FAIRNESS_SIMULATION_RULESET_VERSION,
  type FairnessProfile,
  type FairnessDrawCancelledEvent,
  type FairnessDrawEntrySnapshot,
  type FairnessDrawPreparedEvent,
  type FairnessEvent,
  type FairnessExport,
  type FairnessMemberSnapshot,
  type FairnessMode,
  type FairnessProjection,
  type FairnessState,
  type FairnessWinnerSnapshot,
  projectFairnessEvents,
  STRICT_BALANCE_POLICY_ID,
  STRICT_BALANCE_POLICY_VERSION,
  searchBudget,
  validateFairnessEvent,
  validateFairnessExport,
} from './fairness';
import {
  type FairnessEventStore,
  type FairnessHistoryStamp,
  type FairnessReservationIdentity,
  type FairnessReservationRecord,
  type FairnessReservationTerminalEvent,
  IndexedDbFairnessStore,
  DEFAULT_FAIRNESS_PROFILE_ID,
  DEFAULT_FAIRNESS_PROFILE_NAME,
} from './fairnessStore';
import type { FairnessWorkerPlan, FairnessWorkerPoolLike } from './fairnessWorkerPool';
import {
  DEFAULT_HEADLESS_STEP_LIMIT,
  HeadlessSimulationCancelledError,
  type HeadlessSimulationOptions,
  type HeadlessSimulationRequest,
  mapMarbleIdsToLabels,
  simulateHeadlessRace,
} from './headlessSimulation';
import type { MarbleParticipant } from './raceSimulation';
import { MAX_MARBLES } from './roundSession';
import { getMarbleSpawnLayout } from './utils/marbleSpawn';
import { getSimulationParticipantSetup } from './utils/participants';
import type { Seed } from './utils/random';
import { readLocalStorage, readSessionStorage, writeLocalStorage, writeSessionStorage } from './utils/storage';
import { parseName } from './utils/utils';

const FAIRNESS_ENABLED_STORAGE_KEY = 'mbr_fairness_enabled';
const FAIRNESS_MODE_STORAGE_KEY = 'mbr_fairness_mode';
// Profile data is shared through IndexedDB, but selection is document-local so
// changing profiles in one tab cannot retarget another tab's active draw.
const FAIRNESS_ACTIVE_PROFILE_STORAGE_KEY = 'mbr_fairness_active_profile';
const FAIRNESS_ACTIVE_DRAW_LOCK_NAME = 'marble-roulette-fairness-active-draw-v1';
const FAIRNESS_STATE_CHANGE_CHANNEL_NAME = 'marble-roulette-fairness-state-v1';
const FAIRNESS_STATE_CHANGE_STORAGE_KEY = 'mbr_fairness_state_change';

const DEFAULT_RECENT_ERROR = 'Fairness is unavailable';

export type FairnessStartRequest = Readonly<{
  stage: StageDef;
  mapIndex: number;
  participantInputs: readonly string[];
  winnerRange: Readonly<{ start: number; end: number }>;
  skillsEnabled: boolean;
  currentSeed: Seed;
  /** Seed reserved for the next logical round; excluded from policy identity. */
  nextRoundSeed?: Seed;
  /** Allow the first post-reload bootstrap to recover a persisted strict-path seed. */
  allowPersistedReservationSeed?: boolean;
}>;

export type FairnessHeadlessSearchRequest = HeadlessSimulationRequest;

export type FairnessHeadlessRunnerOptions = Readonly<Pick<HeadlessSimulationOptions, 'signal'>>;

export type FairnessHeadlessRunner = (
  request: FairnessHeadlessSearchRequest,
  options?: FairnessHeadlessRunnerOptions
) => Promise<readonly number[]>;

export type FairnessPrecomputedPlan = Readonly<{
  key: string;
  generation: number;
  seed: Seed;
  reservationId?: string;
}>;

export type FairnessPreparedDraw = Readonly<{
  drawId: string;
  key: string;
  generation: number;
  reservationId?: string;
  seed: Seed;
  event: FairnessDrawPreparedEvent;
  expectedWinnerEntryIds: readonly string[] | null;
  /** Kept for singleton-entry callers; grouped draws use entry IDs. */
  expectedWinnerParticipantIds: readonly string[] | null;
  expectedWinnerMarbleIds: readonly number[] | null;
  operationToken: number;
}>;

export type FairnessPrepareDrawOptions = Readonly<{
  /** Internal Start path only: do not clone the event that the coordinator owns. */
  includeEvent?: boolean;
}>;

export type FairnessConfirmationResult = Readonly<{
  confirmed: boolean;
  reason?: string;
}>;

export type FairnessDiagnostic = Readonly<{
  phase: string;
  at: number;
  details?: Readonly<Record<string, unknown>>;
}>;

type FairnessStateChange = Readonly<{
  external: boolean;
  foreignActiveDraw: boolean;
  autoPrecompute: boolean;
}>;

export type FairnessCoordinatorOptions = Readonly<{
  store?: FairnessEventStore;
  headlessRunner?: FairnessHeadlessRunner;
  workerPool?: FairnessWorkerPoolLike;
  now?: () => number;
  createId?: (prefix: string) => string;
  createCandidateSeed?: () => Seed;
  headlessStepLimit?: number;
  onDiagnostic?: (diagnostic: FairnessDiagnostic) => void;
}>;

type SyncedEntry = Readonly<{
  entryId: string;
  memberIds: readonly string[];
  rawInput: string;
  displayName: string;
  weight: number;
  count: number;
}>;

type SearchResult = Readonly<{
  seed: Seed;
  winnerMarbleIds: readonly number[];
  winnerEntryIds: readonly string[];
}>;

type PreparedDrawDraft = Readonly<
  Omit<FairnessDrawPreparedEvent, 'version' | 'eventId' | 'timestamp' | 'type' | 'drawId'>
>;

type PreparedDrawDraftCache = Readonly<{
  key: string;
  generation: number;
  seed: Seed;
  draft: PreparedDrawDraft;
}>;

type FairnessSearchContext = Readonly<{
  request: FairnessStartRequest;
  syncedInputs: readonly SyncedEntry[];
  participants: readonly MarbleParticipant[];
  totalCount: number;
  spawnPositions: readonly { x: number; y: number }[];
  mappingRows: readonly Readonly<{ entryId: string; count: number }>[];
  eligibleEntryIds: readonly string[];
  budget: number;
  key: string;
  /** Legacy unscoped key accepted only for the migrated default profile. */
  legacyKey?: string;
  planId: string;
  generation: number;
  mustSearch: boolean;
}>;

type SearchCandidate = SearchResult &
  Readonly<{
    key: string;
    generation: number;
    draft: PreparedDrawDraft;
  }>;

type DurableFairnessReservation = FairnessReservationRecord &
  Readonly<{
    draft: PreparedDrawDraft;
  }>;

type ClaimedFairnessReservation = {
  reservationId: string;
  identity: FairnessReservationIdentity;
  event: FairnessDrawPreparedEvent;
  persisted: boolean;
  ownership?: FairnessDrawOwnership;
};

type FairnessDrawOwnership = {
  release: () => void;
  released: Promise<void>;
  isActive: () => boolean;
};

type FairnessDrawLockManager = {
  request: (
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: object | null) => Promise<void>
  ) => Promise<unknown>;
};

type FairnessDrawLockResult =
  | { status: 'acquired'; ownership: FairnessDrawOwnership }
  | { status: 'busy' | 'unsupported' | 'error'; error?: unknown };

type RecoveryReservation = Readonly<{
  reservation: DurableFairnessReservation;
  preparedEvent: FairnessDrawPreparedEvent | null;
}>;

type CompletedSearchAttempt = Readonly<{
  seed: Seed;
  winnerMarbleIds?: readonly number[];
  error?: unknown;
}>;

type SearchWork = Readonly<{
  key: string;
  generation: number;
  controller: AbortController;
  promise: Promise<SearchCandidate>;
}>;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSearchRequest(left: FairnessStartRequest, right: FairnessStartRequest): boolean {
  return (
    left.stage === right.stage &&
    left.mapIndex === right.mapIndex &&
    sameStrings(left.participantInputs, right.participantInputs) &&
    left.winnerRange.start === right.winnerRange.start &&
    left.winnerRange.end === right.winnerRange.end &&
    left.skillsEnabled === right.skillsEnabled
  );
}

function getRequestedRoundSeed(request: FairnessStartRequest): Seed {
  return request.nextRoundSeed ?? request.currentSeed;
}

function getReservationIdentity(reservation: FairnessReservationRecord): FairnessReservationIdentity {
  return {
    profileId: reservation.profileId,
    reservationId: reservation.reservationId,
    drawId: reservation.drawId,
    key: reservation.key,
    seed: reservation.seed,
    rulesetVersion: reservation.rulesetVersion,
  };
}

function sameReservationIdentityValues(
  left: FairnessReservationRecord,
  right: FairnessReservationRecord
): boolean {
  return (
    left.profileId === right.profileId &&
    left.reservationId === right.reservationId &&
    left.drawId === right.drawId &&
    left.key === right.key &&
    left.seed === right.seed &&
    left.rulesetVersion === right.rulesetVersion
  );
}

function acquireFairnessDrawLock(): Promise<FairnessDrawLockResult> {
  // The coordinator is also exercised by the Node-based pure logic harness,
  // where there is no document to coordinate with. Keep that environment
  // local while requiring the origin lock in real browser documents.
  if (typeof window === 'undefined') {
    let released = false;
    return Promise.resolve({
      status: 'acquired',
      ownership: {
        release: () => {
          released = true;
        },
        released: Promise.resolve(),
        isActive: () => !released,
      },
    });
  }
  if (typeof navigator === 'undefined') return Promise.resolve({ status: 'unsupported' });
  const lockManager = (navigator as Navigator & { locks?: FairnessDrawLockManager }).locks;
  if (!lockManager) return Promise.resolve({ status: 'unsupported' });

  return new Promise<FairnessDrawLockResult>((resolve) => {
    let settled = false;
    let releaseRequested = false;
    let resolveReleaseRequested: () => void = () => {};
    let resolveReleased: () => void = () => {};
    const releaseRequestedPromise = new Promise<void>((resolveRequest) => {
      resolveReleaseRequested = resolveRequest;
    });
    const releasedPromise = new Promise<void>((resolveComplete) => {
      resolveReleased = resolveComplete;
    });
    const ownership: FairnessDrawOwnership = {
      release: () => {
        if (releaseRequested) return;
        releaseRequested = true;
        resolveReleaseRequested();
      },
      released: releasedPromise,
      isActive: () => !releaseRequested,
    };
    const settle = (result: FairnessDrawLockResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let request: Promise<unknown>;
    try {
      request = lockManager.request(
        FAIRNESS_ACTIVE_DRAW_LOCK_NAME,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (!lock) {
            settle({ status: 'busy' });
            return;
          }
          settle({ status: 'acquired', ownership });
          // Resolving the inner promise only lets the callback return. The
          // browser releases the actual Web Lock after this callback returns;
          // callers await ownership.released for that outer completion.
          await releaseRequestedPromise;
        }
      );
    } catch (error) {
      settle({ status: 'error', error });
      return;
    }
    void request.then(
      () => {
        if (!settled) settle({ status: 'busy' });
        resolveReleased();
      },
      (error: unknown) => {
        if (!settled) settle({ status: 'error', error });
        else ownership.release();
        resolveReleased();
      }
    );
  });
}

function supportsFairnessDrawLock(): boolean {
  if (typeof window === 'undefined') return true;
  if (typeof navigator === 'undefined') return false;
  return Boolean((navigator as Navigator & { locks?: FairnessDrawLockManager }).locks);
}

const FAIRNESS_PRECOMPUTE_DEBOUNCE_MS = 150;

export class FairnessCancelledError extends Error {
  constructor() {
    super('Fairness start was cancelled');
    this.name = 'FairnessCancelledError';
  }
}

export class FairnessStateBusyError extends FairnessCancelledError {
  constructor() {
    super();
    this.message = 'Another Fairness operation is active in another tab';
    this.name = 'FairnessStateBusyError';
  }
}

export class FairnessStaleStateError extends FairnessCancelledError {
  constructor() {
    super();
    this.message = 'Fairness state changed in another tab';
    this.name = 'FairnessStaleStateError';
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getHistoryFingerprint(events: readonly FairnessEvent[]): string {
  // The serialized event body also detects import/replace of an event with a
  // reused ID. This is a cache freshness token, never a policy input.
  return JSON.stringify(events);
}

function sameHistoryStamp(left: FairnessHistoryStamp | null, right: FairnessHistoryStamp | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.revision === right.revision &&
    left.eventCount === right.eventCount &&
    left.tailEventId === right.tailEventId
  );
}

function isPreparedDrawDraft(value: unknown): value is PreparedDrawDraft {
  if (!value || typeof value !== 'object') return false;
  try {
    validateFairnessEvent({
      ...(value as Record<string, unknown>),
      version: FAIRNESS_DATA_VERSION,
      eventId: 'reservation-validation',
      timestamp: 0,
      type: 'drawPrepared',
      drawId: 'reservation-validation',
    });
    return true;
  } catch {
    return false;
  }
}

function createFairnessSearchKey(
  request: FairnessStartRequest,
  profileId: string | undefined,
  participants: readonly MarbleParticipant[],
  syncedInputs: readonly SyncedEntry[],
  projection: FairnessProjection,
  eligibleEntryIds: readonly string[],
  budget: number,
  headlessStepLimit: number
): string {
  return JSON.stringify({
    ...(profileId === undefined ? {} : { profileId }),
    mapIndex: request.mapIndex,
    stage: request.stage,
    participantInputs: request.participantInputs,
    participants,
    winnerRange: request.winnerRange,
    skillsEnabled: request.skillsEnabled,
    epochId: projection.currentEpochId,
    members: projection.participants.map((participant) => ({
      id: participant.id,
      displayName: participant.displayName,
      active: participant.active,
      excluded: participant.excluded,
      effectiveBalance: participant.effectiveBalance,
      previousEffectiveBalance: participant.previousEffectiveBalance,
    })),
    entries: syncedInputs.map((entry) => ({
      entryId: entry.entryId,
      memberIds: entry.memberIds,
      rawInput: entry.rawInput,
      displayName: entry.displayName,
      weight: entry.weight,
      count: entry.count,
    })),
    eligibleEntryIds,
    policy: {
      id: STRICT_BALANCE_POLICY_ID,
      version: STRICT_BALANCE_POLICY_VERSION,
    },
    simulationRulesetVersion: FAIRNESS_SIMULATION_RULESET_VERSION,
    budget,
    headlessStepLimit,
  });
}

function getErrorMessage(error: unknown, fallback = DEFAULT_RECENT_ERROR): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isCancellationError(error: unknown): boolean {
  return (
    error instanceof FairnessCancelledError ||
    error instanceof HeadlessSimulationCancelledError ||
    (error instanceof Error && error.name === 'HeadlessSimulationCancelledError')
  );
}

function isWorkerPoolUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.name === 'WorkerPoolUnavailableError';
}

function isFairnessInputError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.startsWith('Fairness group') || error.message.startsWith('Fairness member');
}

function isFairnessMode(value: unknown): value is FairnessMode {
  return value === 'simple' || value === 'complete';
}

function normalizeProfileName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 256) throw new Error('Fairness profile name is invalid');
  return name;
}

function profileNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function hasProfileName(profiles: readonly FairnessProfile[], name: string, exceptId?: string): boolean {
  const key = profileNameKey(name);
  return profiles.some((profile) => profile.id !== exceptId && profileNameKey(profile.name) === key);
}

function uniqueImportedProfileName(profiles: readonly FairnessProfile[], requestedName: string): string {
  const normalized = normalizeProfileName(requestedName);
  if (!hasProfileName(profiles, normalized)) return normalized;
  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const suffixText = ` (${suffix})`;
    const base = normalized.slice(0, 256 - suffixText.length).trim();
    const candidate = `${base}${suffixText}`;
    if (!hasProfileName(profiles, candidate)) return candidate;
  }
  throw new Error('Fairness profile name is already in use');
}

function participantNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function profileOrder(left: FairnessProfile, right: FairnessProfile): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function collectManualRenameBindings(events: readonly FairnessEvent[]): Map<string, string> {
  const bindings = new Map<string, string>();
  events.forEach((event) => {
    if (event.type === 'participantRenamed' && event.rawInput !== undefined) {
      bindings.set(event.participantId, event.rawInput);
    }
  });
  return bindings;
}

function createBaseEvent<T extends FairnessEvent['type']>(
  type: T,
  now: () => number,
  createId: (prefix: string) => string
): Pick<FairnessEvent, 'version' | 'eventId' | 'timestamp' | 'type'> & { type: T } {
  return {
    version: FAIRNESS_DATA_VERSION,
    eventId: createId('event'),
    timestamp: now(),
    type,
  } as Pick<FairnessEvent, 'version' | 'eventId' | 'timestamp' | 'type'> & { type: T };
}

export function parseFairnessEntryName(name: string): string[] | null {
  const members: string[] = [];
  let current = '';
  for (let index = 0; index < name.length; index++) {
    const character = name[index];
    if (character === '\\' && name[index + 1] === '+') {
      current += '+';
      index++;
    } else if (character === '+') {
      const member = current.trim();
      if (!member) return null;
      members.push(member);
      current = '';
    } else {
      current += character;
    }
  }
  const member = current.trim();
  if (!member) return null;
  members.push(member);
  return members;
}

type ParsedFairnessEntry = Readonly<{
  rawInput: string;
  displayName: string;
  memberNames: string[];
  weight: number;
  count: number;
}>;

function parseFairnessEntries(inputs: readonly string[], parseGroups: boolean): ParsedFairnessEntry[] {
  const rows: ParsedFairnessEntry[] = [];
  const memberNames = new Set<string>();
  inputs.forEach((rawInput) => {
    const parsed = parseName(rawInput);
    if (!parsed) return;
    const names = parseGroups ? parseFairnessEntryName(parsed.name) : [parsed.name];
    if (!names) throw new Error('Fairness group contains an empty member');
    names.forEach((name) => {
      if (memberNames.has(name)) throw new Error('Fairness member cannot appear in multiple draw entries');
      memberNames.add(name);
    });
    rows.push({ rawInput, displayName: parsed.name, memberNames: names, weight: parsed.weight, count: parsed.count });
  });
  return rows;
}

function mapWinnerMarbles(
  winnerMarbleIds: readonly number[],
  entries: readonly FairnessDrawEntrySnapshot[],
  members: readonly FairnessMemberSnapshot[]
): FairnessWinnerSnapshot[] | null {
  const winners: FairnessWinnerSnapshot[] = [];
  const seen = new Set<string>();
  for (const marbleId of winnerMarbleIds) {
    const entry = entries.find((candidate) => candidate.marbleIds.includes(marbleId));
    if (!entry) return null;
    if (seen.has(entry.entryId)) continue;
    seen.add(entry.entryId);
    const winnerMembers = entry.memberIds.map((memberId) => {
      const member = members.find((candidate) => candidate.participantId === memberId);
      return member ? { participantId: member.participantId, displayName: member.displayName } : null;
    });
    if (winnerMembers.some((member) => member === null)) return null;
    winners.push({
      entryId: entry.entryId,
      entryDisplayName: entry.displayName,
      marbleId,
      members: winnerMembers.filter(
        (member): member is { participantId: string; displayName: string } => member !== null
      ),
    });
  }
  return winners;
}

export function mapMarbleIdsToParticipants(
  seed: Seed,
  participants: readonly Readonly<{ participantId: string; count: number }>[]
): Map<number, string> {
  return mapMarbleIdsToLabels(
    seed,
    participants.map((participant) => ({ label: participant.participantId, count: participant.count }))
  );
}

export function mapMarbleIdsToEntries(
  seed: Seed,
  entries: readonly Readonly<{ entryId: string; count: number }>[]
): Map<number, string> {
  return mapMarbleIdsToParticipants(
    seed,
    entries.map((entry) => ({ participantId: entry.entryId, count: entry.count }))
  );
}

export async function runHeadlessRace(
  request: FairnessHeadlessSearchRequest,
  stepLimit = DEFAULT_HEADLESS_STEP_LIMIT,
  options: FairnessHeadlessRunnerOptions = {}
): Promise<readonly number[]> {
  const result = await simulateHeadlessRace(request, { stepLimit, signal: options.signal });
  return result.finishedMarbleIds;
}

async function yieldToHost(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, 0);
    else resolve();
  });
}

export class FairnessCoordinator {
  private readonly store: FairnessEventStore;
  private readonly headlessRunner: FairnessHeadlessRunner;
  private readonly now: () => number;
  private readonly createId: (prefix: string) => string;
  private readonly createCandidateSeed: () => Seed;
  private readonly headlessStepLimit: number;
  private readonly onDiagnostic: ((diagnostic: FairnessDiagnostic) => void) | null;
  private readonly useWorkerPool: boolean;
  private readonly configuredWorkerPool: FairnessWorkerPoolLike | null;
  private readonly hasInjectedHeadlessRunner: boolean;
  private readonly stateChangeListeners = new Set<(change: FairnessStateChange) => void>();
  private readonly stateChangeChannel: BroadcastChannel | null;
  private stateChangeSequence = 0;
  private externalStateRefresh: Promise<void> | null = null;
  private externalStateRefreshPending = false;
  private durableChangeNotificationPending = false;
  private recoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private foreignActiveDraw = false;

  private events: FairnessEvent[] = [];
  private projection: FairnessProjection = projectFairnessEvents([]);
  private currentInputs: string[] = [];
  private participantInputsDirty = false;
  private boundInputs: string[] = [];
  private inputBindings: Array<readonly string[] | null> = [];
  private manualRenames = new Map<string, string>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private durableMutationQueue: Promise<void> = Promise.resolve();
  private durableMutationActive = false;
  private pendingExclusionRequests = new Map<string, boolean>();
  private pendingRenameRequests = new Map<string, string>();
  private loadingPromise: Promise<void> | null = null;
  private loaded = false;
  private historyFingerprint = getHistoryFingerprint([]);
  private historyStamp: FairnessHistoryStamp | null = null;
  private available = false;
  private enabled: boolean;
  private mode: FairnessMode;
  private profiles: FairnessProfile[] = [];
  private activeProfileId: string;
  private error: string | null = null;
  private operationToken = 0;
  private searchGeneration = 0;
  private cachedCandidate: SearchCandidate | null = null;
  private cachedPreparedDraft: PreparedDrawDraftCache | null = null;
  private cachedContext: FairnessSearchContext | null = null;
  private inFlightSearch: SearchWork | null = null;
  private readonly durableReservations = new Map<string, DurableFairnessReservation>();
  private readonly claimedReservations = new Map<string, ClaimedFairnessReservation>();
  private readonly reservationWrites = new Map<string, Promise<DurableFairnessReservation>>();
  private workerPoolPromise: Promise<FairnessWorkerPoolLike | null> | null = null;
  private workerPoolDisabled = false;
  private precomputeTimer: ReturnType<typeof setTimeout> | null = null;
  private precomputeTimerResolve: ((plan: FairnessPrecomputedPlan | null) => void) | null = null;

  constructor(options: FairnessCoordinatorOptions = {}) {
    this.store = options.store ?? new IndexedDbFairnessStore();
    this.configuredWorkerPool = options.workerPool ?? null;
    this.hasInjectedHeadlessRunner = options.headlessRunner !== undefined;
    this.useWorkerPool = this.configuredWorkerPool !== null || !options.headlessRunner;
    this.headlessRunner =
      options.headlessRunner ?? ((request, runnerOptions) => this.runProductionHeadless(request, runnerOptions));
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? createFairnessId;
    this.createCandidateSeed = options.createCandidateSeed ?? createFairnessCandidateSeed;
    this.headlessStepLimit = options.headlessStepLimit ?? DEFAULT_HEADLESS_STEP_LIMIT;
    this.onDiagnostic = options.onDiagnostic ?? null;
    this.enabled = readLocalStorage(FAIRNESS_ENABLED_STORAGE_KEY) === 'true';
    const savedMode = readLocalStorage(FAIRNESS_MODE_STORAGE_KEY);
    this.mode = isFairnessMode(savedMode) ? savedMode : 'simple';
    this.activeProfileId = readSessionStorage(FAIRNESS_ACTIVE_PROFILE_STORAGE_KEY) ?? DEFAULT_FAIRNESS_PROFILE_ID;

    let stateChangeChannel: BroadcastChannel | null = null;
    if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
      try {
        stateChangeChannel = new BroadcastChannel(FAIRNESS_STATE_CHANGE_CHANNEL_NAME);
        stateChangeChannel.addEventListener('message', this.handleExternalStateChange);
      } catch {
        stateChangeChannel = null;
      }
    }
    this.stateChangeChannel = stateChangeChannel;
    if (!stateChangeChannel && typeof window !== 'undefined') {
      window.addEventListener('storage', this.handleExternalStateChange);
    }
  }

  private readonly handleExternalStateChange = (): void => {
    if (!this.loaded) return;
    if (this.externalStateRefresh) {
      this.externalStateRefreshPending = true;
      return;
    }
    const previousForeignActiveDraw = this.foreignActiveDraw;
    this.externalStateRefresh = (async () => {
      const historyChanged = await this.refreshDurableHistoryIfStale();
      const reservationsChanged = await this.refreshDurableReservations();
      const profilesChanged = await this.refreshProfiles();
      const foreignActiveDrawChanged = previousForeignActiveDraw !== this.foreignActiveDraw;
      if (!historyChanged && !reservationsChanged && !profilesChanged && !foreignActiveDrawChanged) return;

      // Only a tab whose local inputs still describe the refreshed durable
      // roster may speculate on the next Fairness plan. A divergent tab must
      // keep its newer local inputs untouched and wait for its next local
      // input-driven synchronization. A locally edited snapshot is an
      // explicit exception: its earlier sync may have lost a lock race, so
      // retry it once the foreign draw no longer owns the origin.
      const autoPrecompute =
        !this.foreignActiveDraw &&
        (this.participantInputsDirty || this.currentInputsMatchKnownParticipants());
      this.notifyStateChanged(false, true, autoPrecompute);
    })()
      .catch((error) => {
        if (!isCancellationError(error)) this.markUnavailable(error);
      })
      .finally(() => {
        this.externalStateRefresh = null;
        if (this.externalStateRefreshPending) {
          this.externalStateRefreshPending = false;
          this.handleExternalStateChange();
        }
      });
  };

  addStateChangeListener(listener: (change: FairnessStateChange) => void): () => void {
    this.stateChangeListeners.add(listener);
    return () => this.stateChangeListeners.delete(listener);
  }

  private notifyStateChanged(broadcast = true, external = false, autoPrecompute = true): void {
    this.stateChangeSequence += 1;
    for (const listener of this.stateChangeListeners) {
      listener({ external, foreignActiveDraw: this.foreignActiveDraw, autoPrecompute });
    }
    if (!broadcast) return;
    this.broadcastStateChanged();
  }

  /**
   * Publish a private control-plane transition to peer documents without
   * turning it into a public same-document state refresh. Reservations are
   * shared through this channel, but they are not user-visible Fairness
   * projection mutations.
   */
  private broadcastStateChanged(): void {
    if (this.stateChangeChannel) {
      try {
        this.stateChangeChannel.postMessage({ type: 'fairness-state-changed' });
      } catch {
        // A closed/unsupported channel is only an optimization. The durable
        // store remains the source of truth for the next operation.
      }
      return;
    }
    writeLocalStorage(FAIRNESS_STATE_CHANGE_STORAGE_KEY, `${this.now()}:${this.createId('state')}`);
  }

  private markDurableStateChanged(): void {
    if (this.durableMutationActive || this.hasOwnedFairnessDraw()) {
      this.durableChangeNotificationPending = true;
      return;
    }
    this.notifyStateChanged();
  }

  getFairnessEnabled(): boolean {
    return this.enabled;
  }

  getMode(): FairnessMode {
    return this.mode;
  }

  getActiveProfileId(): string {
    return this.activeProfileId;
  }

  /**
   * Emit opt-in timing data for profiling and integration tests. The default
   * production path has no observer and therefore pays no logging cost.
   */
  recordDiagnostic(phase: string, details?: Readonly<Record<string, unknown>>): void {
    if (!this.onDiagnostic) return;
    const clock =
      typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    this.onDiagnostic({ phase, at: clock, ...(details ? { details } : {}) });
  }

  /** Start non-blocking worker/runtime warm-up after the app is ready. */
  initializeBackgroundResources(): void {
    if (!this.enabled) return;
    this.warmWorkerPool();
  }

  beginStart(): number {
    this.operationToken += 1;
    return this.operationToken;
  }

  isStartCurrent(token: number): boolean {
    return token === this.operationToken;
  }

  invalidateStart(): void {
    this.operationToken += 1;
    this.invalidateSearchState();
  }

  /** Invalidate speculative work without cancelling an active start token. */
  invalidatePrecompute(): void {
    this.invalidateSearchState();
  }

  schedulePrecompute(
    request: FairnessStartRequest,
    delay = FAIRNESS_PRECOMPUTE_DEBOUNCE_MS
  ): Promise<FairnessPrecomputedPlan | null> {
    if (!this.enabled) return Promise.resolve(null);
    this.clearPrecomputeTimer();
    if (delay <= 0) {
      return this.precompute(request).catch(() => null);
    }

    return new Promise((resolve) => {
      this.precomputeTimerResolve = resolve;
      this.precomputeTimer = setTimeout(() => {
        this.precomputeTimer = null;
        this.precomputeTimerResolve = null;
        void this.precompute(request).then(resolve, () => resolve(null));
      }, delay);
    });
  }

  async precompute(request: FairnessStartRequest): Promise<FairnessPrecomputedPlan | null> {
    let generation = this.searchGeneration;
    this.recordDiagnostic('precompute.start', { generation });
    await this.ensureLoaded();
    await this.mutationQueue;
    await this.refreshDurableHistoryIfStale();
    // Reservation state is a private control-plane transition and therefore
    // does not advance the history stamp. Refresh it before building a
    // context so a loaded tab cannot search past, or publish, another tab's
    // already durable reservation.
    await this.refreshDurableReservations();
    if (this.foreignActiveDraw) {
      this.recordDiagnostic('precompute.blocked-active-draw', { generation: this.searchGeneration });
      return null;
    }
    generation = this.searchGeneration;
    this.assertSearchCurrent(generation);
    const context = await this.createSearchContext(request, undefined, generation);
    // A context may finish building after another policy mutation invalidated
    // its generation. Never hand that stale context back to the UI, including
    // the strict-balance path where no headless search is awaited.
    this.assertSearchCurrent(generation);
    this.recordDiagnostic('precompute.context-ready', {
      generation,
      key: context.key,
      mustSearch: context.mustSearch,
      budget: context.budget,
    });
    const requestedSeed = getRequestedRoundSeed(request);
    const existingReservation = this.findDurableReservation(
      context,
      requestedSeed,
      request.allowPersistedReservationSeed === true
    );
    if (existingReservation) {
      const plan = this.createPrecomputedPlan(context, requestedSeed, existingReservation);
      this.recordDiagnostic('precompute.reservation-hit', {
        generation,
        key: context.key,
        seed: plan.seed,
        reservationId: plan.reservationId,
      });
      return plan;
    }
    if (!context.mustSearch) {
      const seed = requestedSeed;
      const draft = this.getOrCreatePreparedDrawDraft(context, seed);
      const reservation = await this.ensureDurableReservation(context, {
        seed,
        winnerMarbleIds: [],
        winnerEntryIds: [],
        draft,
      });
      const plan = this.createPrecomputedPlan(context, seed, reservation);
      this.recordDiagnostic('precompute.ready', {
        generation,
        key: context.key,
        seed: plan.seed,
        reservationId: plan.reservationId,
      });
      return plan;
    }
    const candidate = await this.ensureSearch(context);
    const reservation = await this.ensureDurableReservation(context, candidate);
    const plan = this.createPrecomputedPlan(context, candidate.seed, reservation);
    this.recordDiagnostic('precompute.ready', {
      generation,
      key: context.key,
      seed: plan.seed,
      reservationId: plan.reservationId,
    });
    return plan;
  }

  private clearPrecomputeTimer(): void {
    if (this.precomputeTimer === null) return;
    clearTimeout(this.precomputeTimer);
    this.precomputeTimer = null;
    this.precomputeTimerResolve?.(null);
    this.precomputeTimerResolve = null;
  }

  /**
   * Look up a fully cached reservation synchronously, then persist its compact
   * ready-to-claimed transition before materializing the draw. The caller
   * still falls back to prepareDraw when the cache is not complete.
   */
  tryPrepareDrawFromCache(
    request: FairnessStartRequest,
    token: number,
    options: FairnessPrepareDrawOptions = {}
  ): Promise<FairnessPreparedDraw | null> {
    this.clearPrecomputeTimer();
    const cachedReservation = this.findCachedPreparedReservation(request, token);
    if (!cachedReservation) return Promise.resolve(null);
    this.recordDiagnostic('start.prepare.begin', { token, synchronous: true });
    return this.claimCachedPreparedDraw(cachedReservation, token, options.includeEvent !== false);
  }

  private getWorkerPool(): Promise<FairnessWorkerPoolLike | null> {
    if (!this.useWorkerPool || this.workerPoolDisabled) return Promise.resolve(null);
    if (this.configuredWorkerPool) return Promise.resolve(this.configuredWorkerPool);
    if (!this.workerPoolPromise) {
      this.workerPoolPromise = import('./fairnessWorkerPool')
        .then(({ FairnessWorkerPool }) => {
          const workerPool = new FairnessWorkerPool();
          return workerPool.supported ? workerPool : null;
        })
        .catch(() => {
          this.workerPoolDisabled = true;
          return null;
        });
    }
    return this.workerPoolPromise;
  }

  private warmWorkerPool(): void {
    void this.getWorkerPool()
      .then((workerPool) => workerPool?.warmUp?.())
      .catch(() => {
        this.workerPoolDisabled = true;
      });
  }

  private async runProductionHeadless(
    request: FairnessHeadlessSearchRequest,
    options: FairnessHeadlessRunnerOptions = {}
  ): Promise<readonly number[]> {
    const workerPool = await this.getWorkerPool();
    if (!workerPool) return this.runMainThreadHeadless(request, options);
    return workerPool.run(request, { signal: options.signal, stepLimit: this.headlessStepLimit });
  }

  private runMainThreadHeadless(
    request: FairnessHeadlessSearchRequest,
    options: FairnessHeadlessRunnerOptions = {}
  ): Promise<readonly number[]> {
    if (this.hasInjectedHeadlessRunner) return this.headlessRunner(request, options);
    return runHeadlessRace(request, this.headlessStepLimit, options);
  }

  private async acquireFairnessDrawOwnership(
    purpose: string,
    details: Readonly<Record<string, unknown>> = {}
  ): Promise<FairnessDrawOwnership | null> {
    this.recordDiagnostic('fairness.draw-lock.acquire.start', { purpose, ...details });
    const result = await acquireFairnessDrawLock();
    if (result.status === 'acquired') {
      this.recordDiagnostic('fairness.draw-lock.acquire.ready', { purpose, ...details });
      return result.ownership;
    }
    this.recordDiagnostic(
      result.status === 'busy' ? 'fairness.draw-lock.busy' : 'fairness.draw-lock.unavailable',
      { purpose, ...details }
    );
    return null;
  }

  private async releaseFairnessDrawOwnership(
    ownership: FairnessDrawOwnership | undefined,
    purpose: string,
    details: Readonly<Record<string, unknown>> = {}
  ): Promise<void> {
    if (!ownership) return;
    ownership.release();
    await ownership.released;
    this.recordDiagnostic('fairness.draw-lock.release', { purpose, ...details });
    this.flushDurableChangeNotification();
  }

  private hasOwnedFairnessDraw(): boolean {
    for (const claimed of this.claimedReservations.values()) {
      if (claimed.ownership?.isActive()) return true;
    }
    return false;
  }

  /**
   * Serialize every durable Fairness mutation with the same origin lock used
   * by an active draw. Callers that already own the lock use the direct store
   * helpers explicitly; this avoids treating an unrelated async callback in
   * the same document as a re-entrant operation.
   */
  private async withDurableStateMutation<T>(purpose: string, operation: () => Promise<T>): Promise<T> {
    // Web Locks serializes tabs, but it does not serialize callers in one
    // document when ifAvailable is used. Queue the local acquisition as well
    // so rapid input/policy events do not turn into spurious busy failures.
    const previous = this.durableMutationQueue;
    const current = previous.then(() => this.withDurableStateMutationNow(purpose, operation));
    this.durableMutationQueue = current.then(
      () => undefined,
      () => undefined
    );
    return current;
  }

  private async withDurableStateMutationNow<T>(purpose: string, operation: () => Promise<T>): Promise<T> {
    // A same-tab round transition queues its cancellation before it queues a
    // participant/config mutation. Give that terminal operation a chance to
    // release the long-lived draw ownership; a genuinely active draw still
    // returns busy without touching durable state.
    if (this.hasOwnedFairnessDraw()) {
      await this.mutationQueue;
      if (this.hasOwnedFairnessDraw()) throw new FairnessStateBusyError();
    }
    const ownership = await this.acquireFairnessDrawOwnership(purpose);
    if (!ownership) throw new FairnessStateBusyError();
    try {
      this.durableMutationActive = true;
      await this.refreshDurableHistoryIfStale();
      await this.recoverClaimedReservationsWhileOwned();
      return await operation();
    } finally {
      this.durableMutationActive = false;
      await this.releaseFairnessDrawOwnership(ownership, purpose);
      this.flushDurableChangeNotification();
    }
  }

  private flushDurableChangeNotification(): void {
    if (this.durableMutationActive || this.hasOwnedFairnessDraw() || !this.durableChangeNotificationPending) return;
    this.durableChangeNotificationPending = false;
    this.notifyStateChanged();
  }

  private scheduleInterruptedRecoveryRetry(): void {
    if (!supportsFairnessDrawLock() || this.recoveryRetryTimer !== null) return;
    this.recoveryRetryTimer = setTimeout(() => {
      this.recoveryRetryTimer = null;
      if (!this.loaded || this.hasOwnedFairnessDraw()) return;
      void this.withDurableStateMutation('interrupted-recovery-retry', async () => undefined).catch((error) => {
        if (error instanceof FairnessStateBusyError) {
          this.scheduleInterruptedRecoveryRetry();
          return;
        }
        if (!isCancellationError(error)) this.markUnavailable(error);
      });
    }, 1000);
  }

  /**
   * A tab-local projection is only a cache. Refresh it from the durable event
   * log at serialization boundaries so a tab cannot write policy changes or
   * claim a prepared draw from an older history snapshot.
   */
  private async loadDurableHistorySnapshot(): Promise<{
    events: FairnessEvent[];
    historyStamp: FairnessHistoryStamp | null;
  }> {
    const loadHistoryStamp = this.store.loadHistoryStamp;
    if (!loadHistoryStamp) {
      return {
        events: await this.store.load(this.activeProfileId),
        historyStamp: null,
      };
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = await loadHistoryStamp.call(this.store, this.activeProfileId);
      const events = await this.store.load(this.activeProfileId);
      const after = await loadHistoryStamp.call(this.store, this.activeProfileId);

      if (
        before?.revision === after?.revision &&
        before?.eventCount === after?.eventCount &&
        before?.tailEventId === after?.tailEventId
      ) {
        return { events, historyStamp: after };
      }
    }

    throw new Error('Fairness history changed while loading');
  }

  private async refreshDurableHistoryIfStale(): Promise<boolean> {
    if (!this.loaded || this.hasOwnedFairnessDraw()) return false;
    const { events, historyStamp: durableStamp } = await this.loadDurableHistorySnapshot();
    if (sameHistoryStamp(this.historyStamp, durableStamp)) return false;
    const fingerprint = getHistoryFingerprint(events);
    if (fingerprint === this.historyFingerprint) {
      this.historyStamp = durableStamp;
      return false;
    }
    const reservations = this.store.loadReservations
      ? await this.store.loadReservations.call(this.store, this.activeProfileId)
      : [];
    const hasQuarantinedClaimedReservations = this.store.hasQuarantinedClaimedReservations
      ? await this.store.hasQuarantinedClaimedReservations()
      : false;

    this.events = events.map((event) => clone(event));
    this.projection = projectFairnessEvents(this.events);
    this.manualRenames = collectManualRenameBindings(this.events);
    this.inputBindings = [];
    this.boundInputs = [];
    this.historyFingerprint = fingerprint;
    this.historyStamp = durableStamp;
    // The reservations read above is the replacement snapshot. Do not let the
    // invalidation cleanup delete a valid reservation that is about to be
    // rehydrated into durableReservations.
    this.invalidateSearchState(false);

    const preparedEventsByDrawId = new Map<string, FairnessDrawPreparedEvent>();
    const terminalDrawIds = new Set<string>();
    this.events.forEach((event) => {
      if (event.type === 'drawPrepared') preparedEventsByDrawId.set(event.drawId, event);
      if (
        event.type === 'drawConfirmed' ||
        event.type === 'drawFailed' ||
        event.type === 'drawCancelled' ||
        event.type === 'drawVoided'
      ) {
        terminalDrawIds.add(event.drawId);
      }
    });
    const reservationsByKey = new Map<string, DurableFairnessReservation>();
    this.foreignActiveDraw = hasQuarantinedClaimedReservations;
    reservations.forEach((rawReservation) => {
      const reservation: DurableFairnessReservation = {
        ...rawReservation,
        state: rawReservation.state ?? 'ready',
        rulesetVersion: rawReservation.rulesetVersion ?? 0,
        draft: rawReservation.draft,
      };
      if (reservation.state !== 'ready' && reservation.state !== 'claimed') {
        this.scheduleReadyReservationDiscard(reservation);
        return;
      }
      if (terminalDrawIds.has(reservation.drawId)) {
        this.scheduleTerminalReservationDiscard(reservation);
        return;
      }
      const draftValid =
        isPreparedDrawDraft(reservation.draft) && reservation.draft.seed === reservation.seed;
      const persistedPreparedEvent = preparedEventsByDrawId.get(reservation.drawId);
      if (reservation.state === 'claimed') {
        // Claimed records belong to an interrupted draw, even when they were
        // written by an older ruleset. They must never become reusable, but a
        // valid draft can still be terminalized as cancelled under the
        // recovery lock.
        this.foreignActiveDraw = true;
        if (draftValid) {
          if (reservation.rulesetVersion !== FAIRNESS_SIMULATION_RULESET_VERSION) {
            this.recordDiagnostic('reservation.ruleset-stale', {
              reservationId: reservation.reservationId,
              key: reservation.key,
              rulesetVersion: reservation.rulesetVersion,
              expectedRulesetVersion: FAIRNESS_SIMULATION_RULESET_VERSION,
            });
          }
          this.scheduleInterruptedRecoveryRetry();
        }
        return;
      }
      // A ready record paired with a persisted prepared event is an
      // interrupted legacy state. Recover it even if its ruleset is old; it
      // is never reused and therefore cannot cross a changed physics
      // implementation into a live draw.
      if (persistedPreparedEvent && draftValid) {
        this.scheduleInterruptedRecoveryRetry();
        return;
      }
      if (
        !draftValid ||
        reservation.rulesetVersion !== FAIRNESS_SIMULATION_RULESET_VERSION
      ) {
        if (reservation.rulesetVersion !== FAIRNESS_SIMULATION_RULESET_VERSION) {
          this.recordDiagnostic('reservation.ruleset-stale', {
            reservationId: reservation.reservationId,
            key: reservation.key,
            rulesetVersion: reservation.rulesetVersion,
            expectedRulesetVersion: FAIRNESS_SIMULATION_RULESET_VERSION,
          });
        }
        this.scheduleReadyReservationDiscard(reservation);
        return;
      }
      const existing = reservationsByKey.get(reservation.key);
      if (!existing) {
        reservationsByKey.set(reservation.key, reservation);
        return;
      }
      const keep = existing.reservationId.localeCompare(reservation.reservationId) <= 0 ? existing : reservation;
      const discard = keep === existing ? reservation : existing;
      reservationsByKey.set(reservation.key, keep);
      this.scheduleReadyReservationDiscard(discard);
      this.recordDiagnostic('reservation.duplicate-discard', {
        key: reservation.key,
        keptReservationId: keep.reservationId,
        discardedReservationId: discard.reservationId,
      });
    });
    reservationsByKey.forEach((reservation) => this.durableReservations.set(reservation.reservationId, reservation));
    this.available = true;
    this.error = null;
    this.recordDiagnostic('fairness.state-refresh', { eventCount: this.events.length });
    return true;
  }

  /**
   * Reservation state can change without an event-log revision (reserve and
   * ready -> claimed are intentionally private control-plane transitions).
   * Refresh that smaller snapshot when another tab sends a notification so a
   * loaded tab cannot keep publishing a stale ReadyToStart cache.
   */
  private async refreshDurableReservations(): Promise<boolean> {
    if (!this.loaded || this.hasOwnedFairnessDraw() || !this.store.loadReservations) return false;
    const reservations = await this.store.loadReservations.call(this.store, this.activeProfileId);
    const hasQuarantinedClaimedReservations = this.store.hasQuarantinedClaimedReservations
      ? await this.store.hasQuarantinedClaimedReservations()
      : false;
    const preparedDrawIds = new Set(
      this.events
        .filter((event): event is FairnessDrawPreparedEvent => event.type === 'drawPrepared')
        .map((event) => event.drawId)
    );
    const terminalDrawIds = new Set(
      this.events
        .filter(
          (event) =>
            event.type === 'drawConfirmed' ||
            event.type === 'drawFailed' ||
            event.type === 'drawCancelled' ||
            event.type === 'drawVoided'
        )
        .map((event) => event.drawId)
    );
    const nextByKey = new Map<string, DurableFairnessReservation>();
    let recoveryNeeded = false;
    this.foreignActiveDraw = hasQuarantinedClaimedReservations;

    reservations.forEach((rawReservation) => {
      const reservation: DurableFairnessReservation = {
        ...rawReservation,
        state: rawReservation.state ?? 'ready',
        rulesetVersion: rawReservation.rulesetVersion ?? 0,
        draft: rawReservation.draft,
      };
      if (reservation.state !== 'ready' && reservation.state !== 'claimed') {
        this.scheduleReadyReservationDiscard(reservation);
        return;
      }
      if (terminalDrawIds.has(reservation.drawId)) {
        this.scheduleTerminalReservationDiscard(reservation);
        return;
      }
      const draftValid =
        isPreparedDrawDraft(reservation.draft) && reservation.draft.seed === reservation.seed;
      if (reservation.state === 'claimed') {
        // A claimed record is never a reusable reservation. Let the retry
        // acquire the recovery lock once the owning document disappears.
        this.foreignActiveDraw = true;
        if (draftValid) recoveryNeeded = true;
        return;
      }
      if (
        !draftValid ||
        reservation.rulesetVersion !== FAIRNESS_SIMULATION_RULESET_VERSION ||
        preparedDrawIds.has(reservation.drawId)
      ) {
        // A ready record paired with a persisted prepared event is an
        // interrupted legacy state and must be recovered, not discarded.
        if (preparedDrawIds.has(reservation.drawId)) {
          recoveryNeeded = true;
          this.foreignActiveDraw = true;
        } else {
          this.scheduleReadyReservationDiscard(reservation);
        }
        return;
      }
      const existing = nextByKey.get(reservation.key);
      if (!existing) {
        nextByKey.set(reservation.key, reservation);
        return;
      }
      const keep = existing.reservationId.localeCompare(reservation.reservationId) <= 0 ? existing : reservation;
      const discard = keep === existing ? reservation : existing;
      nextByKey.set(reservation.key, keep);
      this.scheduleReadyReservationDiscard(discard);
      this.recordDiagnostic('reservation.duplicate-discard', {
        key: reservation.key,
        keptReservationId: keep.reservationId,
        discardedReservationId: discard.reservationId,
      });
    });

    let changed = this.durableReservations.size !== nextByKey.size;
    if (!changed) {
      for (const [reservationId, reservation] of this.durableReservations) {
        const next = nextByKey.get(reservation.key);
        if (!next || !sameReservationIdentityValues(reservation, next)) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      this.invalidateSearchState(false);
      nextByKey.forEach((reservation) => this.durableReservations.set(reservation.reservationId, reservation));
      if (nextByKey.size === 0) {
        // invalidateSearchState() already cleared the old map; this branch is
        // kept explicit to document that no stale reservation is retained.
        this.durableReservations.clear();
      }
    }
    if (recoveryNeeded) this.scheduleInterruptedRecoveryRetry();
    return changed;
  }

  private scheduleReadyReservationDiscard(reservation: FairnessReservationRecord): void {
    const discardReadyReservation = this.store.discardReadyReservation;
    if (!discardReadyReservation) return;
    void discardReadyReservation
      .call(this.store, reservation.reservationId, getReservationIdentity(reservation))
      .then((result) => {
        if (result === 'discarded') this.broadcastStateChanged();
      })
      .catch(() => undefined);
  }

  /** A terminal event is durable truth, so its leftover reservation is no
   * longer an active/speculative record and can be removed by id. */
  private scheduleTerminalReservationDiscard(reservation: FairnessReservationRecord): void {
    const removeReservation = this.store.removeReservation;
    if (!removeReservation) return;
    void removeReservation.call(this.store, reservation.reservationId).catch(() => undefined);
  }

  private invalidateSearchState(discardReservations = true): void {
    const staleWork = this.inFlightSearch;
    const stalePlanId = `fairness-plan-${this.searchGeneration}`;
    this.searchGeneration += 1;
    this.cachedCandidate = null;
    this.cachedPreparedDraft = null;
    this.cachedContext = null;
    this.clearPrecomputeTimer();
    const staleReservations = [...this.durableReservations.values()];
    this.durableReservations.clear();
    staleWork?.controller.abort();
    if (discardReservations) {
      staleReservations.forEach((reservation) => this.scheduleReadyReservationDiscard(reservation));
    }
    if (this.configuredWorkerPool) {
      this.configuredWorkerPool.dropPlan?.(stalePlanId);
    } else {
      void this.workerPoolPromise?.then((workerPool) => workerPool?.dropPlan?.(stalePlanId));
    }
  }

  private assertSearchCurrent(generation: number): void {
    if (generation !== this.searchGeneration) throw new FairnessCancelledError();
  }

  private currentInputsMatchKnownParticipants(): boolean {
    try {
      const rows = parseFairnessEntries(this.currentInputs, this.enabled || this.events.length > 0);
      // parseFairnessEntries skips malformed rows, so make that invalid-input
      // case explicit instead of treating it as an empty participant set.
      if (rows.length !== this.currentInputs.length) return false;

      const memberNames = new Set<string>();
      rows.forEach((row) => row.memberNames.forEach((name) => memberNames.add(name)));
      return [...memberNames].every((name) =>
        this.projection.participants.some(
          (participant) =>
            participantNameKey(participant.displayName) === participantNameKey(name) ||
            participantNameKey(this.manualRenames.get(participant.id) ?? '') === participantNameKey(name)
        )
      );
    } catch {
      return false;
    }
  }

  setCurrentParticipantInputs(inputs: readonly string[], suppressSync = false, skipInvalidation = false): void {
    const nextInputs = [...inputs];
    const changed = !sameStrings(this.currentInputs, nextInputs);
    this.currentInputs = nextInputs;
    if (suppressSync) {
      // Replay/bootstrap restoration is an authoritative caller-owned
      // snapshot, not a user mutation that should be retried after a peer
      // notification.
      if (changed) this.participantInputsDirty = false;
      return;
    }
    if (changed) {
      this.participantInputsDirty = true;
      if (!skipInvalidation) this.invalidateStart();
    }
    if (!this.enabled) return;

    if (!changed) return;

    const generation = this.searchGeneration;
    const inputSnapshot = nextInputs;

    void this.syncCurrentParticipants(
      false,
      inputSnapshot,
      undefined,
      this.enabled || this.events.length > 0,
      generation
    )
      .then(() => {
        if (sameStrings(this.currentInputs, inputSnapshot)) this.participantInputsDirty = false;
      })
      .catch((error) => {
        if (error instanceof FairnessCancelledError) return;
        if (isFairnessInputError(error)) this.error = getErrorMessage(error);
        else this.markUnavailable(error);
      });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.enabled && (!enabled || this.available)) return;
    const notificationSequence = this.stateChangeSequence;
    if (!enabled) {
      this.invalidateSearchState();
      this.enabled = false;
      writeLocalStorage(FAIRNESS_ENABLED_STORAGE_KEY, 'false');
      if (this.stateChangeSequence === notificationSequence) this.notifyStateChanged();
      return;
    }

    try {
      this.invalidateSearchState();
      await this.ensureLoaded();
      this.available = true;
      this.error = null;
      this.enabled = true;
      // Persist the preference before participant synchronization can publish
      // a durable event, so every successful notification observes the final
      // enabled state.
      writeLocalStorage(FAIRNESS_ENABLED_STORAGE_KEY, 'true');
      const generation = this.searchGeneration;
      await this.syncCurrentParticipants(false, this.currentInputs, undefined, true, generation);
      this.warmWorkerPool();
      if (this.stateChangeSequence === notificationSequence) this.notifyStateChanged();
    } catch (error) {
      if (error instanceof FairnessCancelledError) return;
      if (isFairnessInputError(error)) {
        this.enabled = false;
        this.error = getErrorMessage(error);
        writeLocalStorage(FAIRNESS_ENABLED_STORAGE_KEY, 'false');
      } else {
        this.markUnavailable(error);
      }
      throw new Error(getErrorMessage(error));
    }
  }

  async setMode(mode: FairnessMode): Promise<void> {
    if (!isFairnessMode(mode)) throw new Error('Fairness mode is invalid');
    if (this.mode === mode) return;
    this.mode = mode;
    writeLocalStorage(FAIRNESS_MODE_STORAGE_KEY, mode);
    this.notifyStateChanged();
  }

  async addParticipant(displayName: string): Promise<string> {
    const name = displayName.trim();
    if (!name || name.length > 512) throw new Error('Fairness participant name is invalid');
    await this.ensureLoaded();
    this.invalidateStart();
    let participantId = '';
    await this.withDurableStateMutation('participant-add', async () => {
      await this.enqueueMutation(async () => {
        await this.ensureOperational();
        const nameKey = participantNameKey(name);
        if (
          this.projection.participants.some(
            (participant) =>
              participantNameKey(participant.displayName) === nameKey ||
              participantNameKey(this.manualRenames.get(participant.id) ?? '') === nameKey
          )
        ) {
          throw new Error('Fairness participant name is already in use');
        }
        await this.ensureEpoch();
        participantId = this.createId('participant');
        const base = createBaseEvent('participantDiscovered', this.now, this.createId);
        await this.appendEventDirect({
          ...base,
          participantId,
          displayName: name,
          active: true,
          excluded: false,
        });
      });
    });
    return participantId;
  }

  async setParticipantActive(participantId: string, active: boolean): Promise<void> {
    await this.ensureLoaded();
    this.invalidateStart();
    await this.withDurableStateMutation('participant-active', async () => {
      await this.enqueueMutation(async () => {
        await this.ensureOperational();
        const participant = this.projection.participants.find((candidate) => candidate.id === participantId);
        if (!participant) throw new Error('Fairness participant was not found');
        if (participant.active === active) return;
        await this.ensureEpoch();
        const base = createBaseEvent('participantParticipationChanged', this.now, this.createId);
        await this.appendEventDirect({ ...base, participantId, active });
      });
    });
  }

  async createProfile(name: string): Promise<FairnessProfile> {
    const normalizedName = normalizeProfileName(name);
    await this.ensureLoaded();
    const profile: FairnessProfile = {
      id: this.createId('profile'),
      name: normalizedName,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.withDurableStateMutation('profile-create', async () => {
      const saveProfile = this.store.saveProfile;
      if (!saveProfile) throw new Error('Fairness profiles are unavailable');
      await this.refreshProfiles();
      if (hasProfileName(this.profiles, normalizedName)) {
        throw new Error('Fairness profile name is already in use');
      }
      await saveProfile.call(this.store, profile);
      this.profiles = [...this.profiles, profile].sort(profileOrder);
      this.markDurableStateChanged();
    });
    return profile;
  }

  async renameProfile(profileId: string, name: string): Promise<void> {
    const normalizedName = normalizeProfileName(name);
    await this.ensureLoaded();
    const current = this.profiles.find((profile) => profile.id === profileId);
    if (!current) throw new Error('Fairness profile was not found');
    await this.withDurableStateMutation('profile-rename', async () => {
      const saveProfile = this.store.saveProfile;
      if (!saveProfile) throw new Error('Fairness profiles are unavailable');
      await this.refreshProfiles();
      const latest = this.profiles.find((profile) => profile.id === profileId);
      if (!latest) throw new Error('Fairness profile was not found');
      if (latest.name === normalizedName) return;
      if (hasProfileName(this.profiles, normalizedName, profileId)) {
        throw new Error('Fairness profile name is already in use');
      }
      const updated = { ...latest, name: normalizedName, updatedAt: this.now() };
      await saveProfile.call(this.store, updated);
      this.profiles = this.profiles.map((profile) => (profile.id === profileId ? updated : profile));
      this.markDurableStateChanged();
    });
  }

  async duplicateProfile(sourceProfileId: string, name: string): Promise<FairnessProfile> {
    const normalizedName = normalizeProfileName(name);
    await this.ensureLoaded();
    const load = this.store.load;
    const saveProfile = this.store.saveProfile;
    if (!load || !saveProfile) throw new Error('Fairness profiles are unavailable');
    let profile: FairnessProfile | null = null;
    await this.withDurableStateMutation('profile-duplicate', async () => {
      await this.refreshProfiles();
      if (!this.profiles.some((candidate) => candidate.id === sourceProfileId)) {
        throw new Error('Fairness profile was not found');
      }
      if (hasProfileName(this.profiles, normalizedName)) {
        throw new Error('Fairness profile name is already in use');
      }
      const sourceEvents = await load.call(this.store, sourceProfileId);
      const sourceProjection = projectFairnessEvents(sourceEvents);
      const duplicate = {
        id: this.createId('profile'),
        name: normalizedName,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      profile = duplicate;
      await saveProfile.call(this.store, duplicate);
      const epochId = this.createId('epoch');
      await this.store.append(
        { ...createBaseEvent('epochStarted', this.now, this.createId), epochId },
        duplicate.id
      );
      for (const participant of sourceProjection.participants) {
        const participantId = this.createId('participant');
        await this.store.append(
          {
            ...createBaseEvent('participantDiscovered', this.now, this.createId),
            participantId,
            displayName: participant.displayName,
            active: participant.active,
            excluded: participant.excluded,
          },
          duplicate.id
        );
      }
      this.profiles = [...this.profiles, duplicate].sort(profileOrder);
      this.markDurableStateChanged();
    });
    if (!profile) throw new Error('Fairness profile could not be duplicated');
    return profile;
  }

  async selectProfile(profileId: string): Promise<void> {
    await this.ensureLoaded();
    await this.refreshProfiles();
    if (profileId === this.activeProfileId) return;
    if (!this.profiles.some((profile) => profile.id === profileId)) {
      throw new Error('Fairness profile was not found');
    }
    if (this.hasOwnedFairnessDraw()) throw new FairnessStateBusyError();
    await this.durableMutationQueue;
    if (this.hasOwnedFairnessDraw()) throw new FairnessStateBusyError();
    await this.mutationQueue;
    this.operationToken += 1;
    this.invalidateSearchState(false);
    this.activeProfileId = profileId;
    writeSessionStorage(FAIRNESS_ACTIVE_PROFILE_STORAGE_KEY, profileId);
    this.events = [];
    this.projection = projectFairnessEvents([]);
    this.historyFingerprint = getHistoryFingerprint([]);
    this.historyStamp = null;
    this.manualRenames.clear();
    this.inputBindings = [];
    this.boundInputs = [];
    this.participantInputsDirty = true;
    this.durableReservations.clear();
    this.claimedReservations.clear();
    this.loaded = false;
    this.available = false;
    await this.ensureLoaded();
    this.notifyStateChanged();
  }

  async getState(): Promise<FairnessState> {
    try {
      await this.ensureLoaded();
      await this.mutationQueue;
      await this.refreshDurableHistoryIfStale();
      await this.refreshDurableReservations();
      await this.refreshProfiles();
    } catch (error) {
      this.markUnavailable(error);
    }
    return createFairnessState(this.projection, {
      available: this.available,
      enabled: this.enabled && this.available,
      mode: this.mode,
      activeProfileId: this.activeProfileId,
      profiles: this.profiles,
      error: this.error,
    });
  }

  async setParticipantExcluded(participantId: string, excluded: boolean): Promise<void> {
    this.pendingExclusionRequests.set(participantId, excluded);
    this.invalidateStart();
    try {
      await this.withDurableStateMutation('participant-exclusion', async () => {
        await this.enqueueMutation(async () => {
          let participant = this.projection.participants.find((candidate) => candidate.id === participantId);
          if (participant?.excluded === excluded) return;
          await this.ensureOperational();
          participant = this.projection.participants.find((candidate) => candidate.id === participantId);
          if (!participant) throw new Error('Fairness participant was not found');
          if (participant.excluded === excluded) return;
          await this.ensureEpoch();
          const base = createBaseEvent('participantExclusionChanged', this.now, this.createId);
          await this.appendEventDirect({ ...base, participantId, excluded });
        });
      });
    } finally {
      if (this.pendingExclusionRequests.get(participantId) === excluded) {
        this.pendingExclusionRequests.delete(participantId);
      }
    }
  }

  async renameParticipant(participantId: string, displayName: string): Promise<void> {
    const trimmedName = displayName.trim();
    if (!trimmedName || trimmedName.length > 512) throw new Error('Fairness participant name is invalid');
    this.pendingRenameRequests.set(participantId, trimmedName);
    this.invalidateStart();
    try {
      await this.withDurableStateMutation('participant-rename', async () => {
        await this.enqueueMutation(async () => {
          let participant = this.projection.participants.find((candidate) => candidate.id === participantId);
          if (participant?.displayName === trimmedName) return;
          await this.ensureOperational();
          participant = this.projection.participants.find((candidate) => candidate.id === participantId);
          if (!participant) throw new Error('Fairness participant was not found');
          if (participant.displayName === trimmedName) return;
          if (
            this.projection.participants.some(
              (candidate) =>
                candidate.id !== participantId &&
                (participantNameKey(candidate.displayName) === participantNameKey(trimmedName) ||
                  participantNameKey(this.manualRenames.get(candidate.id) ?? '') === participantNameKey(trimmedName))
            )
          ) {
            throw new Error('Fairness participant name is already in use');
          }
          await this.ensureEpoch();
          const boundIndex = this.inputBindings.findIndex((binding) => binding?.includes(participantId));
          const memberIndex = boundIndex >= 0 ? (this.inputBindings[boundIndex]?.indexOf(participantId) ?? -1) : -1;
          const parsed = boundIndex >= 0 ? parseName(this.boundInputs[boundIndex]) : null;
          const memberNames = parsed ? parseFairnessEntryName(parsed.name) : null;
          const rawInput = memberIndex >= 0 && memberNames ? memberNames[memberIndex] : undefined;
          if (rawInput !== undefined) this.manualRenames.set(participantId, rawInput);
          const base = createBaseEvent('participantRenamed', this.now, this.createId);
          await this.appendEventDirect({
            ...base,
            participantId,
            displayName: trimmedName,
            ...(rawInput ? { rawInput } : {}),
          });
        });
      });
    } finally {
      if (this.pendingRenameRequests.get(participantId) === trimmedName) {
        this.pendingRenameRequests.delete(participantId);
      }
    }
  }

  async startNewEpoch(): Promise<void> {
    this.invalidateStart();
    await this.withDurableStateMutation('epoch-start', async () => {
      await this.ensureOperational();
      await this.syncCurrentParticipants(
        false,
        this.currentInputs,
        undefined,
        this.enabled || this.events.length > 0,
        undefined,
        true
      );
      await this.enqueueMutation(async () => {
        const base = createBaseEvent('epochStarted', this.now, this.createId);
        await this.appendEventDirect({ ...base, epochId: this.createId('epoch') });
      });
    });
  }

  async voidDraw(drawId: string): Promise<void> {
    await this.ensureLoaded();
    this.invalidateStart();
    await this.withDurableStateMutation('draw-void', async () => {
      await this.ensureOperational();
      const current = this.projection.draws.find((candidate) => candidate.id === drawId);
      if (!current) throw new Error('Fairness draw was not found');
      if (current.status === 'voided') return;
      if (current.status !== 'confirmed') throw new Error('Only a confirmed fairness draw can be voided');
      await this.enqueueMutation(async () => {
        const draw = this.projection.draws.find((candidate) => candidate.id === drawId);
        if (!draw || draw.status === 'voided') return;
        if (draw.status !== 'confirmed') throw new Error('Only a confirmed fairness draw can be voided');
        const base = createBaseEvent('drawVoided', this.now, this.createId);
        await this.appendEventDirect({ ...base, drawId, reason: 'Voided by user' });
      });
    });
  }

  async exportData(): Promise<FairnessExport> {
    await this.ensureLoaded();
    await this.mutationQueue;
    await this.refreshDurableHistoryIfStale();
    await this.refreshDurableReservations();
    const profile = this.profiles.find((candidate) => candidate.id === this.activeProfileId);
    return createFairnessExport(
      this.events,
      this.mode,
      profile
        ? { name: profile.name, createdAt: profile.createdAt, updatedAt: profile.updatedAt }
        : undefined
    );
  }

  async importData(value: unknown): Promise<void> {
    this.invalidateStart();
    const data = validateFairnessExport(typeof value === 'string' ? this.parseJson(value) : value);
    await this.ensureLoaded();
    if (!this.available) throw new Error(this.error ?? DEFAULT_RECENT_ERROR);

    const importedName = normalizeProfileName(
      data.profile?.name ?? `Imported ${new Date(this.now()).toLocaleDateString()}`
    );
    let profile: FairnessProfile | null = null;
    await this.withDurableStateMutation('fairness-import', async () => {
      const saveProfile = this.store.saveProfile;
      if (!saveProfile) throw new Error('Fairness profiles are unavailable');
      await this.refreshProfiles();
      const importedProfile = {
        id: this.createId('profile'),
        name: uniqueImportedProfileName(this.profiles, importedName),
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      profile = importedProfile;
      await saveProfile.call(this.store, importedProfile);
      await this.store.replace(data.events, importedProfile.id);
      this.profiles = [...this.profiles, importedProfile].sort(profileOrder);
      this.mode = data.mode;
      writeLocalStorage(FAIRNESS_MODE_STORAGE_KEY, this.mode);
    });
    if (!profile) throw new Error('Fairness import did not create a profile');
    await this.selectProfile(profile.id);
  }

  async clearData(): Promise<void> {
    this.invalidateStart();
    await this.ensureLoaded();
    if (!this.available) throw new Error(this.error ?? DEFAULT_RECENT_ERROR);
    await this.withDurableStateMutation('fairness-clear', async () => {
      await this.enqueueMutation(async () => {
        try {
          await this.store.clear(this.activeProfileId);
        } catch (error) {
          this.markUnavailable(error);
          throw error;
        }
        this.events = [];
        this.projection = projectFairnessEvents([]);
        this.historyFingerprint = getHistoryFingerprint([]);
        this.advanceHistoryStamp();
        this.inputBindings = [];
        this.boundInputs = [];
        this.manualRenames.clear();
        this.pendingExclusionRequests.clear();
        this.pendingRenameRequests.clear();
        this.durableReservations.clear();
        this.claimedReservations.clear();
        this.markDurableStateChanged();
      });
    });
  }

  prepareDraw(
    request: FairnessStartRequest,
    token: number,
    options: FairnessPrepareDrawOptions = {}
  ): Promise<FairnessPreparedDraw> {
    this.clearPrecomputeTimer();
    this.recordDiagnostic('start.prepare.begin', { token });
    const includeEvent = options.includeEvent !== false;
    try {
      const cachedReservation = this.findCachedPreparedReservation(request, token);
      if (cachedReservation) {
        return this.claimCachedPreparedDraw(cachedReservation, token, includeEvent);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return this.prepareDrawSlow(request, token, options);
  }

  private async prepareDrawSlow(
    request: FairnessStartRequest,
    token: number,
    options: FairnessPrepareDrawOptions
  ): Promise<FairnessPreparedDraw> {
    const includeEvent = options.includeEvent !== false;
    await this.ensureLoaded();
    await this.mutationQueue;
    await this.refreshDurableHistoryIfStale();
    await this.refreshDurableReservations();
    if (this.foreignActiveDraw) throw new FairnessStateBusyError();
    const context = await this.createSearchContext(request, token);
    const { syncedInputs, mappingRows, totalCount } = context;
    let seed = getRequestedRoundSeed(request);
    let expectedWinnerEntryIds: readonly string[] | null = null;
    let expectedWinnerParticipantIds: readonly string[] | null = null;
    let expectedWinnerMarbleIds: readonly number[] | null = null;
    let drawId: string | null = null;
    const getDrawId = (): string => {
      if (drawId === null) drawId = this.createId('draw');
      return drawId;
    };
    let preparedEvent: FairnessDrawPreparedEvent | null = null;

    try {
      const durableReservation = this.findDurableReservation(
        context,
        seed,
        request.allowPersistedReservationSeed === true
      );
      if (durableReservation) {
        return this.claimCachedPreparedDraw({ context, reservation: durableReservation }, token, includeEvent);
      }

      if (context.mustSearch) {
        const searchResult = await this.ensureSearch(context, token);
        this.consumeCandidate(context);
        seed = searchResult.seed;
        const reservation = await this.ensureDurableReservation(context, searchResult);
        if (reservation) return this.claimCachedPreparedDraw({ context, reservation }, token, includeEvent);
        expectedWinnerEntryIds = [searchResult.winnerEntryIds[request.winnerRange.end]];
        const winningEntry = syncedInputs.find((entry) => entry.entryId === expectedWinnerEntryIds?.[0]);
        expectedWinnerParticipantIds = winningEntry?.memberIds.length === 1 ? [winningEntry.memberIds[0]] : null;
        expectedWinnerMarbleIds = [searchResult.winnerMarbleIds[request.winnerRange.end]];

        const event = this.createPreparedEventFromDraft(getDrawId(), searchResult.draft);
        preparedEvent = event;
        await this.appendPreparedEventIfCurrent(context, token, event);
        return {
          drawId: event.drawId,
          seed,
          event: includeEvent ? clone(event) : event,
          expectedWinnerEntryIds,
          expectedWinnerParticipantIds,
          expectedWinnerMarbleIds,
          operationToken: token,
          key: context.key,
          generation: context.generation,
        };
      }

      this.assertCurrent(token);
      const draft = this.getOrCreatePreparedDrawDraft(context, seed);
      const reservation = await this.ensureDurableReservation(context, {
        seed,
        winnerMarbleIds: [],
        winnerEntryIds: [],
        draft,
      });
      if (reservation) return this.claimCachedPreparedDraw({ context, reservation }, token, includeEvent);
      const event = this.createPreparedEventFromDraft(getDrawId(), draft);
      preparedEvent = event;
      await this.appendPreparedEventIfCurrent(context, token, event);
      return {
        drawId: event.drawId,
        seed,
        event: includeEvent ? clone(event) : event,
        expectedWinnerEntryIds,
        expectedWinnerParticipantIds,
        expectedWinnerMarbleIds,
        operationToken: token,
        key: context.key,
        generation: context.generation,
      };
    } catch (error) {
      if (error instanceof FairnessCancelledError) throw error;
      if (!preparedEvent) {
        try {
          preparedEvent = this.createPreparedEvent(
            request,
            seed,
            syncedInputs,
            mappingRows,
            totalCount,
            getDrawId(),
            true
          );
        } catch {
          // A storage or cancellation failure should not mask the original
          // search error or prevent the legacy race path from continuing.
        }
      }
      await this.recordFailedDraw(getDrawId(), getErrorMessage(error), preparedEvent).catch(() => undefined);
      throw error;
    }
  }

  async confirmDraw(
    drawId: string,
    winnerMarbleIds: readonly number[],
    token: number | null,
    expectedWinnerParticipantIds: readonly string[] | null = null,
    expectedWinnerMarbleIds: readonly number[] | null = null,
    expectedWinnerEntryIds: readonly string[] | null = null
  ): Promise<FairnessConfirmationResult> {
    await this.ensureLoaded();
    if (!this.available) return { confirmed: false, reason: this.error ?? DEFAULT_RECENT_ERROR };
    if (token !== null && !this.isStartCurrent(token)) {
      // confirmDraw already owns the mutation queue below. Calling the public
      // cancelDraw() here would enqueue a second operation behind this one and
      // wait on itself. Finalize the prepared draw directly instead.
      return this.enqueueMutation(async () => {
        await this.finalizeClaimedReservation(drawId, {
          ...createBaseEvent('drawCancelled', this.now, this.createId),
          drawId,
          reason: 'Fairness draw was cancelled before confirmation',
        });
        return { confirmed: false, reason: 'Fairness draw was cancelled' };
      });
    }

    return this.enqueueMutation(async () => {
      const draw = this.projection.draws.find((candidate) => candidate.id === drawId);
      if (!draw || draw.status !== 'prepared') return { confirmed: false, reason: 'Fairness draw is not prepared' };
      if (token !== null && !this.isStartCurrent(token)) {
        await this.finalizeClaimedReservation(drawId, {
          ...createBaseEvent('drawCancelled', this.now, this.createId),
          drawId,
          reason: 'Fairness draw was cancelled before confirmation',
        });
        return { confirmed: false, reason: 'Fairness draw was cancelled' };
      }

      const winners = mapWinnerMarbles(winnerMarbleIds, draw.entries, draw.members);
      if (!winners || winners.length === 0) {
        const reason = 'Fairness could not map the actual winner to a participant';
        await this.finalizeClaimedReservation(drawId, {
          ...createBaseEvent('drawFailed', this.now, this.createId),
          drawId,
          reason,
        });
        return { confirmed: false, reason };
      }

      if (
        expectedWinnerEntryIds &&
        (expectedWinnerEntryIds.length !== winners.length ||
          expectedWinnerEntryIds.some((entryId, index) => entryId !== winners[index].entryId))
      ) {
        const reason = 'Fairness search verification did not match the actual draw entry';
        await this.finalizeClaimedReservation(drawId, {
          ...createBaseEvent('drawFailed', this.now, this.createId),
          drawId,
          reason,
        });
        return { confirmed: false, reason };
      }

      if (
        expectedWinnerParticipantIds &&
        (expectedWinnerParticipantIds.length !== winners.length ||
          expectedWinnerParticipantIds.some(
            (participantId, index) =>
              winners[index].members.length !== 1 || participantId !== winners[index].members[0].participantId
          ))
      ) {
        const reason = 'Fairness search verification did not match the actual run';
        await this.finalizeClaimedReservation(drawId, {
          ...createBaseEvent('drawFailed', this.now, this.createId),
          drawId,
          reason,
        });
        return { confirmed: false, reason };
      }

      if (
        expectedWinnerMarbleIds &&
        (expectedWinnerMarbleIds.length !== winners.length ||
          expectedWinnerMarbleIds.some((marbleId, index) => marbleId !== winners[index].marbleId))
      ) {
        const reason = 'Fairness search verification did not match the actual marble result';
        await this.finalizeClaimedReservation(drawId, {
          ...createBaseEvent('drawFailed', this.now, this.createId),
          drawId,
          reason,
        });
        return { confirmed: false, reason };
      }

      await this.finalizeClaimedReservation(drawId, {
        ...createBaseEvent('drawConfirmed', this.now, this.createId),
        drawId,
        winners,
      });
      this.invalidateSearchState();
      return { confirmed: true };
    });
  }

  async cancelDraw(drawId: string, reason = 'Fairness draw was cancelled'): Promise<void> {
    await this.ensureLoaded();
    if (!this.available) return;
    await this.enqueueMutation(async () => {
      const draw = this.projection.draws.find((candidate) => candidate.id === drawId);
      if (!draw || draw.status !== 'prepared') return;
      await this.finalizeClaimedReservation(drawId, {
        ...createBaseEvent('drawCancelled', this.now, this.createId),
        drawId,
        reason,
      });
    });
  }

  /**
   * Record an ordinary draw without applying the strict policy. This is kept
   * off the start path's critical section so fairness storage failures cannot
   * prevent the legacy roulette from starting.
   */
  async prepareUnconstrainedDraw(request: FairnessStartRequest): Promise<FairnessPreparedDraw | null> {
    await this.ensureLoaded();
    if (!this.available) return null;
    // Keep participant synchronization and the ordinary prepared event in a
    // single origin-serialized operation. Otherwise another tab could append
    // a policy event between the snapshot and this draw's durable record.
    await this.mutationQueue;
    return this.withDurableStateMutation('unconstrained-draw', async () => {
      const syncedInputs = await this.syncCurrentParticipants(
        true,
        request.participantInputs,
        undefined,
        this.enabled || this.events.length > 0,
        undefined,
        true
      );

      const setup = getSimulationParticipantSetup(request.participantInputs);
      if (!setup || setup.totalCount <= 0 || setup.totalCount > MAX_MARBLES) return null;
      const mappingRows = syncedInputs.map((input) => ({ entryId: input.entryId, count: input.count }));
      const preparedEvent = this.createPreparedEvent(
        request,
        request.currentSeed,
        syncedInputs,
        mappingRows,
        setup.totalCount,
        this.createId('draw'),
        false
      );
      await this.enqueueMutation(async () => {
        await this.appendEventDirect(preparedEvent);
      });
      return {
        drawId: preparedEvent.drawId,
        key: '',
        generation: this.searchGeneration,
        seed: preparedEvent.seed,
        event: clone(preparedEvent),
        expectedWinnerEntryIds: null,
        expectedWinnerParticipantIds: null,
        expectedWinnerMarbleIds: null,
        operationToken: 0,
      };
    });
  }

  private parseJson(value: string): unknown {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error('Fairness import is not valid JSON');
    }
  }

  private async collectRecoverableReservations(): Promise<RecoveryReservation[]> {
    const loadReservations = this.store.loadReservations;
    if (!loadReservations) return [];
    const [events, reservations] = await Promise.all([
      this.store.load(this.activeProfileId),
      loadReservations.call(this.store, this.activeProfileId),
    ]);
    const preparedEventsByDrawId = new Map<string, FairnessDrawPreparedEvent>();
    const terminalDrawIds = new Set<string>();
    events.forEach((event) => {
      if (event.type === 'drawPrepared') preparedEventsByDrawId.set(event.drawId, event);
      if (
        event.type === 'drawConfirmed' ||
        event.type === 'drawFailed' ||
        event.type === 'drawCancelled' ||
        event.type === 'drawVoided'
      ) {
        terminalDrawIds.add(event.drawId);
      }
    });

    const recoveries: RecoveryReservation[] = [];
    reservations.forEach((rawReservation) => {
      const reservation: DurableFairnessReservation = {
        ...rawReservation,
        state: rawReservation.state ?? 'ready',
        rulesetVersion: rawReservation.rulesetVersion ?? 0,
        draft: rawReservation.draft,
      };
      if (terminalDrawIds.has(reservation.drawId)) {
        this.scheduleTerminalReservationDiscard(reservation);
        return;
      }
      const draftValid =
        isPreparedDrawDraft(reservation.draft) && reservation.draft.seed === reservation.seed;
      const preparedEvent = preparedEventsByDrawId.get(reservation.drawId);
      if (draftValid && (preparedEvent || reservation.state === 'claimed')) {
        recoveries.push({
          reservation,
          preparedEvent: preparedEvent ? null : this.createPreparedEventFromDraft(reservation.drawId, reservation.draft),
        });
        return;
      }
      if (reservation.state === 'ready') {
        this.scheduleReadyReservationDiscard(reservation);
      }
    });
    return recoveries;
  }

  /**
   * The caller must hold the origin Fairness lock. Re-read both stores while
   * holding it because the snapshot that identified a recovery candidate can
   * become terminal while another tab is waiting for this lock.
   */
  private async recoverReservationsWhileOwned(recoveryReservations: readonly RecoveryReservation[]): Promise<void> {
    if (recoveryReservations.length === 0) return;
    const recoveryEvents = await this.store.load(this.activeProfileId);
    const recoveryPreparedEvents = new Map<string, FairnessDrawPreparedEvent>();
    const recoveryTerminalDrawIds = new Set<string>();
    recoveryEvents.forEach((event) => {
      if (event.type === 'drawPrepared') recoveryPreparedEvents.set(event.drawId, event);
      if (
        event.type === 'drawConfirmed' ||
        event.type === 'drawFailed' ||
        event.type === 'drawCancelled' ||
        event.type === 'drawVoided'
      ) {
        recoveryTerminalDrawIds.add(event.drawId);
      }
    });
    const currentReservations = this.store.loadReservations
      ? await this.store.loadReservations(this.activeProfileId)
      : [];
    const currentReservationsById = new Map(
      currentReservations.map((reservation) => [reservation.reservationId, reservation])
    );

    for (const recovery of recoveryReservations) {
      const currentReservation = currentReservationsById.get(recovery.reservation.reservationId);
      if (recoveryTerminalDrawIds.has(recovery.reservation.drawId)) {
        if (currentReservation) this.scheduleTerminalReservationDiscard(currentReservation);
        continue;
      }
      const persistedPreparedEvent = recoveryPreparedEvents.get(recovery.reservation.drawId);
      const draftValid =
        currentReservation &&
        isPreparedDrawDraft(currentReservation.draft) &&
        currentReservation.draft.seed === currentReservation.seed;
      const preparedIdentityValid =
        !persistedPreparedEvent ||
        (currentReservation !== undefined && persistedPreparedEvent.seed === currentReservation.seed);
      const recoveryStateValid =
        currentReservation?.state === 'claimed'
          ? Boolean(draftValid)
          : currentReservation?.state === 'ready' &&
            Boolean(persistedPreparedEvent) &&
            Boolean(draftValid);
      if (
        !currentReservation ||
        !sameReservationIdentityValues(currentReservation, recovery.reservation) ||
        !preparedIdentityValid ||
        !recoveryStateValid
      ) {
        this.recordDiagnostic('reservation.recovery-stale', {
          reservationId: recovery.reservation.reservationId,
          drawId: recovery.reservation.drawId,
          state: currentReservation?.state ?? 'missing',
        });
        continue;
      }

      const terminalEvent: FairnessDrawCancelledEvent = {
        ...createBaseEvent('drawCancelled', this.now, this.createId),
        drawId: currentReservation.drawId,
        reason: 'Fairness draw was interrupted before confirmation',
      };
      const preparedEvent = persistedPreparedEvent
        ? null
        : this.createPreparedEventFromDraft(currentReservation.drawId, currentReservation.draft);
      this.recordDiagnostic('reservation.interrupted-recovery', {
        reservationId: currentReservation.reservationId,
        drawId: currentReservation.drawId,
        key: currentReservation.key,
        state: currentReservation.state,
        preparedEventPersisted: Boolean(persistedPreparedEvent),
      });
      const recoverClaimedReservation = this.store.recoverClaimedReservation;
      try {
        if (recoverClaimedReservation) {
          await recoverClaimedReservation.call(
            this.store,
            currentReservation.reservationId,
            preparedEvent,
            terminalEvent,
            getReservationIdentity(currentReservation)
          );
        } else {
          if (preparedEvent) await this.store.append(preparedEvent, this.activeProfileId);
          await this.store.append(terminalEvent, this.activeProfileId);
          await this.store.removeReservation?.(currentReservation.reservationId);
        }
      } catch (error) {
        this.markUnavailable(error);
        throw error;
      }
      const localPreparedEvent = this.events.some(
        (event) => event.type === 'drawPrepared' && event.drawId === terminalEvent.drawId
      )
        ? null
        : (persistedPreparedEvent ?? preparedEvent);
      this.applyAlreadyPersistedEvents(
        localPreparedEvent ? [localPreparedEvent, terminalEvent] : [terminalEvent],
        1
      );
    }
  }

  private async recoverClaimedReservationsWhileOwned(): Promise<void> {
    const loadReservations = this.store.loadReservations;
    if (!loadReservations) return;

    // The normal prepared-start path has no claimed reservation to recover.
    // Avoid a second full event-log read in that steady state; a claimed
    // record is the only cross-document recovery signal that can appear after
    // the freshness read taken immediately before this check. Legacy
    // drawPrepared + ready records are also covered when their draw is already
    // present in this tab's fresh projection.
    const reservations = await loadReservations.call(this.store, this.activeProfileId);
    const hasQuarantinedClaimedReservations = this.store.hasQuarantinedClaimedReservations
      ? await this.store.hasQuarantinedClaimedReservations()
      : false;
    const preparedDrawIds = new Set(
      this.events
        .filter((event): event is FairnessDrawPreparedEvent => event.type === 'drawPrepared')
        .map((event) => event.drawId)
    );
    const needsRecovery = reservations.some((reservation) => {
      const state = reservation.state ?? 'ready';
      return state === 'claimed' || (state === 'ready' && preparedDrawIds.has(reservation.drawId));
    });
    if (!needsRecovery) {
      // The owner may have finalized the draw after this tab marked itself
      // busy. Clear that cached busy state once the recovery lock is held,
      // while still quarantining any malformed claimed record.
      this.foreignActiveDraw =
        hasQuarantinedClaimedReservations ||
        reservations.some((reservation) => (reservation.state ?? 'ready') === 'claimed');
      return;
    }
    await this.recoverReservationsWhileOwned(await this.collectRecoverableReservations());
    const remaining = await loadReservations.call(this.store, this.activeProfileId);
    const remainingHasQuarantinedClaimedReservations = this.store.hasQuarantinedClaimedReservations
      ? await this.store.hasQuarantinedClaimedReservations()
      : false;
    this.foreignActiveDraw =
      remainingHasQuarantinedClaimedReservations ||
      remaining.some((reservation) => (reservation.state ?? 'ready') === 'claimed');
  }

  private async ensureProfiles(): Promise<void> {
    const loadProfiles = this.store.loadProfiles;
    if (!loadProfiles) {
      this.profiles = [
        {
          id: DEFAULT_FAIRNESS_PROFILE_ID,
          name: DEFAULT_FAIRNESS_PROFILE_NAME,
          createdAt: 0,
          updatedAt: 0,
        },
      ];
      this.activeProfileId = DEFAULT_FAIRNESS_PROFILE_ID;
      return;
    }
    let profiles = await loadProfiles.call(this.store);
    if (profiles.length === 0) {
      const profile: FairnessProfile = {
        id: DEFAULT_FAIRNESS_PROFILE_ID,
        name: DEFAULT_FAIRNESS_PROFILE_NAME,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      await this.store.saveProfile?.(profile);
      profiles = [profile];
    }
    this.profiles = profiles.map((profile) => ({ ...profile }));
    if (!this.profiles.some((profile) => profile.id === this.activeProfileId)) {
      this.activeProfileId = this.profiles[0].id;
      writeSessionStorage(FAIRNESS_ACTIVE_PROFILE_STORAGE_KEY, this.activeProfileId);
    }
  }

  private async refreshProfiles(): Promise<boolean> {
    if (!this.store.loadProfiles) return false;
    const next = (await this.store.loadProfiles()).map((profile) => ({ ...profile }));
    const changed =
      next.length !== this.profiles.length ||
      next.some((profile, index) => {
        const current = this.profiles[index];
        return (
          !current ||
          current.id !== profile.id ||
          current.name !== profile.name ||
          current.updatedAt !== profile.updatedAt
        );
      });
    if (changed) this.profiles = next;
    return changed;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      try {
        await this.ensureProfiles();
        const [{ events, historyStamp }, reservations] = await Promise.all([
          this.loadDurableHistorySnapshot(),
          this.store.loadReservations
            ? this.store.loadReservations(this.activeProfileId)
            : Promise.resolve([]),
        ]);
        const hasQuarantinedClaimedReservations = this.store.hasQuarantinedClaimedReservations
          ? await this.store.hasQuarantinedClaimedReservations()
          : false;
        this.events = events.map((event) => clone(event));
        this.projection = projectFairnessEvents(this.events);
        this.manualRenames = collectManualRenameBindings(this.events);
        this.historyFingerprint = getHistoryFingerprint(this.events);
        this.historyStamp = historyStamp;
        this.durableReservations.clear();
        const preparedEventsByDrawId = new Map<string, FairnessDrawPreparedEvent>();
        const terminalDrawIds = new Set<string>();
        this.events.forEach((event) => {
          if (event.type === 'drawPrepared') preparedEventsByDrawId.set(event.drawId, event);
          if (
            event.type === 'drawConfirmed' ||
            event.type === 'drawFailed' ||
            event.type === 'drawCancelled' ||
            event.type === 'drawVoided'
          ) {
            terminalDrawIds.add(event.drawId);
          }
        });
        const orphanReservationIds: string[] = [];
        const terminalOrphanReservationIds: string[] = [];
        const recoveryReservations: RecoveryReservation[] = [];
        const recoveryKeys = new Set<string>();
        const reservationsByKey = new Map<string, DurableFairnessReservation>();
        this.foreignActiveDraw = hasQuarantinedClaimedReservations;
        reservations.forEach((rawReservation) => {
          const normalizedState = rawReservation.state === undefined ? 'ready' : rawReservation.state;
          const normalizedRulesetVersion = rawReservation.rulesetVersion ?? 0;
          const reservation: DurableFairnessReservation = {
            ...rawReservation,
            state: normalizedState,
            rulesetVersion: normalizedRulesetVersion,
            draft: rawReservation.draft,
          };
          if (normalizedState !== 'ready' && normalizedState !== 'claimed') {
            orphanReservationIds.push(reservation.reservationId);
            return;
          }
          const persistedPreparedEvent = preparedEventsByDrawId.get(reservation.drawId);
          if (terminalDrawIds.has(reservation.drawId)) {
            terminalOrphanReservationIds.push(reservation.reservationId);
            return;
          }
          const draftValid =
            isPreparedDrawDraft(reservation.draft) && reservation.draft.seed === reservation.seed;
          if (reservation.state === 'claimed') {
            this.foreignActiveDraw = true;
            if (!draftValid) {
              // Never delete a malformed claimed record on a local snapshot:
              // it may still be owned by another live document. Keep it
              // quarantined until an explicit recovery can validate it.
              this.recordDiagnostic('reservation.recovery-quarantined', {
                reservationId: reservation.reservationId,
                drawId: reservation.drawId,
              });
              return;
            }
            if (reservation.rulesetVersion !== FAIRNESS_SIMULATION_RULESET_VERSION) {
              this.recordDiagnostic('reservation.ruleset-stale', {
                reservationId: reservation.reservationId,
                key: reservation.key,
                rulesetVersion: reservation.rulesetVersion,
                expectedRulesetVersion: FAIRNESS_SIMULATION_RULESET_VERSION,
              });
            }
            recoveryReservations.push({
              reservation,
              preparedEvent: persistedPreparedEvent
                ? null
                : this.createPreparedEventFromDraft(reservation.drawId, reservation.draft),
            });
            recoveryKeys.add(reservation.key);
            return;
          }
          if (persistedPreparedEvent && draftValid) {
            this.foreignActiveDraw = true;
            recoveryReservations.push({
              reservation,
              preparedEvent: null,
            });
            recoveryKeys.add(reservation.key);
            return;
          }
          if (!draftValid || reservation.rulesetVersion !== FAIRNESS_SIMULATION_RULESET_VERSION) {
            if (reservation.rulesetVersion !== FAIRNESS_SIMULATION_RULESET_VERSION) {
              this.recordDiagnostic('reservation.ruleset-stale', {
                reservationId: reservation.reservationId,
                key: reservation.key,
                rulesetVersion: reservation.rulesetVersion,
                expectedRulesetVersion: FAIRNESS_SIMULATION_RULESET_VERSION,
              });
            }
            orphanReservationIds.push(reservation.reservationId);
            return;
          }
          const normalized = reservation;
          const existing = reservationsByKey.get(normalized.key);
          if (!existing) {
            reservationsByKey.set(normalized.key, normalized);
            return;
          }
          const keep = existing.reservationId.localeCompare(normalized.reservationId) <= 0 ? existing : normalized;
          const discard = keep === existing ? normalized : existing;
          reservationsByKey.set(normalized.key, keep);
          orphanReservationIds.push(discard.reservationId);
          this.recordDiagnostic('reservation.duplicate-discard', {
            key: normalized.key,
            keptReservationId: keep.reservationId,
            discardedReservationId: discard.reservationId,
          });
        });
        reservationsByKey.forEach((reservation) => {
          if (recoveryKeys.has(reservation.key)) {
            orphanReservationIds.push(reservation.reservationId);
            return;
          }
          this.durableReservations.set(reservation.reservationId, reservation);
        });
        const recoveryOwnership = recoveryReservations.length
          ? await this.acquireFairnessDrawOwnership('interrupted-recovery', {
              reservationCount: recoveryReservations.length,
            })
          : null;
        try {
          if (recoveryOwnership) await this.recoverReservationsWhileOwned(recoveryReservations);
        } finally {
          await this.releaseFairnessDrawOwnership(recoveryOwnership ?? undefined, 'interrupted-recovery', {
            reservationCount: recoveryReservations.length,
          });
        }
        if (recoveryReservations.length > 0 && !recoveryOwnership) {
          this.scheduleInterruptedRecoveryRetry();
        } else if (recoveryOwnership) {
          // Recovery may have left a quarantined claimed record behind (for
          // example, a malformed legacy record). Re-read the authoritative
          // store before declaring this document free of foreign ownership.
          const remainingReservations = this.store.loadReservations
            ? await this.store.loadReservations(this.activeProfileId)
            : [];
          const remainingHasQuarantinedClaimedReservations = this.store.hasQuarantinedClaimedReservations
            ? await this.store.hasQuarantinedClaimedReservations()
            : false;
          this.foreignActiveDraw =
            remainingHasQuarantinedClaimedReservations ||
            remainingReservations.some((reservation) => (reservation.state ?? 'ready') === 'claimed');
        }
        orphanReservationIds.forEach((reservationId) => {
          const reservation = reservations.find((candidate) => candidate.reservationId === reservationId);
          if (reservation) this.scheduleReadyReservationDiscard(reservation);
        });
        terminalOrphanReservationIds.forEach((reservationId) => {
          const reservation = reservations.find((candidate) => candidate.reservationId === reservationId);
          if (reservation) this.scheduleTerminalReservationDiscard(reservation);
        });
        this.available = true;
        this.error = null;
      } catch (error) {
        this.markUnavailable(error);
        throw error;
      } finally {
        this.loaded = true;
        this.loadingPromise = null;
      }
    })();
    return this.loadingPromise;
  }

  private async ensureOperational(): Promise<void> {
    await this.ensureLoaded();
    if (!this.available || !this.enabled) throw new Error(this.error ?? 'Fairness is not enabled');
  }

  private async ensureEpoch(): Promise<void> {
    if (this.projection.currentEpochId) return;
    const base = createBaseEvent('epochStarted', this.now, this.createId);
    await this.appendEventDirect({ ...base, epochId: this.createId('epoch') });
  }

  private async syncCurrentParticipants(
    force = false,
    inputs: readonly string[] = this.currentInputs,
    token?: number,
    parseGroups = this.enabled || this.events.length > 0,
    generation?: number,
    durableStateOwned = false
  ): Promise<SyncedEntry[]> {
    if (!force && !this.enabled) return [];
    await this.ensureLoaded();
    if (!this.available) throw new Error(this.error ?? DEFAULT_RECENT_ERROR);
    if (generation !== undefined) this.assertSearchCurrent(generation);
    const rows = parseFairnessEntries(inputs, parseGroups);

    const operation = () =>
      this.enqueueMutation(async () => {
        if (generation !== undefined) this.assertSearchCurrent(generation);
        if (token !== undefined) this.assertCurrent(token);
        if (!force && !this.enabled) return [];
        await this.ensureEpoch();
        const syncedInputs = await this.syncCurrentParticipantsNow(rows, token, generation);
        this.error = null;
        if (generation !== undefined) this.assertSearchCurrent(generation);
        if (token !== undefined) this.assertCurrent(token);
        return syncedInputs;
      });
    return durableStateOwned ? operation() : this.withDurableStateMutation('participant-sync', operation);
  }

  private async syncCurrentParticipantsNow(
    rows: readonly ParsedFairnessEntry[],
    token?: number,
    generation?: number
  ): Promise<SyncedEntry[]> {
    const previousMemberNames: string[][] = [];
    let previousRowIndex = 0;
    for (const rawInput of this.boundInputs) {
      const parsed = parseName(rawInput);
      if (!parsed) continue;
      const binding = this.inputBindings[previousRowIndex] ?? [];
      const names = binding.length > 1 ? parseFairnessEntryName(parsed.name) : [parsed.name];
      previousMemberNames.push(names && names.length === binding.length ? names : []);
      previousRowIndex++;
    }
    const previousMemberBindings = new Map<string, string>();
    previousMemberNames.forEach((names, rowIndex) => {
      names.forEach((name, memberIndex) => {
        const participantId = this.inputBindings[rowIndex]?.[memberIndex];
        const nameKey = participantNameKey(name);
        if (participantId && !previousMemberBindings.has(nameKey)) previousMemberBindings.set(nameKey, participantId);
      });
    });
    const currentMemberNames = new Set<string>();
    rows.forEach((row) => row.memberNames.forEach((name) => currentMemberNames.add(participantNameKey(name))));
    const usedIds = new Set<string>();
    const nextBindings: Array<readonly string[] | null> = [];
    const syncedInputs: SyncedEntry[] = [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      if (generation !== undefined) this.assertSearchCurrent(generation);
      if (token !== undefined) this.assertCurrent(token);
      const row = rows[rowIndex];
      const priorBinding = this.inputBindings[rowIndex];
      const boundMembers = priorBinding ?? [];
      const memberIds: string[] = [];
      for (let memberIndex = 0; memberIndex < row.memberNames.length; memberIndex++) {
        const memberName = row.memberNames[memberIndex];
        const priorId = boundMembers[memberIndex];
        const priorMemberName = previousMemberNames[rowIndex]?.[memberIndex];
        const priorMemberCount = previousMemberNames[rowIndex]?.length ?? 0;
        const boundParticipant = priorId
          ? this.projection.participants.find((candidate) => candidate.id === priorId && !usedIds.has(candidate.id))
          : undefined;
        const memberNameKey = participantNameKey(memberName);
        const previousTokenId = previousMemberBindings.get(memberNameKey);
        const previousTokenParticipant = previousTokenId
          ? this.projection.participants.find((candidate) => candidate.id === previousTokenId)
          : undefined;
        const nameMatches = this.projection.participants.filter(
          (candidate) =>
            participantNameKey(candidate.displayName) === memberNameKey ||
            participantNameKey(this.manualRenames.get(candidate.id) ?? '') === memberNameKey
        );
        if (nameMatches.length > 1) {
          throw new Error('Fairness member name is ambiguous');
        }
        const namedParticipant = nameMatches.find(
          (candidate) => participantNameKey(candidate.displayName) === memberNameKey
        );
        const pinnedParticipant = this.projection.participants.find(
          (candidate) => participantNameKey(this.manualRenames.get(candidate.id) ?? '') === memberNameKey
        );
        if (
          [namedParticipant, pinnedParticipant].some(
            (candidate) => candidate !== undefined && usedIds.has(candidate.id)
          )
        ) {
          throw new Error('Fairness member cannot appear in multiple draw entries');
        }
        const isPinnedRename =
          boundParticipant && participantNameKey(this.manualRenames.get(boundParticipant.id) ?? '') === memberNameKey;
        let participant =
          namedParticipant ??
          pinnedParticipant ??
          nameMatches[0] ??
          previousTokenParticipant ??
          (boundParticipant &&
          priorMemberCount === row.memberNames.length &&
          (!priorMemberName || !currentMemberNames.has(participantNameKey(priorMemberName)))
            ? boundParticipant
            : undefined);

        if (isPinnedRename && boundParticipant) participant = boundParticipant;

        if (!participant) {
          const participantId = this.createId('participant');
          const base = createBaseEvent('participantDiscovered', this.now, this.createId);
          await this.appendEventDirect({
            ...base,
            participantId,
            displayName: memberName,
            active: true,
            excluded: false,
          });
          participant = this.projection.participants.find((candidate) => candidate.id === participantId);
        }
        if (!participant) throw new Error('Fairness participant discovery failed');
        if (usedIds.has(participant.id)) throw new Error('Fairness member cannot appear in multiple draw entries');

        usedIds.add(participant.id);
        memberIds.push(participant.id);
        const latestParticipant = this.projection.participants.find((candidate) => candidate.id === participant.id);
        const manualRename = this.manualRenames.get(participant.id);
        if (latestParticipant && latestParticipant.displayName !== memberName && manualRename !== memberName) {
          this.manualRenames.set(latestParticipant.id, memberName);
          const base = createBaseEvent('participantRenamed', this.now, this.createId);
          await this.appendEventDirect({
            ...base,
            participantId: latestParticipant.id,
            displayName: memberName,
            rawInput: memberName,
          });
        }
      }
      nextBindings[rowIndex] = memberIds;
      syncedInputs.push({
        entryId: `entry-${rowIndex}`,
        memberIds,
        rawInput: row.rawInput,
        displayName: row.displayName,
        weight: row.weight,
        count: row.count,
      });
    }

    if (generation !== undefined) this.assertSearchCurrent(generation);
    this.inputBindings = nextBindings;
    this.boundInputs = rows.map((row) => row.rawInput);
    return syncedInputs;
  }

  private async createSearchContext(
    request: FairnessStartRequest,
    token?: number,
    generation = this.searchGeneration
  ): Promise<FairnessSearchContext> {
    await this.ensureOperational();
    if (
      this.cachedContext &&
      this.cachedContext.generation === generation &&
      sameSearchRequest(this.cachedContext.request, request)
    ) {
      if (token !== undefined) this.assertCurrent(token);
      return this.cachedContext;
    }
    this.assertSearchCurrent(generation);
    if (token !== undefined) this.assertCurrent(token);

    const syncedInputs = await this.syncCurrentParticipants(
      true,
      request.participantInputs,
      token,
      undefined,
      generation
    );
    if (sameStrings(this.currentInputs, request.participantInputs)) this.participantInputsDirty = false;
    this.assertSearchCurrent(generation);
    if (token !== undefined) this.assertCurrent(token);

    const setup = getSimulationParticipantSetup(request.participantInputs);
    if (!setup || setup.totalCount <= 0 || setup.totalCount > MAX_MARBLES) {
      throw new Error(`Fairness participant count must be between 1 and ${MAX_MARBLES}`);
    }
    if (request.winnerRange.start !== request.winnerRange.end) {
      throw new Error('Cumulative fairness supports one winning rank at a time');
    }

    const policyInputs = new Map(
      this.projection.participants.map((participant) => [
        participant.id,
        {
          id: participant.id,
          active: participant.active,
          excluded: participant.excluded,
          effectiveBalance: participant.effectiveBalance,
        },
      ])
    );
    const entryPolicyInputs = syncedInputs.map((entry) => ({
      id: entry.entryId,
      members: entry.memberIds.map((memberId) => policyInputs.get(memberId)).filter((member) => member !== undefined),
    }));
    const evaluation = evaluateStrictBalanceEntries(entryPolicyInputs);
    if (evaluation.eligibleEntryIds.length === 0) throw new Error('Fairness has no eligible draw entries');

    const mappingRows = syncedInputs.map((input) => ({ entryId: input.entryId, count: input.count }));
    const spawnLayout = getMarbleSpawnLayout(setup.totalCount, request.stage.spawn);
    const budget = searchBudget(setup.totalCount, Math.max(1, mappingRows.length), evaluation.eligibleEntryIds.length);
    const key = createFairnessSearchKey(
      request,
      this.activeProfileId,
      setup.participants,
      syncedInputs,
      this.projection,
      evaluation.eligibleEntryIds,
      budget,
      this.headlessStepLimit
    );
    const legacyKey =
      this.activeProfileId === DEFAULT_FAIRNESS_PROFILE_ID
        ? createFairnessSearchKey(
            request,
            undefined,
            setup.participants,
            syncedInputs,
            this.projection,
            evaluation.eligibleEntryIds,
            budget,
            this.headlessStepLimit
          )
        : undefined;

    const context = {
      request,
      syncedInputs,
      participants: setup.participants,
      totalCount: setup.totalCount,
      spawnPositions: spawnLayout.positions,
      mappingRows,
      eligibleEntryIds: evaluation.eligibleEntryIds,
      budget,
      key,
      ...(legacyKey ? { legacyKey } : {}),
      planId: `fairness-plan-${generation}`,
      generation,
      mustSearch: !canUseStrictBalanceEntryFastPath(evaluation),
    };
    this.cachedContext = context;
    return context;
  }

  private createPreparedDrawDraft(
    request: FairnessStartRequest,
    seed: Seed,
    syncedInputs: readonly SyncedEntry[],
    mappingRows: readonly Readonly<{ entryId: string; count: number }>[],
    totalCount: number,
    fairnessEnabledAtDraw: boolean
  ): PreparedDrawDraft {
    const mapping = mapMarbleIdsToEntries(seed, mappingRows);
    const memberIds: string[] = [];
    const seenMemberIds = new Set<string>();
    syncedInputs.forEach((input) => {
      input.memberIds.forEach((memberId) => {
        if (seenMemberIds.has(memberId)) return;
        seenMemberIds.add(memberId);
        memberIds.push(memberId);
      });
    });
    const participantById = new Map(this.projection.participants.map((participant) => [participant.id, participant]));
    const includedMemberIds = new Set(memberIds);
    const snapshotMemberIds = [
      ...memberIds,
      ...this.projection.participants
        .map((participant) => participant.id)
        .filter((participantId) => !includedMemberIds.has(participantId)),
    ];
    const marbleIdsByEntryId = new Map<string, number[]>();
    mapping.forEach((entryId, marbleId) => {
      const marbleIds = marbleIdsByEntryId.get(entryId) ?? [];
      marbleIds.push(marbleId);
      marbleIdsByEntryId.set(entryId, marbleIds);
    });
    const members: FairnessMemberSnapshot[] = snapshotMemberIds.map((memberId) => {
      const participant = participantById.get(memberId);
      if (!participant) throw new Error('Fairness participant mapping is unavailable');
      return {
        participantId: memberId,
        displayName: participant.displayName,
        active: participant.active,
        excluded: participant.excluded,
        // `included` describes participation in this physical draw. It is
        // intentionally independent from the persistent roster `active`
        // flag: an inactive roster member can still appear in the roulette
        // input, while an active member may be absent from this draw.
        included: includedMemberIds.has(memberId),
        effectiveBalance: participant.effectiveBalance,
      };
    });
    const entries: FairnessDrawEntrySnapshot[] = syncedInputs.map((input) => ({
      entryId: input.entryId,
      displayName: input.displayName,
      rawInput: input.rawInput,
      memberIds: [...input.memberIds],
      weight: input.weight,
      count: input.count,
      marbleIds: marbleIdsByEntryId.get(input.entryId) ?? [],
    }));

    if (entries.reduce((total, entry) => total + entry.count, 0) !== totalCount) {
      throw new Error('Fairness participant snapshot count does not match the simulation');
    }

    return {
      epochId: this.projection.currentEpochId ?? this.createId('epoch'),
      seed,
      mapIndex: request.mapIndex,
      mapTitle: request.stage.title,
      rawParticipantInputs: [...request.participantInputs],
      winnerRange: { ...request.winnerRange },
      skillsEnabled: request.skillsEnabled,
      fairnessEnabledAtDraw,
      policy: {
        id: STRICT_BALANCE_POLICY_ID,
        version: STRICT_BALANCE_POLICY_VERSION,
      },
      members,
      entries,
    };
  }

  private createPreparedEventFromDraft(drawId: string, draft: PreparedDrawDraft): FairnessDrawPreparedEvent {
    return {
      ...createBaseEvent('drawPrepared', this.now, this.createId),
      ...draft,
      drawId,
    };
  }

  private getOrCreatePreparedDrawDraft(context: FairnessSearchContext, seed: Seed): PreparedDrawDraft {
    const cached = this.cachedPreparedDraft;
    if (cached && cached.key === context.key && cached.generation === context.generation && cached.seed === seed) {
      return cached.draft;
    }
    const draft = this.createPreparedDrawDraft(
      context.request,
      seed,
      context.syncedInputs,
      context.mappingRows,
      context.totalCount,
      true
    );
    this.cachedPreparedDraft = { key: context.key, generation: context.generation, seed, draft };
    return draft;
  }

  private createPreparedEvent(
    request: FairnessStartRequest,
    seed: Seed,
    syncedInputs: readonly SyncedEntry[],
    mappingRows: readonly Readonly<{ entryId: string; count: number }>[],
    totalCount: number,
    drawId: string,
    fairnessEnabledAtDraw: boolean
  ): FairnessDrawPreparedEvent {
    return this.createPreparedEventFromDraft(
      drawId,
      this.createPreparedDrawDraft(request, seed, syncedInputs, mappingRows, totalCount, fairnessEnabledAtDraw)
    );
  }

  private findDurableReservation(
    context: FairnessSearchContext,
    requestedSeed: Seed,
    allowPersistedReservationSeed = false
  ): DurableFairnessReservation | null {
    let persistedSeedFallback: DurableFairnessReservation | null = null;
    for (const reservation of this.durableReservations.values()) {
      if (reservation.key !== context.key && reservation.key !== context.legacyKey) continue;
      if (context.mustSearch || reservation.seed === requestedSeed) return reservation;
      if (allowPersistedReservationSeed && persistedSeedFallback === null) {
        persistedSeedFallback = reservation;
      }
    }
    return persistedSeedFallback;
  }

  private findCachedPreparedReservation(
    request: FairnessStartRequest,
    token: number
  ): { context: FairnessSearchContext; reservation: DurableFairnessReservation } | null {
    if (!this.loaded || !this.available || !this.enabled) return null;
    const context = this.cachedContext;
    if (
      !context ||
      context.generation !== this.searchGeneration ||
      !sameSearchRequest(context.request, request)
    ) {
      return null;
    }
    this.assertCurrent(token);
    const reservation = this.findDurableReservation(
      context,
      getRequestedRoundSeed(request),
      request.allowPersistedReservationSeed === true
    );
    return reservation ? { context, reservation } : null;
  }

  private materializeCachedPreparedDraw(
    cachedReservation: { context: FairnessSearchContext; reservation: DurableFairnessReservation },
    token: number,
    includeEvent: boolean,
    ownership?: FairnessDrawOwnership
  ): FairnessPreparedDraw {
    return this.materializePreparedDraw(
      cachedReservation.context,
      cachedReservation.reservation,
      token,
      includeEvent,
      ownership
    );
  }

  private async cancelClaimedReservationBeforeStart(
    context: FairnessSearchContext,
    reservation: DurableFairnessReservation,
    ownership: FairnessDrawOwnership
  ): Promise<void> {
    const preparedEvent = this.createPreparedEventFromDraft(reservation.drawId, reservation.draft);
    const terminalEvent: FairnessDrawCancelledEvent = {
      ...createBaseEvent('drawCancelled', this.now, this.createId),
      drawId: reservation.drawId,
      reason: 'Fairness draw was cancelled before start',
    };
    let finalized = false;
    try {
      const finalizeReservation = this.store.finalizeReservation;
      const recoverClaimedReservation = this.store.recoverClaimedReservation;
      if (finalizeReservation) {
        await finalizeReservation.call(
          this.store,
          reservation.reservationId,
          preparedEvent,
          terminalEvent,
          getReservationIdentity(reservation)
        );
      } else if (recoverClaimedReservation) {
        await recoverClaimedReservation.call(
          this.store,
          reservation.reservationId,
          preparedEvent,
          terminalEvent,
          getReservationIdentity(reservation)
        );
      } else {
        throw new Error('Fairness reservation cancellation is unavailable');
      }
      finalized = true;
      await this.enqueueMutation(async () => {
        const preparedInstalled = this.events.some(
          (event) => event.type === 'drawPrepared' && event.drawId === terminalEvent.drawId
        );
        // A cancellation can observe invalidation after ready -> claimed but
        // before materialization. Apply the prepared snapshot in that narrow
        // case; normal cached Start has already installed it and only needs
        // the terminal event.
        this.applyAlreadyPersistedEvents(
          preparedInstalled ? [terminalEvent] : [preparedEvent, terminalEvent]
        );
      });
    } catch (error) {
      this.markUnavailable(error);
      throw error;
    } finally {
      // This operation owns the claim even when the terminal transaction
      // fails. Keep the durable claimed record for later crash recovery, but
      // never leave this tab's lock or in-memory ownership stuck forever.
      this.claimedReservations.delete(reservation.drawId);
      await this.releaseFairnessDrawOwnership(ownership, 'cancel-before-start', {
        drawId: reservation.drawId,
        reservationId: reservation.reservationId,
        finalized,
      });
    }
    this.recordDiagnostic('reservation.cancelled-before-start', {
      generation: context.generation,
      key: context.key,
      seed: reservation.seed,
      reservationId: reservation.reservationId,
    });
  }

  private claimCachedPreparedDraw(
    cachedReservation: { context: FairnessSearchContext; reservation: DurableFairnessReservation },
    token: number,
    includeEvent: boolean
  ): Promise<FairnessPreparedDraw> {
    const claimReservation = this.store.claimReservation;
    if (!claimReservation) {
      return Promise.resolve(this.materializeCachedPreparedDraw(cachedReservation, token, includeEvent));
    }

    const { context, reservation } = cachedReservation;
    return (async () => {
      const ownership = await this.acquireFairnessDrawOwnership('start', {
        key: context.key,
        generation: context.generation,
        seed: reservation.seed,
        reservationId: reservation.reservationId,
      });
      if (!ownership) throw new FairnessCancelledError();

      // The cache belongs to this tab, while the event log is shared by every
      // tab. Re-check the durable history while the draw lock is held, before
      // changing ready -> claimed. A stale tab must cancel and refresh rather
      // than claiming a reservation prepared from an older projection.
      try {
        if (await this.refreshDurableHistoryIfStale()) {
          await this.releaseFairnessDrawOwnership(ownership, 'stale-state', {
            key: context.key,
            generation: context.generation,
            reservationId: reservation.reservationId,
          });
          throw new FairnessStaleStateError();
        }
        await this.recoverClaimedReservationsWhileOwned();
      } catch (error) {
        if (error instanceof FairnessStaleStateError) throw error;
        await this.releaseFairnessDrawOwnership(ownership, 'freshness-failed', {
          key: context.key,
          generation: context.generation,
          reservationId: reservation.reservationId,
        });
        throw error;
      }

      let status: Awaited<ReturnType<NonNullable<typeof claimReservation>>>;
      try {
        status = await claimReservation.call(this.store, reservation.reservationId, getReservationIdentity(reservation));
      } catch (error) {
        await this.releaseFairnessDrawOwnership(ownership, 'claim-failed', {
          key: context.key,
          generation: context.generation,
          reservationId: reservation.reservationId,
        });
        if (isCancellationError(error)) throw error;
        this.markUnavailable(error);
        throw error;
      }

      if (status !== 'claimed') {
        await this.releaseFairnessDrawOwnership(ownership, 'claim-conflict', {
          generation: context.generation,
          key: context.key,
          seed: reservation.seed,
          reservationId: reservation.reservationId,
          status,
        });
        this.durableReservations.delete(reservation.reservationId);
        this.recordDiagnostic('reservation.claim-conflict', {
          generation: context.generation,
          key: context.key,
          seed: reservation.seed,
          reservationId: reservation.reservationId,
          status,
        });
        throw new FairnessCancelledError();
      }
      this.durableReservations.delete(reservation.reservationId);
      // Publish the private ready -> claimed transition immediately. Peers
      // must stop treating this reservation as reusable while the active draw
      // continues to hold the long-lived origin lock.
      this.broadcastStateChanged();
      try {
        this.assertSearchCurrent(context.generation);
        this.assertCurrent(token);
        return this.materializeCachedPreparedDraw(cachedReservation, token, includeEvent, ownership);
      } catch (error) {
        // The claim is already durable. Whether invalidation or a
        // materialization error caused the failure, this operation is the
        // owner and must terminalize the pre-start draw before releasing the
        // origin lock; otherwise a claimed record can linger until reload.
        await this.cancelClaimedReservationBeforeStart(context, reservation, ownership).catch(() => undefined);
        throw error;
      }
    })();
  }

  private createPrecomputedPlan(
    context: Pick<FairnessSearchContext, 'key' | 'generation'>,
    fallbackSeed: Seed,
    reservation: DurableFairnessReservation | null
  ): FairnessPrecomputedPlan {
    return {
      key: context.key,
      generation: context.generation,
      seed: reservation?.seed ?? fallbackSeed,
      ...(reservation ? { reservationId: reservation.reservationId } : {}),
    };
  }

  /**
   * Reservation maps are tab-local, so a second tab must re-check the
   * persistent store while it owns the short reservation-write lock. This
   * prevents two tabs that prepared from the same projection from creating
   * different ready reservations for one logical search key.
   */
  private async findPersistedReservationForWrite(
    context: FairnessSearchContext,
    requestedSeed: Seed,
    candidateSeed: Seed
  ): Promise<DurableFairnessReservation | null> {
    const loadReservations = this.store.loadReservations;
    if (!loadReservations) return null;
    const sameKey: DurableFairnessReservation[] = [];
    const records = await loadReservations.call(this.store, this.activeProfileId);
    records
      .filter((record) => record.key === context.key || record.key === context.legacyKey)
      .sort((left, right) => left.reservationId.localeCompare(right.reservationId))
      .forEach((record) => {
        const reservation: DurableFairnessReservation = {
          ...record,
          state: record.state ?? 'ready',
          rulesetVersion: record.rulesetVersion ?? 0,
          draft: record.draft,
        };
        if (
          reservation.state !== 'ready' ||
          reservation.rulesetVersion !== FAIRNESS_SIMULATION_RULESET_VERSION ||
          !isPreparedDrawDraft(reservation.draft) ||
          reservation.draft.seed !== reservation.seed
        ) {
          if (reservation.state === 'ready') this.scheduleReadyReservationDiscard(reservation);
          return;
        }
        sameKey.push(reservation);
      });

    const reusable = context.mustSearch
      ? sameKey
      : sameKey.filter((reservation) => reservation.seed === candidateSeed && reservation.seed === requestedSeed);
    const canonical = reusable[0];
    if (canonical) {
      sameKey.forEach((reservation) => {
        if (reservation.reservationId !== canonical.reservationId) this.scheduleReadyReservationDiscard(reservation);
      });
      this.durableReservations.set(canonical.reservationId, canonical);
      return canonical;
    }

    // A strict fast-path seed is physical identity. Any old same-key ready
    // reservation with another seed is stale for this requested round, but it
    // is still removed conditionally so a concurrent claim remains protected.
    if (!context.mustSearch) sameKey.forEach((reservation) => this.scheduleReadyReservationDiscard(reservation));
    return null;
  }

  private async ensureDurableReservation(
    context: FairnessSearchContext,
    result: Pick<SearchCandidate, 'seed' | 'winnerMarbleIds' | 'winnerEntryIds' | 'draft'>
  ): Promise<DurableFairnessReservation | null> {
    const reserve = this.store.reserve;
    if (!reserve || !this.store.discardReadyReservation) return null;
    this.assertSearchCurrent(context.generation);

    const requestedSeed = getRequestedRoundSeed(context.request);
    const identity = context.mustSearch
      ? `${context.generation}:${context.key}`
      : `${context.generation}:${context.key}:${typeof result.seed}:${String(result.seed)}`;
    const pending = this.reservationWrites.get(identity);
    if (pending) return pending;

    const existing = this.findDurableReservation(context, requestedSeed);
    if (existing && (context.mustSearch || existing.seed === result.seed)) return existing;

    // A strict fast-path reservation is tied to the physical seed of this
    // logical round. If that seed changed (for example after an explicit
    // Shuffle), remove the older same-policy reservation instead of leaving
    // two physical rounds eligible for a later claim.
    if (!context.mustSearch) {
      [...this.durableReservations.values()]
        .filter(
          (candidate) =>
            (candidate.key === context.key || candidate.key === context.legacyKey) && candidate.seed !== result.seed
        )
        .forEach((candidate) => {
          this.durableReservations.delete(candidate.reservationId);
          this.scheduleReadyReservationDiscard(candidate);
        });
    }

    const reservation: DurableFairnessReservation = {
      profileId: this.activeProfileId,
      reservationId: this.createId('reservation'),
      drawId: this.createId('draw'),
      key: context.key,
      seed: result.seed,
      winnerMarbleIds: [...result.winnerMarbleIds],
      winnerEntryIds: [...result.winnerEntryIds],
      rulesetVersion: FAIRNESS_SIMULATION_RULESET_VERSION,
      state: 'ready',
      draft: result.draft,
    };
    this.recordDiagnostic('reservation.start', {
      generation: context.generation,
      key: context.key,
      seed: result.seed,
      reservationId: reservation.reservationId,
    });
    const write = (async () => {
      const ownership = await this.acquireFairnessDrawOwnership('reservation-write', {
        generation: context.generation,
        key: context.key,
        seed: result.seed,
        reservationId: reservation.reservationId,
      });
      if (!ownership) throw new FairnessCancelledError();
      try {
        if (await this.refreshDurableHistoryIfStale()) throw new FairnessStaleStateError();
        await this.recoverClaimedReservationsWhileOwned();
        this.assertSearchCurrent(context.generation);
        const persisted = await this.findPersistedReservationForWrite(context, requestedSeed, result.seed);
        if (persisted) return persisted;
        await reserve.call(this.store, reservation);
      } catch (error) {
        if (!isCancellationError(error)) this.markUnavailable(error);
        throw error;
      } finally {
        await this.releaseFairnessDrawOwnership(ownership, 'reservation-write', {
          generation: context.generation,
          key: context.key,
          reservationId: reservation.reservationId,
        });
      }
      try {
        this.assertSearchCurrent(context.generation);
      } catch (error) {
        this.scheduleReadyReservationDiscard(reservation);
        throw error;
      }
      this.durableReservations.set(reservation.reservationId, reservation);
      // Reservation state is private to the control plane, so publish it to
      // peers without emitting a same-document public state refresh. It does
      // not advance the event-log history stamp.
      this.broadcastStateChanged();
      this.recordDiagnostic('reservation.ready', {
        generation: context.generation,
        key: context.key,
        seed: result.seed,
        reservationId: reservation.reservationId,
      });
      return reservation;
    })();
    this.reservationWrites.set(identity, write);
    void write.then(
      () => {
        if (this.reservationWrites.get(identity) === write) this.reservationWrites.delete(identity);
      },
      () => {
        if (this.reservationWrites.get(identity) === write) this.reservationWrites.delete(identity);
      }
    );
    return write;
  }

  private claimDurableReservation(
    context: FairnessSearchContext,
    reservation: DurableFairnessReservation,
    token: number,
    includeEvent = true,
    ownership?: FairnessDrawOwnership
  ): FairnessPreparedDraw {
    this.assertSearchCurrent(context.generation);
    this.assertCurrent(token);
    const event = this.createPreparedEventFromDraft(reservation.drawId, reservation.draft);
    // The draft is coordinator-owned and never exposed. Keep the event object
    // as the in-memory history record and only clone the public return value;
    // this removes a second full snapshot copy from the prepared Start path.
    this.events.push(event);
    this.projection = applyFairnessEvent(this.projection, event, { reusePreparedSnapshotArrays: true });
    this.durableReservations.delete(reservation.reservationId);
    this.claimedReservations.set(event.drawId, {
      reservationId: reservation.reservationId,
      identity: getReservationIdentity(reservation),
      event,
      persisted: false,
      ...(ownership ? { ownership } : {}),
    });
    const winningEntryId = reservation.winnerEntryIds[context.request.winnerRange.end];
    const winningEntry = context.syncedInputs.find((entry) => entry.entryId === winningEntryId);
    const expectedWinnerEntryIds = winningEntryId === undefined ? null : [winningEntryId];
    const expectedWinnerParticipantIds = winningEntry?.memberIds.length === 1 ? [winningEntry.memberIds[0]] : null;
    const winningMarbleId = reservation.winnerMarbleIds[context.request.winnerRange.end];
    const expectedWinnerMarbleIds = winningMarbleId === undefined ? null : [winningMarbleId];
    this.recordDiagnostic('reservation.claim', {
      generation: context.generation,
      key: context.key,
      seed: reservation.seed,
      reservationId: reservation.reservationId,
    });
    return {
      drawId: event.drawId,
      key: context.key,
      generation: context.generation,
      reservationId: reservation.reservationId,
      seed: reservation.seed,
      event: includeEvent ? clone(event) : event,
      expectedWinnerEntryIds,
      expectedWinnerParticipantIds,
      expectedWinnerMarbleIds,
      operationToken: token,
    };
  }

  private async finalizeClaimedReservation(
    drawId: string,
    terminalEvent: FairnessReservationTerminalEvent
  ): Promise<void> {
    const claimed = this.claimedReservations.get(drawId);
    if (!claimed) {
      await this.finalizeUnclaimedDraw(drawId, terminalEvent);
      return;
    }

    const finalizeReservation = this.store.finalizeReservation;
    if (finalizeReservation) {
      this.recordDiagnostic('draw.finalize.start', {
        drawId,
        reservationId: claimed.reservationId,
      });
      try {
        await finalizeReservation.call(
          this.store,
          claimed.reservationId,
          claimed.event,
          terminalEvent,
          claimed.identity
        );
      } catch (error) {
        // The transaction is all-or-nothing. If it failed, the durable
        // claimed record remains available for a later interrupted recovery,
        // but this document must not retain a lock that can block the origin
        // forever.
        this.claimedReservations.delete(drawId);
        await this.releaseFairnessDrawOwnership(claimed.ownership, 'finalize-failed', {
          drawId,
          reservationId: claimed.reservationId,
        });
        this.markUnavailable(error);
        throw error;
      }
      try {
        this.applyAlreadyPersistedEvents([terminalEvent]);
      } finally {
        claimed.persisted = true;
        this.claimedReservations.delete(drawId);
        await this.releaseFairnessDrawOwnership(claimed.ownership, 'finalize', {
          drawId,
          reservationId: claimed.reservationId,
        });
      }
      this.recordDiagnostic('draw.finalize.ready', {
        drawId,
        reservationId: claimed.reservationId,
      });
      return;
    }

    let finalized = false;
    try {
      if (!claimed.persisted) {
        await this.store.append(claimed.event, this.activeProfileId);
        claimed.persisted = true;
      }
      await this.appendEventDirect(terminalEvent);
      await this.store.removeReservation?.(claimed.reservationId);
      finalized = true;
    } catch (error) {
      this.markUnavailable(error);
      throw error;
    } finally {
      // The fallback is retained for injected/legacy stores. Release local
      // ownership after any attempted terminalization so a storage failure
      // cannot strand this document's origin lock.
      this.claimedReservations.delete(drawId);
      await this.releaseFairnessDrawOwnership(claimed.ownership, finalized ? 'finalize' : 'finalize-failed', {
        drawId,
        reservationId: claimed.reservationId,
        finalized,
      });
    }
  }

  /**
   * A terminal callback can arrive after another document has finalized the
   * same prepared draw. Re-check the durable history while holding the origin
   * lock before appending a non-reservation terminal event, rather than
   * trusting this document's possibly stale projection.
   */
  private async finalizeUnclaimedDraw(
    drawId: string,
    terminalEvent: FairnessReservationTerminalEvent
  ): Promise<void> {
    const ownership = await this.acquireFairnessDrawOwnership('draw-finalize', { drawId });
    if (!ownership) throw new FairnessStateBusyError();
    try {
      this.recordDiagnostic('draw.finalize.start', { drawId });
      await this.refreshDurableHistoryIfStale();
      const draw = this.projection.draws.find((candidate) => candidate.id === drawId);
      if (!draw || draw.status !== 'prepared') return;
      await this.appendEventDirect(terminalEvent);
      this.recordDiagnostic('draw.finalize.ready', { drawId });
    } finally {
      await this.releaseFairnessDrawOwnership(ownership, 'finalize', { drawId });
    }
  }

  private materializePreparedDraw(
    context: FairnessSearchContext,
    reservation: DurableFairnessReservation,
    token: number,
    includeEvent = true,
    ownership?: FairnessDrawOwnership
  ): FairnessPreparedDraw {
    return this.claimDurableReservation(context, reservation, token, includeEvent, ownership);
  }

  private ensureSearch(context: FairnessSearchContext, token?: number): Promise<SearchCandidate> {
    this.assertSearchCurrent(context.generation);
    if (token !== undefined) this.assertCurrent(token);

    if (this.cachedCandidate?.key === context.key && this.cachedCandidate.generation === context.generation) {
      this.recordDiagnostic('search.cache-hit', { generation: context.generation, key: context.key });
      return Promise.resolve(this.cachedCandidate);
    }

    if (this.inFlightSearch?.key === context.key && this.inFlightSearch.generation === context.generation) {
      this.recordDiagnostic('search.join', { generation: context.generation, key: context.key });
      return this.inFlightSearch.promise;
    }

    const controller = new AbortController();
    this.recordDiagnostic('search.start', {
      generation: context.generation,
      key: context.key,
      budget: context.budget,
    });
    const promise = this.searchForWinner(context, token, controller.signal).then(
      (result) => {
        this.recordDiagnostic('search.complete', {
          generation: context.generation,
          key: context.key,
          seed: result.seed,
        });
        return {
          ...result,
          key: context.key,
          generation: context.generation,
          draft: this.createPreparedDrawDraft(
            context.request,
            result.seed,
            context.syncedInputs,
            context.mappingRows,
            context.totalCount,
            true
          ),
        };
      },
      (error: unknown) => {
        this.recordDiagnostic('search.end', {
          generation: context.generation,
          key: context.key,
          cancelled: isCancellationError(error),
        });
        throw error;
      }
    );
    const work: SearchWork = { key: context.key, generation: context.generation, controller, promise };
    this.inFlightSearch = work;
    void promise
      .then((result) => {
        if (
          this.inFlightSearch === work &&
          this.searchGeneration === context.generation &&
          !controller.signal.aborted
        ) {
          this.cachedCandidate = result;
        }
      })
      .catch(() => undefined)
      .then(
        () => {
          if (this.inFlightSearch === work) this.inFlightSearch = null;
        },
        () => {
          if (this.inFlightSearch === work) this.inFlightSearch = null;
        }
      );
    return promise;
  }

  private consumeCandidate(context: FairnessSearchContext): void {
    if (this.cachedCandidate?.key === context.key && this.cachedCandidate.generation === context.generation) {
      this.cachedCandidate = null;
    }
  }

  private async searchForWinner(
    context: FairnessSearchContext,
    token: number | undefined,
    signal: AbortSignal
  ): Promise<SearchResult> {
    if (this.useWorkerPool) {
      const workerPool = await this.getWorkerPool();
      if (workerPool) return this.searchForWinnerParallel(context, token, signal, workerPool);
    }
    return this.searchForWinnerSerial(context, token, signal);
  }

  private createHeadlessRequest(context: FairnessSearchContext, seed: Seed): FairnessHeadlessSearchRequest {
    return {
      seed,
      stage: context.request.stage,
      participants: context.participants,
      totalCount: context.totalCount,
      spawnPositions: context.spawnPositions,
      skillsEnabled: context.request.skillsEnabled,
      targetRank: context.request.winnerRange.end,
    };
  }

  private findEligibleSearchResult(
    context: FairnessSearchContext,
    seed: Seed,
    winnerMarbleIds: readonly number[],
    eligible: ReadonlySet<string>
  ): SearchResult | null {
    const mapping = mapMarbleIdsToEntries(seed, context.mappingRows);
    const winnerEntryIds = winnerMarbleIds.map((marbleId) => mapping.get(marbleId));
    const winnerId = winnerEntryIds[context.request.winnerRange.end];
    if (!winnerId || !eligible.has(winnerId)) return null;
    return {
      seed,
      winnerMarbleIds: winnerMarbleIds.slice(),
      winnerEntryIds: winnerEntryIds.filter((id): id is string => id !== undefined),
    };
  }

  private async searchForWinnerParallel(
    context: FairnessSearchContext,
    token: number | undefined,
    signal: AbortSignal,
    workerPool: FairnessWorkerPoolLike
  ): Promise<SearchResult> {
    if (context.budget <= 0) throw new Error('Fairness search has no valid budget');

    let planId: string | null = null;
    if (workerPool.configurePlan && workerPool.runPlan) {
      try {
        planId = await workerPool.configurePlan({
          planId: context.planId,
          generation: context.generation,
          stage: context.request.stage,
          participants: context.participants,
          totalCount: context.totalCount,
          spawnPositions: context.spawnPositions,
          skillsEnabled: context.request.skillsEnabled,
          targetRank: context.request.winnerRange.end,
        } satisfies FairnessWorkerPlan);
        if (signal.aborted) throw new FairnessCancelledError();
      } catch (error) {
        if (signal.aborted || isCancellationError(error)) throw new FairnessCancelledError();
        this.workerPoolDisabled = true;
        return this.searchForWinnerSerial(context, token, signal);
      }
    }

    const eligible = new Set(context.eligibleEntryIds);
    const maxParallelism =
      Number.isSafeInteger(workerPool.concurrency) && workerPool.concurrency > 0 ? workerPool.concurrency : 1;
    let lastReportedParallelism = 0;
    const getReadyParallelism = (): number => {
      const ready = workerPool.readyConcurrency;
      const parallelism =
        typeof ready !== 'number' || !Number.isSafeInteger(ready)
          ? maxParallelism
          : Math.max(1, Math.min(maxParallelism, ready));
      if (parallelism !== lastReportedParallelism) {
        lastReportedParallelism = parallelism;
        this.recordDiagnostic('search.ready-concurrency', {
          generation: context.generation,
          key: context.key,
          readyConcurrency: parallelism,
        });
      }
      return parallelism;
    };
    const active = new Map<number, { seed: Seed; controller: AbortController; promise: Promise<void> }>();
    const completed = new Map<number, CompletedSearchAttempt>();
    let nextAttempt = 0;
    let nextCommit = 0;
    let lastError: unknown;
    let workerFailure: unknown | null = null;
    let readyWaitTarget = 0;
    let readyWait: Promise<void> | null = null;

    const startAttempt = (): void => {
      const attempt = nextAttempt++;
      const controller = new AbortController();
      const abortChild = () => controller.abort();
      signal.addEventListener('abort', abortChild, { once: true });
      const seed = this.createCandidateSeed();
      this.recordDiagnostic('search.attempt.start', {
        generation: context.generation,
        key: context.key,
        attempt,
        seed,
      });
      const cleanup = () => {
        signal.removeEventListener('abort', abortChild);
        active.delete(attempt);
      };
      const promise = Promise.resolve()
        .then(() => {
          if (planId !== null && workerPool.runPlan) {
            return workerPool.runPlan(planId, seed, {
              signal: controller.signal,
              stepLimit: this.headlessStepLimit,
              attemptIndex: attempt,
            });
          }
          return workerPool.run(this.createHeadlessRequest(context, seed), {
            signal: controller.signal,
            stepLimit: this.headlessStepLimit,
          });
        })
        .then((winnerMarbleIds) => {
          completed.set(attempt, { seed, winnerMarbleIds });
        })
        .catch((error: unknown) => {
          completed.set(attempt, { seed, error });
          if (isWorkerPoolUnavailableError(error)) workerFailure = error;
        })
        .then(cleanup, cleanup);
      active.set(attempt, { seed, controller, promise });
    };

    const abortActive = (): void => {
      active.forEach(({ controller }) => controller.abort());
    };

    const waitForActive = async (): Promise<void> => {
      while (active.size > 0) {
        await Promise.all([...active.values()].map(({ promise }) => promise));
      }
    };

    const fallbackToSerial = async (): Promise<SearchResult> => {
      this.workerPoolDisabled = true;
      abortActive();
      await waitForActive();
      return this.searchForWinnerSerialContinuation(
        context,
        token,
        signal,
        nextCommit,
        nextAttempt,
        completed,
        lastError
      );
    };

    const waitForAdditionalReadyWorker = (): Promise<void> | null => {
      const parallelism = getReadyParallelism();
      if (parallelism >= maxParallelism || !workerPool.waitForReadyConcurrency) return null;
      const target = parallelism + 1;
      if (readyWait && readyWaitTarget === target) return readyWait;

      readyWaitTarget = target;
      readyWait = workerPool.waitForReadyConcurrency(target, signal).then(
        () => {
          readyWait = null;
          readyWaitTarget = 0;
        },
        (error: unknown) => {
          readyWait = null;
          readyWaitTarget = 0;
          if (signal.aborted || isCancellationError(error)) return;
          if (isWorkerPoolUnavailableError(error)) workerFailure = error;
          else workerFailure = error instanceof Error ? error : new Error('Fairness worker readiness failed');
        }
      );
      return readyWait;
    };

    const commitCompleted = (): SearchResult | null => {
      while (nextCommit < nextAttempt) {
        const attempt = nextCommit;
        const result = completed.get(attempt);
        if (!result) break;
        if (result.error) {
          if (isWorkerPoolUnavailableError(result.error)) {
            workerFailure = result.error;
            break;
          }
          completed.delete(attempt);
          if (signal.aborted || isCancellationError(result.error)) {
            throw new FairnessCancelledError();
          }
          lastError = result.error;
          nextCommit++;
          continue;
        }

        completed.delete(attempt);
        const candidate = this.findEligibleSearchResult(context, result.seed, result.winnerMarbleIds ?? [], eligible);
        this.recordDiagnostic('search.attempt.commit', {
          generation: context.generation,
          key: context.key,
          attempt,
          seed: result.seed,
          eligible: candidate !== null,
        });
        nextCommit++;
        if (!candidate) continue;
        active.forEach(({ controller }, higherAttempt) => {
          if (higherAttempt > attempt) controller.abort();
        });
        return candidate;
      }
      return null;
    };

    while (true) {
      if (signal.aborted) throw new FairnessCancelledError();
      this.assertSearchCurrent(context.generation);
      if (token !== undefined) this.assertCurrent(token);

      const completedCandidate = commitCompleted();
      if (completedCandidate) return completedCandidate;
      if (workerFailure !== null) return fallbackToSerial();

      const parallelism = getReadyParallelism();
      while (nextAttempt - nextCommit < parallelism && nextAttempt < context.budget) startAttempt();
      if (workerFailure !== null) return fallbackToSerial();

      const synchronouslyCompletedCandidate = commitCompleted();
      if (synchronouslyCompletedCandidate) return synchronouslyCompletedCandidate;
      if (workerFailure !== null) return fallbackToSerial();
      if (active.size === 0) {
        if (nextCommit === nextAttempt) break;
        await yieldToHost();
        continue;
      }
      const readiness = waitForAdditionalReadyWorker();
      const waits = [...active.values()].map(({ promise }) => promise);
      if (readiness) waits.push(readiness);
      await Promise.race(waits);
      if (workerFailure !== null) return fallbackToSerial();
      if (signal.aborted) throw new FairnessCancelledError();
      await yieldToHost();
    }

    if (signal.aborted) throw new FairnessCancelledError();
    this.assertSearchCurrent(context.generation);
    if (token !== undefined) this.assertCurrent(token);
    const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
    throw new Error(`Fairness could not find an eligible winner within ${context.budget} attempts${detail}`);
  }

  private async searchForWinnerSerialContinuation(
    context: FairnessSearchContext,
    token: number | undefined,
    signal: AbortSignal,
    startAttempt: number,
    launchedAttempts: number,
    completed: ReadonlyMap<number, CompletedSearchAttempt>,
    initialError: unknown
  ): Promise<SearchResult> {
    const eligible = new Set(context.eligibleEntryIds);
    let lastError = initialError;

    const checkCurrent = (): void => {
      if (signal.aborted) throw new FairnessCancelledError();
      this.assertSearchCurrent(context.generation);
      if (token !== undefined) this.assertCurrent(token);
    };

    const evaluateOnMainThread = async (seed: Seed): Promise<SearchResult | null> => {
      checkCurrent();
      try {
        const winnerMarbleIds = await this.runMainThreadHeadless(this.createHeadlessRequest(context, seed), { signal });
        checkCurrent();
        return this.findEligibleSearchResult(context, seed, winnerMarbleIds, eligible);
      } catch (error) {
        if (isCancellationError(error) || signal.aborted) throw new FairnessCancelledError();
        lastError = error;
        return null;
      }
    };

    for (let attempt = startAttempt; attempt < launchedAttempts; attempt++) {
      checkCurrent();
      const result = completed.get(attempt);
      const seed = result?.seed;
      if (seed === undefined) throw new Error('Fairness search attempt state is unavailable');

      if (result?.error && !isWorkerPoolUnavailableError(result.error) && !isCancellationError(result.error)) {
        lastError = result.error;
        continue;
      }

      const candidate =
        result?.winnerMarbleIds !== undefined && !result.error
          ? this.findEligibleSearchResult(context, seed, result.winnerMarbleIds, eligible)
          : await evaluateOnMainThread(seed);
      this.recordDiagnostic('search.attempt.commit', {
        generation: context.generation,
        key: context.key,
        attempt,
        seed,
        eligible: candidate !== null,
        fallback: true,
      });
      if (candidate) return candidate;
      await yieldToHost();
    }

    for (let attempt = launchedAttempts; attempt < context.budget; attempt++) {
      checkCurrent();
      const seed = this.createCandidateSeed();
      this.recordDiagnostic('search.attempt.start', {
        generation: context.generation,
        key: context.key,
        attempt,
        seed,
        fallback: true,
      });
      const candidate = await evaluateOnMainThread(seed);
      this.recordDiagnostic('search.attempt.commit', {
        generation: context.generation,
        key: context.key,
        attempt,
        seed,
        eligible: candidate !== null,
        fallback: true,
      });
      if (candidate) return candidate;
      await yieldToHost();
    }

    checkCurrent();
    const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
    throw new Error(`Fairness could not find an eligible winner within ${context.budget} attempts${detail}`);
  }

  private async searchForWinnerSerial(
    context: FairnessSearchContext,
    token: number | undefined,
    signal: AbortSignal
  ): Promise<SearchResult> {
    if (context.budget <= 0) throw new Error('Fairness search has no valid budget');

    const eligible = new Set(context.eligibleEntryIds);
    let lastError: unknown;
    for (let attempt = 0; attempt < context.budget; attempt++) {
      if (signal.aborted) throw new FairnessCancelledError();
      this.assertSearchCurrent(context.generation);
      if (token !== undefined) this.assertCurrent(token);
      const seed = this.createCandidateSeed();
      this.recordDiagnostic('search.attempt.start', {
        generation: context.generation,
        key: context.key,
        attempt,
        seed,
      });
      let winnerMarbleIds: readonly number[];
      try {
        winnerMarbleIds = await this.headlessRunner(
          {
            seed,
            stage: context.request.stage,
            participants: context.participants,
            totalCount: context.totalCount,
            spawnPositions: context.spawnPositions,
            skillsEnabled: context.request.skillsEnabled,
            targetRank: context.request.winnerRange.end,
          },
          { signal }
        );
      } catch (error) {
        if (signal.aborted || isCancellationError(error)) throw new FairnessCancelledError();
        lastError = error;
        await yieldToHost();
        if (signal.aborted) throw new FairnessCancelledError();
        continue;
      }

      if (signal.aborted) throw new FairnessCancelledError();
      this.assertSearchCurrent(context.generation);
      if (token !== undefined) this.assertCurrent(token);
      const candidate = this.findEligibleSearchResult(context, seed, winnerMarbleIds, eligible);
      this.recordDiagnostic('search.attempt.commit', {
        generation: context.generation,
        key: context.key,
        attempt,
        seed,
        eligible: candidate !== null,
      });
      if (candidate) return candidate;
      await yieldToHost();
      if (signal.aborted) throw new FairnessCancelledError();
    }

    if (signal.aborted) throw new FairnessCancelledError();
    this.assertSearchCurrent(context.generation);
    if (token !== undefined) this.assertCurrent(token);
    const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
    throw new Error(`Fairness could not find an eligible winner within ${context.budget} attempts${detail}`);
  }

  private async recordFailedDraw(
    drawId: string,
    reason: string,
    preparedEvent: FairnessDrawPreparedEvent | null = null
  ): Promise<void> {
    if (!this.available) return;
    await this.enqueueMutation(async () => {
      if (this.claimedReservations.has(drawId)) {
        await this.finalizeClaimedReservation(drawId, {
          ...createBaseEvent('drawFailed', this.now, this.createId),
          drawId,
          reason,
        });
        return;
      }
      await this.recordStandaloneFailedDraw(drawId, reason, preparedEvent);
    });
  }

  /**
   * Failure reporting without an in-memory reservation must still re-check
   * the current durable projection under the origin lock. A peer may have
   * finalized the draw since this document last observed it as prepared.
   */
  private async recordStandaloneFailedDraw(
    drawId: string,
    reason: string,
    preparedEvent: FairnessDrawPreparedEvent | null
  ): Promise<void> {
    const ownership = await this.acquireFairnessDrawOwnership('draw-failure', { drawId });
    if (!ownership) throw new FairnessStateBusyError();
    try {
      await this.refreshDurableHistoryIfStale();
      let draw = this.projection.draws.find((candidate) => candidate.id === drawId);
      if (!draw && preparedEvent) {
        await this.appendEventDirect(preparedEvent);
        draw = this.projection.draws.find((candidate) => candidate.id === drawId);
      }
      if (draw && draw.status !== 'prepared') return;
      await this.appendEventDirect({ ...createBaseEvent('drawFailed', this.now, this.createId), drawId, reason });
    } finally {
      await this.releaseFairnessDrawOwnership(ownership, 'failure', { drawId });
    }
  }

  private assertCurrent(token: number): void {
    if (!this.isStartCurrent(token)) throw new FairnessCancelledError();
  }

  private async enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let result!: T;
    const current = previous.then(async () => {
      result = await operation();
    });
    this.mutationQueue = current.then(
      () => undefined,
      () => undefined
    );
    await current;
    return result;
  }

  private advanceHistoryStamp(): void {
    if (!this.historyStamp) return;
    this.historyStamp = {
      revision: this.historyStamp.revision + 1,
      eventCount: this.events.length,
      tailEventId: this.events[this.events.length - 1]?.eventId ?? null,
    };
  }

  private applyAlreadyPersistedEvents(events: readonly FairnessEvent[], historyRevisionIncrement = 1): void {
    let applied = false;
    for (const event of events) {
      if (this.events.some((existing) => existing.eventId === event.eventId)) continue;
      this.events.push(clone(event));
      this.projection = applyFairnessEvent(this.projection, event);
      applied = true;
    }
    if (!applied) return;
    this.historyFingerprint = getHistoryFingerprint(this.events);
    if (this.historyStamp) {
      this.historyStamp = {
        ...this.historyStamp,
        revision: this.historyStamp.revision + historyRevisionIncrement,
        eventCount: this.events.length,
        tailEventId: this.events[this.events.length - 1]?.eventId ?? null,
      };
    }
    this.markDurableStateChanged();
  }

  private async appendPreparedEventIfCurrent(
    context: Pick<FairnessSearchContext, 'generation'>,
    token: number,
    event: FairnessDrawPreparedEvent
  ): Promise<void> {
    // Search runs outside the origin lock. Re-check both the durable history
    // and the search generation after acquiring it, immediately before the
    // prepared event is written, so a stale tab cannot publish a draw based on
    // an obsolete projection.
    await this.withDurableStateMutation('draw-prepared', async () => {
      this.assertSearchCurrent(context.generation);
      this.assertCurrent(token);
      await this.appendEventDirect(event);
    });
  }

  private async appendEventDirect(event: FairnessEvent): Promise<void> {
    if (!this.available) throw new Error(this.error ?? DEFAULT_RECENT_ERROR);
    try {
      await this.store.append(event, this.activeProfileId);
    } catch (error) {
      this.markUnavailable(error);
      throw error;
    }
    this.events.push(clone(event));
    this.projection = applyFairnessEvent(this.projection, event);
    this.historyFingerprint = getHistoryFingerprint(this.events);
    this.advanceHistoryStamp();
    this.markDurableStateChanged();
  }

  private markUnavailable(error: unknown): void {
    this.available = false;
    this.enabled = false;
    this.error = getErrorMessage(error);
    writeLocalStorage(FAIRNESS_ENABLED_STORAGE_KEY, 'false');
  }
}

export { searchBudget };
