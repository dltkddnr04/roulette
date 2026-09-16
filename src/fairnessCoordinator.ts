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
  type FairnessReservationIdentity,
  type FairnessReservationRecord,
  type FairnessReservationTerminalEvent,
  IndexedDbFairnessStore,
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
import { readLocalStorage, writeLocalStorage } from './utils/storage';
import { parseName } from './utils/utils';

const FAIRNESS_ENABLED_STORAGE_KEY = 'mbr_fairness_enabled';
const FAIRNESS_MODE_STORAGE_KEY = 'mbr_fairness_mode';

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
  event: FairnessDrawPreparedEvent;
  persisted: boolean;
};

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
    reservationId: reservation.reservationId,
    drawId: reservation.drawId,
    key: reservation.key,
    seed: reservation.seed,
    rulesetVersion: reservation.rulesetVersion,
  };
}

const FAIRNESS_PRECOMPUTE_DEBOUNCE_MS = 150;

export class FairnessCancelledError extends Error {
  constructor() {
    super('Fairness start was cancelled');
    this.name = 'FairnessCancelledError';
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
  participants: readonly MarbleParticipant[],
  syncedInputs: readonly SyncedEntry[],
  projection: FairnessProjection,
  eligibleEntryIds: readonly string[],
  budget: number,
  headlessStepLimit: number
): string {
  return JSON.stringify({
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

  private events: FairnessEvent[] = [];
  private projection: FairnessProjection = projectFairnessEvents([]);
  private currentInputs: string[] = [];
  private boundInputs: string[] = [];
  private inputBindings: Array<readonly string[] | null> = [];
  private manualRenames = new Map<string, string>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private pendingExclusionRequests = new Map<string, boolean>();
  private pendingRenameRequests = new Map<string, string>();
  private loadingPromise: Promise<void> | null = null;
  private loaded = false;
  private available = false;
  private enabled: boolean;
  private mode: FairnessMode;
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
  }

  getFairnessEnabled(): boolean {
    return this.enabled;
  }

  getMode(): FairnessMode {
    return this.mode;
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
    const generation = this.searchGeneration;
    this.recordDiagnostic('precompute.start', { generation });
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

  private scheduleReadyReservationDiscard(reservation: FairnessReservationRecord): void {
    const discardReadyReservation = this.store.discardReadyReservation;
    if (!discardReadyReservation) return;
    void discardReadyReservation
      .call(this.store, reservation.reservationId, getReservationIdentity(reservation))
      .catch(() => undefined);
  }

  private invalidateSearchState(): void {
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
    staleReservations.forEach((reservation) => this.scheduleReadyReservationDiscard(reservation));
    if (this.configuredWorkerPool) {
      this.configuredWorkerPool.dropPlan?.(stalePlanId);
    } else {
      void this.workerPoolPromise?.then((workerPool) => workerPool?.dropPlan?.(stalePlanId));
    }
  }

  private assertSearchCurrent(generation: number): void {
    if (generation !== this.searchGeneration) throw new FairnessCancelledError();
  }

  setCurrentParticipantInputs(inputs: readonly string[], suppressSync = false, skipInvalidation = false): void {
    const nextInputs = [...inputs];
    const changed = !sameStrings(this.currentInputs, nextInputs);
    this.currentInputs = nextInputs;
    if (!suppressSync && changed && !skipInvalidation) this.invalidateStart();
    if (!this.enabled || suppressSync) return;

    if (!changed) return;

    const generation = this.searchGeneration;

    void this.syncCurrentParticipants(
      false,
      this.currentInputs,
      undefined,
      this.enabled || this.events.length > 0,
      generation
    ).catch((error) => {
      if (error instanceof FairnessCancelledError) return;
      if (isFairnessInputError(error)) this.error = getErrorMessage(error);
      else this.markUnavailable(error);
    });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.enabled && this.available) return;
    if (!enabled) {
      this.invalidateSearchState();
      this.enabled = false;
      writeLocalStorage(FAIRNESS_ENABLED_STORAGE_KEY, 'false');
      return;
    }

    try {
      this.invalidateSearchState();
      await this.ensureLoaded();
      this.available = true;
      this.error = null;
      this.enabled = true;
      const generation = this.searchGeneration;
      await this.syncCurrentParticipants(false, this.currentInputs, undefined, true, generation);
      this.warmWorkerPool();
      writeLocalStorage(FAIRNESS_ENABLED_STORAGE_KEY, 'true');
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
    this.mode = mode;
    writeLocalStorage(FAIRNESS_MODE_STORAGE_KEY, mode);
  }

  async getState(): Promise<FairnessState> {
    try {
      await this.ensureLoaded();
      await this.mutationQueue;
    } catch (error) {
      this.markUnavailable(error);
    }
    return createFairnessState(this.projection, {
      available: this.available,
      enabled: this.enabled && this.available,
      mode: this.mode,
      error: this.error,
    });
  }

  async setParticipantExcluded(participantId: string, excluded: boolean): Promise<void> {
    this.pendingExclusionRequests.set(participantId, excluded);
    this.invalidateStart();
    try {
      await this.enqueueMutation(async () => {
        let participant = this.projection.participants.find((candidate) => candidate.id === participantId);
        if (participant?.excluded === excluded) return;
        await this.ensureOperational();
        participant = this.projection.participants.find((candidate) => candidate.id === participantId);
        if (!participant) throw new Error('Fairness participant was not found');
        if (participant.excluded === excluded) return;
        await this.ensureEpoch();
        const base = createBaseEvent('participantExclusionChanged', this.now, this.createId);
        await this.appendEvent({ ...base, participantId, excluded });
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
      await this.enqueueMutation(async () => {
        let participant = this.projection.participants.find((candidate) => candidate.id === participantId);
        if (participant?.displayName === trimmedName) return;
        await this.ensureOperational();
        participant = this.projection.participants.find((candidate) => candidate.id === participantId);
        if (!participant) throw new Error('Fairness participant was not found');
        if (participant.displayName === trimmedName) return;
        await this.ensureEpoch();
        const boundIndex = this.inputBindings.findIndex((binding) => binding?.includes(participantId));
        const memberIndex = boundIndex >= 0 ? (this.inputBindings[boundIndex]?.indexOf(participantId) ?? -1) : -1;
        const parsed = boundIndex >= 0 ? parseName(this.boundInputs[boundIndex]) : null;
        const memberNames = parsed ? parseFairnessEntryName(parsed.name) : null;
        const rawInput = memberIndex >= 0 && memberNames ? memberNames[memberIndex] : undefined;
        if (rawInput !== undefined) this.manualRenames.set(participantId, rawInput);
        const base = createBaseEvent('participantRenamed', this.now, this.createId);
        await this.appendEvent({ ...base, participantId, displayName: trimmedName, ...(rawInput ? { rawInput } : {}) });
      });
    } finally {
      if (this.pendingRenameRequests.get(participantId) === trimmedName) {
        this.pendingRenameRequests.delete(participantId);
      }
    }
  }

  async startNewEpoch(): Promise<void> {
    this.invalidateStart();
    await this.ensureOperational();
    await this.syncCurrentParticipants();
    await this.enqueueMutation(async () => {
      const base = createBaseEvent('epochStarted', this.now, this.createId);
      await this.appendEvent({ ...base, epochId: this.createId('epoch') });
    });
  }

  async voidDraw(drawId: string): Promise<void> {
    await this.ensureLoaded();
    if (!this.available) throw new Error(this.error ?? DEFAULT_RECENT_ERROR);
    const current = this.projection.draws.find((candidate) => candidate.id === drawId);
    if (!current) throw new Error('Fairness draw was not found');
    if (current.status === 'voided') return;
    if (current.status !== 'confirmed') throw new Error('Only a confirmed fairness draw can be voided');
    this.invalidateStart();
    await this.enqueueMutation(async () => {
      const draw = this.projection.draws.find((candidate) => candidate.id === drawId);
      if (!draw || draw.status === 'voided') return;
      if (draw.status !== 'confirmed') throw new Error('Only a confirmed fairness draw can be voided');
      const base = createBaseEvent('drawVoided', this.now, this.createId);
      await this.appendEvent({ ...base, drawId, reason: 'Voided by user' });
    });
  }

  async exportData(): Promise<FairnessExport> {
    await this.ensureLoaded();
    return createFairnessExport(this.events, this.mode);
  }

  async importData(value: unknown): Promise<void> {
    this.invalidateStart();
    const data = validateFairnessExport(typeof value === 'string' ? this.parseJson(value) : value);
    await this.ensureLoaded();
    if (!this.available) throw new Error(this.error ?? DEFAULT_RECENT_ERROR);

    await this.enqueueMutation(async () => {
      try {
        await this.store.replace(data.events);
      } catch (error) {
        this.markUnavailable(error);
        throw error;
      }
      this.events = data.events.map((event) => clone(event));
      this.projection = projectFairnessEvents(this.events);
      this.inputBindings = [];
      this.boundInputs = [];
      this.manualRenames = collectManualRenameBindings(this.events);
      this.pendingExclusionRequests.clear();
      this.pendingRenameRequests.clear();
      this.durableReservations.clear();
      this.claimedReservations.clear();
      this.mode = data.mode;
      writeLocalStorage(FAIRNESS_MODE_STORAGE_KEY, this.mode);
    });
  }

  async clearData(): Promise<void> {
    this.invalidateStart();
    await this.ensureLoaded();
    if (!this.available) throw new Error(this.error ?? DEFAULT_RECENT_ERROR);
    await this.enqueueMutation(async () => {
      try {
        await this.store.clear();
      } catch (error) {
        this.markUnavailable(error);
        throw error;
      }
      this.events = [];
      this.projection = projectFairnessEvents([]);
      this.inputBindings = [];
      this.boundInputs = [];
      this.manualRenames.clear();
      this.pendingExclusionRequests.clear();
      this.pendingRenameRequests.clear();
      this.durableReservations.clear();
      this.claimedReservations.clear();
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
        await this.enqueueMutation(async () => {
          this.assertCurrent(token);
          await this.appendEvent(event);
        });
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
      await this.enqueueMutation(async () => {
        this.assertCurrent(token);
        await this.appendEvent(event);
      });
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
      await this.cancelDraw(drawId, 'Fairness draw was cancelled before confirmation');
      return { confirmed: false, reason: 'Fairness draw was cancelled' };
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
    const syncedInputs = await this.syncCurrentParticipants(
      true,
      request.participantInputs,
      undefined,
      this.enabled || this.events.length > 0
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
      await this.appendEvent(preparedEvent);
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
  }

  private parseJson(value: string): unknown {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error('Fairness import is not valid JSON');
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      try {
        const [events, reservations] = await Promise.all([
          this.store.load(),
          this.store.loadReservations ? this.store.loadReservations() : Promise.resolve([]),
        ]);
        this.events = events.map((event) => clone(event));
        this.projection = projectFairnessEvents(this.events);
        this.manualRenames = collectManualRenameBindings(this.events);
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
        const recoveryReservations: RecoveryReservation[] = [];
        const recoveryKeys = new Set<string>();
        const reservationsByKey = new Map<string, DurableFairnessReservation>();
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
          if (
            !isPreparedDrawDraft(reservation.draft) ||
            reservation.draft.seed !== reservation.seed ||
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
            orphanReservationIds.push(reservation.reservationId);
            return;
          }
          const persistedPreparedEvent = preparedEventsByDrawId.get(reservation.drawId);
          if (terminalDrawIds.has(reservation.drawId)) {
            orphanReservationIds.push(reservation.reservationId);
            return;
          }
          if (persistedPreparedEvent || reservation.state === 'claimed') {
            recoveryReservations.push({
              reservation,
              preparedEvent: persistedPreparedEvent ? null : this.createPreparedEventFromDraft(reservation.drawId, reservation.draft),
            });
            recoveryKeys.add(reservation.key);
            this.recordDiagnostic('reservation.interrupted-recovery', {
              reservationId: reservation.reservationId,
              drawId: reservation.drawId,
              key: reservation.key,
              state: reservation.state,
              preparedEventPersisted: Boolean(persistedPreparedEvent),
            });
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
        for (const recovery of recoveryReservations) {
          const terminalEvent: FairnessDrawCancelledEvent = {
            ...createBaseEvent('drawCancelled', this.now, this.createId),
            drawId: recovery.reservation.drawId,
            reason: 'Fairness draw was interrupted before confirmation',
          };
          const recoverClaimedReservation = this.store.recoverClaimedReservation;
          try {
            if (recoverClaimedReservation) {
              await recoverClaimedReservation.call(
                this.store,
                recovery.reservation.reservationId,
                recovery.preparedEvent,
                terminalEvent
              );
            } else {
              if (recovery.preparedEvent) await this.store.append(recovery.preparedEvent);
              await this.store.append(terminalEvent);
              await this.store.removeReservation?.(recovery.reservation.reservationId);
            }
          } catch (error) {
            this.markUnavailable(error);
            throw error;
          }
          this.applyAlreadyPersistedEvents(recovery.preparedEvent ? [recovery.preparedEvent, terminalEvent] : [terminalEvent]);
        }
        orphanReservationIds.forEach((reservationId) => {
          const reservation = reservations.find((candidate) => candidate.reservationId === reservationId);
          if (reservation) this.scheduleReadyReservationDiscard(reservation);
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
    await this.appendEvent({ ...base, epochId: this.createId('epoch') });
  }

  private async syncCurrentParticipants(
    force = false,
    inputs: readonly string[] = this.currentInputs,
    token?: number,
    parseGroups = this.enabled || this.events.length > 0,
    generation?: number
  ): Promise<SyncedEntry[]> {
    if (!force && !this.enabled) return [];
    await this.ensureLoaded();
    if (!this.available) throw new Error(this.error ?? DEFAULT_RECENT_ERROR);
    if (generation !== undefined) this.assertSearchCurrent(generation);
    const rows = parseFairnessEntries(inputs, parseGroups);

    return this.enqueueMutation(async () => {
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
        if (participantId && !previousMemberBindings.has(name)) previousMemberBindings.set(name, participantId);
      });
    });
    const currentMemberNames = new Set<string>();
    rows.forEach((row) => row.memberNames.forEach((name) => currentMemberNames.add(name)));
    const usedIds = new Set<string>();
    const nextBindings: Array<readonly string[] | null> = [];
    const currentIds = new Set<string>();
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
        const previousTokenId = previousMemberBindings.get(memberName);
        const previousTokenParticipant = previousTokenId
          ? this.projection.participants.find((candidate) => candidate.id === previousTokenId)
          : undefined;
        const namedParticipant = this.projection.participants.find((candidate) => candidate.displayName === memberName);
        const pinnedParticipant = this.projection.participants.find(
          (candidate) => this.manualRenames.get(candidate.id) === memberName
        );
        if (
          [namedParticipant, pinnedParticipant].some(
            (candidate) => candidate !== undefined && usedIds.has(candidate.id)
          )
        ) {
          throw new Error('Fairness member cannot appear in multiple draw entries');
        }
        const isPinnedRename = boundParticipant && this.manualRenames.get(boundParticipant.id) === memberName;
        let participant =
          namedParticipant ??
          pinnedParticipant ??
          previousTokenParticipant ??
          (boundParticipant &&
          priorMemberCount === row.memberNames.length &&
          (!priorMemberName || !currentMemberNames.has(priorMemberName))
            ? boundParticipant
            : undefined);

        if (isPinnedRename && boundParticipant) participant = boundParticipant;

        if (!participant) {
          const participantId = this.createId('participant');
          const base = createBaseEvent('participantDiscovered', this.now, this.createId);
          await this.appendEvent({
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
        currentIds.add(participant.id);
        memberIds.push(participant.id);
        if (!participant.active) {
          const base = createBaseEvent('participantParticipationChanged', this.now, this.createId);
          await this.appendEvent({ ...base, participantId: participant.id, active: true });
        }
        const latestParticipant = this.projection.participants.find((candidate) => candidate.id === participant.id);
        const manualRename = this.manualRenames.get(participant.id);
        if (latestParticipant && latestParticipant.displayName !== memberName && manualRename !== memberName) {
          this.manualRenames.set(latestParticipant.id, memberName);
          const base = createBaseEvent('participantRenamed', this.now, this.createId);
          await this.appendEvent({
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

    // Keep absence events sequential so each event is persisted and projected
    // before the next participant operation can observe the roster.
    for (const participant of this.projection.participants.slice()) {
      if (generation !== undefined) this.assertSearchCurrent(generation);
      if (token !== undefined) this.assertCurrent(token);
      if (!participant.active || currentIds.has(participant.id)) continue;
      const base = createBaseEvent('participantParticipationChanged', this.now, this.createId);
      await this.appendEvent({ ...base, participantId: participant.id, active: false });
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
      setup.participants,
      syncedInputs,
      this.projection,
      evaluation.eligibleEntryIds,
      budget,
      this.headlessStepLimit
    );

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
    const marbleIdsByEntryId = new Map<string, number[]>();
    mapping.forEach((entryId, marbleId) => {
      const marbleIds = marbleIdsByEntryId.get(entryId) ?? [];
      marbleIds.push(marbleId);
      marbleIdsByEntryId.set(entryId, marbleIds);
    });
    const members: FairnessMemberSnapshot[] = memberIds.map((memberId) => {
      const participant = participantById.get(memberId);
      if (!participant) throw new Error('Fairness participant mapping is unavailable');
      return {
        participantId: memberId,
        displayName: participant.displayName,
        active: participant.active,
        excluded: participant.excluded,
        included: participant.active && !participant.excluded,
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
      if (reservation.key !== context.key) continue;
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
    includeEvent: boolean
  ): FairnessPreparedDraw {
    return this.materializePreparedDraw(
      cachedReservation.context,
      cachedReservation.reservation,
      token,
      includeEvent
    );
  }

  private async cancelClaimedReservationBeforeStart(
    context: FairnessSearchContext,
    reservation: DurableFairnessReservation
  ): Promise<void> {
    const preparedEvent = this.createPreparedEventFromDraft(reservation.drawId, reservation.draft);
    const terminalEvent: FairnessDrawCancelledEvent = {
      ...createBaseEvent('drawCancelled', this.now, this.createId),
      drawId: reservation.drawId,
      reason: 'Fairness draw was cancelled before start',
    };
    try {
      const finalizeReservation = this.store.finalizeReservation;
      const recoverClaimedReservation = this.store.recoverClaimedReservation;
      if (finalizeReservation) {
        await finalizeReservation.call(this.store, reservation.reservationId, preparedEvent, terminalEvent);
      } else if (recoverClaimedReservation) {
        await recoverClaimedReservation.call(this.store, reservation.reservationId, preparedEvent, terminalEvent);
      } else {
        throw new Error('Fairness reservation cancellation is unavailable');
      }
    } catch (error) {
      this.markUnavailable(error);
      throw error;
    }
    await this.enqueueMutation(async () => {
      this.applyAlreadyPersistedEvents([preparedEvent, terminalEvent]);
    });
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
    const claim = Promise.resolve().then(() =>
      claimReservation.call(this.store, reservation.reservationId, getReservationIdentity(reservation))
    );
    return claim.then(
      async (status) => {
        if (status !== 'claimed') {
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
        try {
          this.assertSearchCurrent(context.generation);
          this.assertCurrent(token);
          return this.materializeCachedPreparedDraw(cachedReservation, token, includeEvent);
        } catch (error) {
          if (!isCancellationError(error)) throw error;
          await this.cancelClaimedReservationBeforeStart(context, reservation);
          throw error;
        }
      },
      (error: unknown) => {
        if (isCancellationError(error)) throw error;
        this.markUnavailable(error);
        throw error;
      }
    );
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
        .filter((candidate) => candidate.key === context.key && candidate.seed !== result.seed)
        .forEach((candidate) => {
          this.durableReservations.delete(candidate.reservationId);
          this.scheduleReadyReservationDiscard(candidate);
        });
    }

    const reservation: DurableFairnessReservation = {
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
    const write = reserve.call(this.store, reservation).then(
      () => {
        try {
          this.assertSearchCurrent(context.generation);
        } catch (error) {
          this.scheduleReadyReservationDiscard(reservation);
          throw error;
        }
        this.durableReservations.set(reservation.reservationId, reservation);
        this.recordDiagnostic('reservation.ready', {
          generation: context.generation,
          key: context.key,
          seed: result.seed,
          reservationId: reservation.reservationId,
        });
        return reservation;
      },
      (error: unknown) => {
        this.markUnavailable(error);
        throw error;
      }
    );
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
    includeEvent = true
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
      event,
      persisted: false,
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
      await this.appendEvent(terminalEvent);
      return;
    }

    const finalizeReservation = this.store.finalizeReservation;
    if (finalizeReservation) {
      this.recordDiagnostic('draw.finalize.start', {
        drawId,
        reservationId: claimed.reservationId,
      });
      try {
        await finalizeReservation.call(this.store, claimed.reservationId, claimed.event, terminalEvent);
      } catch (error) {
        this.markUnavailable(error);
        throw error;
      }
      this.applyAlreadyPersistedEvents([terminalEvent]);
      claimed.persisted = true;
      this.claimedReservations.delete(drawId);
      this.recordDiagnostic('draw.finalize.ready', {
        drawId,
        reservationId: claimed.reservationId,
      });
      return;
    }

    try {
      if (!claimed.persisted) {
        await this.store.append(claimed.event);
        claimed.persisted = true;
      }
      await this.appendEvent(terminalEvent);
      await this.store.removeReservation?.(claimed.reservationId);
    } catch (error) {
      this.markUnavailable(error);
      throw error;
    } finally {
      this.claimedReservations.delete(drawId);
    }
  }

  private materializePreparedDraw(
    context: FairnessSearchContext,
    reservation: DurableFairnessReservation,
    token: number,
    includeEvent = true
  ): FairnessPreparedDraw {
    return this.claimDurableReservation(context, reservation, token, includeEvent);
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
      if (preparedEvent && !this.projection.draws.some((draw) => draw.id === drawId)) {
        await this.appendEvent(preparedEvent);
      }
      await this.appendEvent({ ...createBaseEvent('drawFailed', this.now, this.createId), drawId, reason });
    });
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

  private applyAlreadyPersistedEvents(events: readonly FairnessEvent[]): void {
    for (const event of events) {
      this.events.push(clone(event));
      this.projection = applyFairnessEvent(this.projection, event);
    }
  }

  private async appendEvent(event: FairnessEvent): Promise<void> {
    if (!this.available) throw new Error(this.error ?? DEFAULT_RECENT_ERROR);
    try {
      await this.store.append(event);
    } catch (error) {
      this.markUnavailable(error);
      throw error;
    }
    this.events.push(clone(event));
    this.projection = applyFairnessEvent(this.projection, event);
  }

  private markUnavailable(error: unknown): void {
    this.available = false;
    this.enabled = false;
    this.error = getErrorMessage(error);
    writeLocalStorage(FAIRNESS_ENABLED_STORAGE_KEY, 'false');
  }
}

export { searchBudget };
