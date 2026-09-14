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
  validateFairnessExport,
} from './fairness';
import { type FairnessEventStore, IndexedDbFairnessStore } from './fairnessStore';
import type { FairnessWorkerPoolLike } from './fairnessWorkerPool';
import {
  DEFAULT_HEADLESS_STEP_LIMIT,
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
}>;

export type FairnessHeadlessSearchRequest = HeadlessSimulationRequest;

export type FairnessHeadlessRunnerOptions = Readonly<Pick<HeadlessSimulationOptions, 'signal'>>;

export type FairnessHeadlessRunner = (
  request: FairnessHeadlessSearchRequest,
  options?: FairnessHeadlessRunnerOptions
) => Promise<readonly number[]>;

export type FairnessPreparedDraw = Readonly<{
  drawId: string;
  seed: Seed;
  event: FairnessDrawPreparedEvent;
  expectedWinnerEntryIds: readonly string[] | null;
  /** Kept for singleton-entry callers; grouped draws use entry IDs. */
  expectedWinnerParticipantIds: readonly string[] | null;
  expectedWinnerMarbleIds: readonly number[] | null;
  operationToken: number;
}>;

export type FairnessConfirmationResult = Readonly<{
  confirmed: boolean;
  reason?: string;
}>;

export type FairnessCoordinatorOptions = Readonly<{
  store?: FairnessEventStore;
  headlessRunner?: FairnessHeadlessRunner;
  workerPool?: FairnessWorkerPoolLike;
  now?: () => number;
  createId?: (prefix: string) => string;
  createCandidateSeed?: () => Seed;
  headlessStepLimit?: number;
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
  generation: number;
  mustSearch: boolean;
}>;

type SearchCandidate = SearchResult & Readonly<{ key: string; generation: number }>;

type SearchWork = Readonly<{
  key: string;
  generation: number;
  controller: AbortController;
  promise: Promise<SearchResult>;
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
    budget,
    headlessStepLimit,
  });
}

function getErrorMessage(error: unknown, fallback = DEFAULT_RECENT_ERROR): string {
  return error instanceof Error && error.message ? error.message : fallback;
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
  private readonly useWorkerPool: boolean;
  private readonly configuredWorkerPool: FairnessWorkerPoolLike | null;

  private events: FairnessEvent[] = [];
  private projection: FairnessProjection = projectFairnessEvents([]);
  private currentInputs: string[] = [];
  private boundInputs: string[] = [];
  private inputBindings: Array<readonly string[] | null> = [];
  private manualRenames = new Map<string, string>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private loadingPromise: Promise<void> | null = null;
  private loaded = false;
  private available = false;
  private enabled: boolean;
  private mode: FairnessMode;
  private error: string | null = null;
  private operationToken = 0;
  private searchGeneration = 0;
  private cachedCandidate: SearchCandidate | null = null;
  private cachedContext: FairnessSearchContext | null = null;
  private inFlightSearch: SearchWork | null = null;
  private workerPoolPromise: Promise<FairnessWorkerPoolLike | null> | null = null;
  private workerPoolDisabled = false;
  private precomputeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: FairnessCoordinatorOptions = {}) {
    this.store = options.store ?? new IndexedDbFairnessStore();
    this.configuredWorkerPool = options.workerPool ?? null;
    this.useWorkerPool = this.configuredWorkerPool !== null || !options.headlessRunner;
    this.headlessRunner =
      options.headlessRunner ?? ((request, runnerOptions) => this.runProductionHeadless(request, runnerOptions));
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? createFairnessId;
    this.createCandidateSeed = options.createCandidateSeed ?? createFairnessCandidateSeed;
    this.headlessStepLimit = options.headlessStepLimit ?? DEFAULT_HEADLESS_STEP_LIMIT;
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

  schedulePrecompute(request: FairnessStartRequest, delay = FAIRNESS_PRECOMPUTE_DEBOUNCE_MS): void {
    if (!this.enabled) return;
    this.clearPrecomputeTimer();
    if (delay <= 0) {
      void this.precompute(request).catch(() => undefined);
      return;
    }

    this.precomputeTimer = setTimeout(() => {
      this.precomputeTimer = null;
      void this.precompute(request).catch(() => undefined);
    }, delay);
  }

  async precompute(request: FairnessStartRequest): Promise<void> {
    const generation = this.searchGeneration;
    const context = await this.createSearchContext(request, undefined, generation);
    if (!context.mustSearch) return;
    await this.ensureSearch(context);
  }

  private clearPrecomputeTimer(): void {
    if (this.precomputeTimer === null) return;
    clearTimeout(this.precomputeTimer);
    this.precomputeTimer = null;
  }

  private getWorkerPool(): Promise<FairnessWorkerPoolLike | null> {
    if (this.configuredWorkerPool) return Promise.resolve(this.configuredWorkerPool);
    if (!this.useWorkerPool || this.workerPoolDisabled) return Promise.resolve(null);
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
      .catch(() => undefined);
  }

  private async runProductionHeadless(
    request: FairnessHeadlessSearchRequest,
    options: FairnessHeadlessRunnerOptions = {}
  ): Promise<readonly number[]> {
    const workerPool = await this.getWorkerPool();
    if (!workerPool) return runHeadlessRace(request, this.headlessStepLimit, options);
    try {
      return await workerPool.run(request, { signal: options.signal, stepLimit: this.headlessStepLimit });
    } catch (error) {
      if (error instanceof Error && error.name === 'WorkerPoolUnavailableError') {
        this.workerPoolDisabled = true;
        return runHeadlessRace(request, this.headlessStepLimit, options);
      }
      throw error;
    }
  }

  private invalidateSearchState(): void {
    const staleWork = this.inFlightSearch;
    this.searchGeneration += 1;
    this.cachedCandidate = null;
    this.cachedContext = null;
    this.clearPrecomputeTimer();
    staleWork?.controller.abort();
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
    await this.ensureOperational();
    const current = this.projection.participants.find((candidate) => candidate.id === participantId);
    if (!current) throw new Error('Fairness participant was not found');
    if (current.excluded === excluded) return;
    this.invalidateStart();
    await this.enqueueMutation(async () => {
      await this.ensureEpoch();
      const participant = this.projection.participants.find((candidate) => candidate.id === participantId);
      if (!participant) throw new Error('Fairness participant was not found');
      if (participant.excluded === excluded) return;
      const base = createBaseEvent('participantExclusionChanged', this.now, this.createId);
      await this.appendEvent({ ...base, participantId, excluded });
    });
  }

  async renameParticipant(participantId: string, displayName: string): Promise<void> {
    await this.ensureOperational();
    const trimmedName = displayName.trim();
    if (!trimmedName || trimmedName.length > 512) throw new Error('Fairness participant name is invalid');
    const current = this.projection.participants.find((candidate) => candidate.id === participantId);
    if (!current) throw new Error('Fairness participant was not found');
    if (current.displayName === trimmedName) return;
    this.invalidateStart();
    await this.enqueueMutation(async () => {
      await this.ensureEpoch();
      const participant = this.projection.participants.find((candidate) => candidate.id === participantId);
      if (!participant) throw new Error('Fairness participant was not found');
      if (participant.displayName === trimmedName) return;
      const boundIndex = this.inputBindings.findIndex((binding) => binding?.includes(participantId));
      const memberIndex = boundIndex >= 0 ? (this.inputBindings[boundIndex]?.indexOf(participantId) ?? -1) : -1;
      const parsed = boundIndex >= 0 ? parseName(this.boundInputs[boundIndex]) : null;
      const memberNames = parsed ? parseFairnessEntryName(parsed.name) : null;
      const rawInput = memberIndex >= 0 && memberNames ? memberNames[memberIndex] : undefined;
      if (rawInput !== undefined) this.manualRenames.set(participantId, rawInput);
      const base = createBaseEvent('participantRenamed', this.now, this.createId);
      await this.appendEvent({ ...base, participantId, displayName: trimmedName, ...(rawInput ? { rawInput } : {}) });
    });
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
    });
  }

  async prepareDraw(request: FairnessStartRequest, token: number): Promise<FairnessPreparedDraw> {
    this.clearPrecomputeTimer();
    const context = await this.createSearchContext(request, token);
    const { syncedInputs, mappingRows, totalCount } = context;
    let seed = request.currentSeed;
    let expectedWinnerEntryIds: readonly string[] | null = null;
    let expectedWinnerParticipantIds: readonly string[] | null = null;
    let expectedWinnerMarbleIds: readonly number[] | null = null;
    const drawId = this.createId('draw');
    let preparedEvent: FairnessDrawPreparedEvent | null = null;

    try {
      if (context.mustSearch) {
        const searchResult = await this.ensureSearch(context, token);
        this.consumeCandidate(context);
        seed = searchResult.seed;
        expectedWinnerEntryIds = [searchResult.winnerEntryIds[request.winnerRange.end]];
        const winningEntry = syncedInputs.find((entry) => entry.entryId === expectedWinnerEntryIds?.[0]);
        expectedWinnerParticipantIds = winningEntry?.memberIds.length === 1 ? [winningEntry.memberIds[0]] : null;
        expectedWinnerMarbleIds = [searchResult.winnerMarbleIds[request.winnerRange.end]];
      }

      this.assertCurrent(token);
      const event = this.createPreparedEvent(request, seed, syncedInputs, mappingRows, totalCount, drawId, true);
      preparedEvent = event;
      await this.enqueueMutation(async () => {
        this.assertCurrent(token);
        await this.appendEvent(event);
      });
      return {
        drawId: event.drawId,
        seed,
        event: clone(event),
        expectedWinnerEntryIds,
        expectedWinnerParticipantIds,
        expectedWinnerMarbleIds,
        operationToken: token,
      };
    } catch (error) {
      if (error instanceof FairnessCancelledError) throw error;
      if (!preparedEvent) {
        try {
          preparedEvent = this.createPreparedEvent(
            request,
            request.currentSeed,
            syncedInputs,
            mappingRows,
            totalCount,
            drawId,
            true
          );
        } catch {
          // A storage or cancellation failure should not mask the original
          // search error or prevent the legacy race path from continuing.
        }
      }
      await this.recordFailedDraw(drawId, getErrorMessage(error), preparedEvent).catch(() => undefined);
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
        await this.appendEvent({
          ...createBaseEvent('drawCancelled', this.now, this.createId),
          drawId,
          reason: 'Fairness draw was cancelled before confirmation',
        });
        return { confirmed: false, reason: 'Fairness draw was cancelled' };
      }

      const winners = mapWinnerMarbles(winnerMarbleIds, draw.entries, draw.members);
      if (!winners || winners.length === 0) {
        const reason = 'Fairness could not map the actual winner to a participant';
        await this.appendEvent({ ...createBaseEvent('drawFailed', this.now, this.createId), drawId, reason });
        return { confirmed: false, reason };
      }

      if (
        expectedWinnerEntryIds &&
        (expectedWinnerEntryIds.length !== winners.length ||
          expectedWinnerEntryIds.some((entryId, index) => entryId !== winners[index].entryId))
      ) {
        const reason = 'Fairness search verification did not match the actual draw entry';
        await this.appendEvent({ ...createBaseEvent('drawFailed', this.now, this.createId), drawId, reason });
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
        await this.appendEvent({ ...createBaseEvent('drawFailed', this.now, this.createId), drawId, reason });
        return { confirmed: false, reason };
      }

      if (
        expectedWinnerMarbleIds &&
        (expectedWinnerMarbleIds.length !== winners.length ||
          expectedWinnerMarbleIds.some((marbleId, index) => marbleId !== winners[index].marbleId))
      ) {
        const reason = 'Fairness search verification did not match the actual marble result';
        await this.appendEvent({ ...createBaseEvent('drawFailed', this.now, this.createId), drawId, reason });
        return { confirmed: false, reason };
      }

      await this.appendEvent({
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
      await this.appendEvent({ ...createBaseEvent('drawCancelled', this.now, this.createId), drawId, reason });
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
        const events = await this.store.load();
        this.events = events.map((event) => clone(event));
        this.projection = projectFairnessEvents(this.events);
        this.manualRenames = collectManualRenameBindings(this.events);
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
      generation,
      mustSearch: !canUseStrictBalanceEntryFastPath(evaluation),
    };
    this.cachedContext = context;
    return context;
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
    const mapping = mapMarbleIdsToEntries(seed, mappingRows);
    const base = createBaseEvent('drawPrepared', this.now, this.createId);
    const memberIds = [...new Set(syncedInputs.reduce<string[]>((ids, input) => ids.concat(input.memberIds), []))];
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
      ...base,
      drawId,
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

  private ensureSearch(context: FairnessSearchContext, token?: number): Promise<SearchResult> {
    this.assertSearchCurrent(context.generation);
    if (token !== undefined) this.assertCurrent(token);

    if (this.cachedCandidate?.key === context.key && this.cachedCandidate.generation === context.generation) {
      return Promise.resolve(this.cachedCandidate);
    }

    if (this.inFlightSearch?.key === context.key && this.inFlightSearch.generation === context.generation) {
      return this.inFlightSearch.promise;
    }

    const controller = new AbortController();
    const promise = this.searchForWinner(context, token, controller.signal);
    const work: SearchWork = { key: context.key, generation: context.generation, controller, promise };
    this.inFlightSearch = work;
    void promise
      .then((result) => {
        if (
          this.inFlightSearch === work &&
          this.searchGeneration === context.generation &&
          !controller.signal.aborted
        ) {
          this.cachedCandidate = { ...result, key: context.key, generation: context.generation };
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
      if (workerPool) return this.searchForWinnerParallel(context, token, signal, workerPool.concurrency);
    }
    return this.searchForWinnerSerial(context, token, signal);
  }

  private async searchForWinnerParallel(
    context: FairnessSearchContext,
    token: number | undefined,
    signal: AbortSignal,
    concurrency: number
  ): Promise<SearchResult> {
    if (context.budget <= 0) throw new Error('Fairness search has no valid budget');

    const mappingByMarble = (seed: Seed) => mapMarbleIdsToEntries(seed, context.mappingRows);
    const eligible = new Set(context.eligibleEntryIds);
    const parallelism = Number.isSafeInteger(concurrency) && concurrency > 0 ? concurrency : 1;
    const active = new Map<number, { controller: AbortController; promise: Promise<void> }>();
    const completed = new Map<number, { seed: Seed; winnerMarbleIds?: readonly number[]; error?: unknown }>();
    let nextAttempt = 0;
    let nextCommit = 0;
    let lastError: unknown;

    const startAttempt = (): void => {
      const attempt = nextAttempt++;
      const controller = new AbortController();
      const abortChild = () => controller.abort();
      signal.addEventListener('abort', abortChild, { once: true });
      const seed = this.createCandidateSeed();
      const promise = Promise.resolve()
        .then(() =>
          this.headlessRunner(
            {
              seed,
              stage: context.request.stage,
              participants: context.participants,
              totalCount: context.totalCount,
              spawnPositions: context.spawnPositions,
              skillsEnabled: context.request.skillsEnabled,
              targetRank: context.request.winnerRange.end,
            },
            { signal: controller.signal }
          )
        )
        .then((winnerMarbleIds) => {
          completed.set(attempt, { seed, winnerMarbleIds });
        })
        .catch((error: unknown) => {
          completed.set(attempt, { seed, error });
        })
        .then(
          () => {
            signal.removeEventListener('abort', abortChild);
            active.delete(attempt);
          },
          () => {
            signal.removeEventListener('abort', abortChild);
            active.delete(attempt);
          }
        );
      active.set(attempt, { controller, promise });
    };

    while (true) {
      if (signal.aborted) throw new FairnessCancelledError();
      this.assertSearchCurrent(context.generation);
      if (token !== undefined) this.assertCurrent(token);

      while (active.size < parallelism && nextAttempt < context.budget) startAttempt();
      if (active.size === 0) break;
      await Promise.race([...active.values()].map(({ promise }) => promise));

      for (; nextCommit < nextAttempt; nextCommit++) {
        const attempt = nextCommit;
        const result = completed.get(attempt);
        if (!result) break;
        completed.delete(attempt);
        if (result.error) {
          if (signal.aborted || result.error instanceof FairnessCancelledError) {
            throw new FairnessCancelledError();
          }
          lastError = result.error;
          continue;
        }

        const winnerMarbleIds = result.winnerMarbleIds ?? [];
        const mapping = mappingByMarble(result.seed);
        const winnerEntryIds = winnerMarbleIds.map((marbleId) => mapping.get(marbleId));
        const winnerId = winnerEntryIds[context.request.winnerRange.end];
        if (winnerId && eligible.has(winnerId)) {
          active.forEach(({ controller }, higherAttempt) => {
            if (higherAttempt > attempt) controller.abort();
          });
          return {
            seed: result.seed,
            winnerMarbleIds: winnerMarbleIds.slice(),
            winnerEntryIds: winnerEntryIds.filter((id): id is string => id !== undefined),
          };
        }
      }

      if (signal.aborted) throw new FairnessCancelledError();
      await yieldToHost();
    }

    if (signal.aborted) throw new FairnessCancelledError();
    this.assertSearchCurrent(context.generation);
    if (token !== undefined) this.assertCurrent(token);
    const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
    throw new Error(`Fairness could not find an eligible winner within ${context.budget} attempts${detail}`);
  }

  private async searchForWinnerSerial(
    context: FairnessSearchContext,
    token: number | undefined,
    signal: AbortSignal
  ): Promise<SearchResult> {
    if (context.budget <= 0) throw new Error('Fairness search has no valid budget');

    const mappingByMarble = (seed: Seed) => mapMarbleIdsToEntries(seed, context.mappingRows);
    const eligible = new Set(context.eligibleEntryIds);
    let lastError: unknown;
    for (let attempt = 0; attempt < context.budget; attempt++) {
      if (signal.aborted) throw new FairnessCancelledError();
      this.assertSearchCurrent(context.generation);
      if (token !== undefined) this.assertCurrent(token);
      const seed = this.createCandidateSeed();
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
        if (signal.aborted || error instanceof FairnessCancelledError) throw new FairnessCancelledError();
        lastError = error;
        await yieldToHost();
        if (signal.aborted) throw new FairnessCancelledError();
        continue;
      }

      if (signal.aborted) throw new FairnessCancelledError();
      this.assertSearchCurrent(context.generation);
      if (token !== undefined) this.assertCurrent(token);
      const mapping = mappingByMarble(seed);
      const winnerEntryIds = winnerMarbleIds.map((marbleId) => mapping.get(marbleId));
      const winnerId = winnerEntryIds[context.request.winnerRange.end];
      if (winnerId && eligible.has(winnerId)) {
        return {
          seed,
          winnerMarbleIds: winnerMarbleIds.slice(),
          winnerEntryIds: winnerEntryIds.filter((id): id is string => id !== undefined),
        };
      }
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
