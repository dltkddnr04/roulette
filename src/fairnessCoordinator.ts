import type { StageDef } from './data/maps';
import {
  canUseStrictBalanceFastPath,
  createFairnessCandidateSeed,
  createFairnessExport,
  createFairnessId,
  createFairnessState,
  evaluateStrictBalance,
  type FairnessDrawPreparedEvent,
  type FairnessEvent,
  type FairnessExport,
  type FairnessMode,
  type FairnessParticipantSnapshot,
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
import type { MarbleParticipant } from './raceSimulation';
import { RaceSimulation } from './raceSimulation';
import { MAX_MARBLES } from './roundSession';
import { getMarbleSpawnLayout } from './utils/marbleSpawn';
import { getSimulationParticipantSetup } from './utils/participants';
import { createSeededRandom, type Seed } from './utils/random';
import { readLocalStorage, writeLocalStorage } from './utils/storage';
import { parseName, shuffle } from './utils/utils';

const FAIRNESS_ENABLED_STORAGE_KEY = 'mbr_fairness_enabled';
const FAIRNESS_MODE_STORAGE_KEY = 'mbr_fairness_mode';

const DEFAULT_HEADLESS_STEP_LIMIT = 30000;
const DEFAULT_RECENT_ERROR = 'Fairness is unavailable';

export type FairnessStartRequest = Readonly<{
  stage: StageDef;
  mapIndex: number;
  participantInputs: readonly string[];
  winnerRange: Readonly<{ start: number; end: number }>;
  skillsEnabled: boolean;
  currentSeed: Seed;
}>;

export type FairnessHeadlessSearchRequest = Readonly<{
  seed: Seed;
  stage: StageDef;
  participants: readonly MarbleParticipant[];
  totalCount: number;
  spawnPositions: readonly { x: number; y: number }[];
  skillsEnabled: boolean;
  targetRank: number;
}>;

export type FairnessHeadlessRunner = (request: FairnessHeadlessSearchRequest) => Promise<readonly number[]>;

export type FairnessPreparedDraw = Readonly<{
  drawId: string;
  seed: Seed;
  event: FairnessDrawPreparedEvent;
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
  now?: () => number;
  createId?: (prefix: string) => string;
  createCandidateSeed?: () => Seed;
  headlessStepLimit?: number;
}>;

type SyncedInput = Readonly<{
  participantId: string;
  rawInput: string;
  displayName: string;
  weight: number;
  count: number;
}>;

type SearchResult = Readonly<{
  seed: Seed;
  winnerMarbleIds: readonly number[];
  winnerParticipantIds: readonly string[];
}>;

export class FairnessCancelledError extends Error {
  constructor() {
    super('Fairness start was cancelled');
    this.name = 'FairnessCancelledError';
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getErrorMessage(error: unknown, fallback = DEFAULT_RECENT_ERROR): string {
  return error instanceof Error && error.message ? error.message : fallback;
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
    version: 1,
    eventId: createId('event'),
    timestamp: now(),
    type,
  } as Pick<FairnessEvent, 'version' | 'eventId' | 'timestamp' | 'type'> & { type: T };
}

function mapWinnerMarbles(
  winnerMarbleIds: readonly number[],
  participants: readonly FairnessParticipantSnapshot[]
): FairnessWinnerSnapshot[] | null {
  const winners: FairnessWinnerSnapshot[] = [];
  const seen = new Set<string>();
  for (const marbleId of winnerMarbleIds) {
    const participant = participants.find((candidate) => candidate.marbleIds.includes(marbleId));
    if (!participant) return null;
    if (seen.has(participant.participantId)) continue;
    seen.add(participant.participantId);
    winners.push({ participantId: participant.participantId, displayName: participant.displayName, marbleId });
  }
  return winners;
}

export function mapMarbleIdsToParticipants(
  seed: Seed,
  participants: readonly Readonly<{ participantId: string; count: number }>[]
): Map<number, string> {
  const totalCount = participants.reduce((total, participant) => total + participant.count, 0);
  const orders = shuffle(
    Array.from({ length: totalCount }, (_, index) => index),
    createSeededRandom(seed)
  );
  const mapping = new Map<number, string>();
  participants.forEach((participant) => {
    for (let index = 0; index < participant.count; index++) {
      const order = orders.pop();
      if (order !== undefined) mapping.set(order, participant.participantId);
    }
  });
  return mapping;
}

async function yieldToHost(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, 0);
    else resolve();
  });
}

export async function runHeadlessRace(request: FairnessHeadlessSearchRequest, stepLimit = DEFAULT_HEADLESS_STEP_LIMIT) {
  const simulation = new RaceSimulation(undefined, request.seed);
  try {
    await simulation.init();
    simulation.loadStage(request.stage);
    simulation.setSkillsEnabled(request.skillsEnabled);
    simulation.replaceMarbles(request.participants, request.totalCount, [...request.spawnPositions]);
    simulation.start();

    const finished: number[] = [];
    let iterations = 0;
    while (finished.length <= request.targetRank && iterations < stepLimit) {
      simulation.advance(80, 1, 1, {
        onImpact() {},
        onFinish(marble) {
          finished.push(marble.id);
        },
        afterStep() {
          return 1;
        },
        onStepComplete() {},
      });
      iterations += 1;
      if (iterations % 16 === 0) await yieldToHost();
    }

    if (finished.length <= request.targetRank) {
      throw new Error('Headless fairness simulation did not reach the requested rank');
    }
    return finished.slice(0, request.targetRank + 1);
  } finally {
    simulation.dispose();
  }
}

export class FairnessCoordinator {
  private readonly store: FairnessEventStore;
  private readonly headlessRunner: FairnessHeadlessRunner;
  private readonly now: () => number;
  private readonly createId: (prefix: string) => string;
  private readonly createCandidateSeed: () => Seed;
  private readonly headlessStepLimit: number;

  private events: FairnessEvent[] = [];
  private projection: FairnessProjection = projectFairnessEvents([]);
  private currentInputs: string[] = [];
  private inputBindings: Array<string | null> = [];
  private manualRenames = new Map<string, string>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private loadingPromise: Promise<void> | null = null;
  private loaded = false;
  private available = false;
  private enabled: boolean;
  private mode: FairnessMode;
  private error: string | null = null;
  private operationToken = 0;

  constructor(options: FairnessCoordinatorOptions = {}) {
    this.store = options.store ?? new IndexedDbFairnessStore();
    this.headlessRunner = options.headlessRunner ?? ((request) => runHeadlessRace(request, options.headlessStepLimit));
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
  }

  setCurrentParticipantInputs(inputs: readonly string[], suppressSync = false): void {
    this.currentInputs = [...inputs];
    if (!suppressSync) this.invalidateStart();
    if (!this.enabled || suppressSync) return;

    void this.syncCurrentParticipants().catch((error) => {
      this.markUnavailable(error);
    });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.enabled = false;
      writeLocalStorage(FAIRNESS_ENABLED_STORAGE_KEY, 'false');
      return;
    }

    try {
      await this.ensureLoaded();
      this.available = true;
      this.error = null;
      this.enabled = true;
      await this.syncCurrentParticipants();
      writeLocalStorage(FAIRNESS_ENABLED_STORAGE_KEY, 'true');
    } catch (error) {
      this.markUnavailable(error);
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
    this.invalidateStart();
    await this.ensureOperational();
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
    this.invalidateStart();
    await this.ensureOperational();
    const trimmedName = displayName.trim();
    if (!trimmedName || trimmedName.length > 512) throw new Error('Fairness participant name is invalid');
    await this.enqueueMutation(async () => {
      await this.ensureEpoch();
      const participant = this.projection.participants.find((candidate) => candidate.id === participantId);
      if (!participant) throw new Error('Fairness participant was not found');
      if (participant.displayName === trimmedName) return;
      const boundIndex = this.inputBindings.indexOf(participantId);
      const rawInput = boundIndex >= 0 ? this.currentInputs[boundIndex] : undefined;
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
    this.invalidateStart();
    await this.ensureLoaded();
    if (!this.available) throw new Error(this.error ?? DEFAULT_RECENT_ERROR);
    await this.enqueueMutation(async () => {
      const draw = this.projection.draws.find((candidate) => candidate.id === drawId);
      if (!draw) throw new Error('Fairness draw was not found');
      if (draw.status === 'voided') return;
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
      this.manualRenames.clear();
    });
  }

  async prepareDraw(request: FairnessStartRequest, token: number): Promise<FairnessPreparedDraw> {
    await this.ensureOperational();
    const syncedInputs = await this.syncCurrentParticipants(true, request.participantInputs, token);
    this.assertCurrent(token);

    const setup = getSimulationParticipantSetup(request.participantInputs);
    if (!setup || setup.totalCount <= 0 || setup.totalCount > MAX_MARBLES) {
      throw new Error(`Fairness participant count must be between 1 and ${MAX_MARBLES}`);
    }
    if (request.winnerRange.start !== request.winnerRange.end) {
      throw new Error('Cumulative fairness supports one winning rank at a time');
    }

    const policyInputs = this.projection.participants.map((participant) => ({
      id: participant.id,
      active: participant.active,
      excluded: participant.excluded,
      effectiveBalance: participant.effectiveBalance,
    }));
    const evaluation = evaluateStrictBalance(policyInputs);
    if (evaluation.eligibleIds.length === 0) throw new Error('Fairness has no eligible participants');

    const mappingRows = syncedInputs.map((input) => ({ participantId: input.participantId, count: input.count }));
    const spawnLayout = getMarbleSpawnLayout(setup.totalCount, request.stage.spawn);
    const mustSearch = !canUseStrictBalanceFastPath(evaluation);
    let seed = request.currentSeed;
    let expectedWinnerParticipantIds: readonly string[] | null = null;
    let expectedWinnerMarbleIds: readonly number[] | null = null;
    const drawId = this.createId('draw');
    let preparedEvent: FairnessDrawPreparedEvent | null = null;

    try {
      if (mustSearch) {
        const searchResult = await this.searchForWinner(
          request,
          setup.participants,
          setup.totalCount,
          spawnLayout.positions,
          mappingRows,
          evaluation.eligibleIds,
          token
        );
        seed = searchResult.seed;
        expectedWinnerParticipantIds = [searchResult.winnerParticipantIds[request.winnerRange.end]];
        expectedWinnerMarbleIds = [searchResult.winnerMarbleIds[request.winnerRange.end]];
      }

      this.assertCurrent(token);
      const event = this.createPreparedEvent(request, seed, syncedInputs, mappingRows, setup.totalCount, drawId, true);
      preparedEvent = event;
      await this.enqueueMutation(async () => {
        this.assertCurrent(token);
        await this.appendEvent(event);
      });
      return {
        drawId: event.drawId,
        seed,
        event: clone(event),
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
            setup.totalCount,
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
    expectedWinnerMarbleIds: readonly number[] | null = null
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

      const winners = mapWinnerMarbles(winnerMarbleIds, draw.participants);
      if (!winners || winners.length === 0) {
        const reason = 'Fairness could not map the actual winner to a participant';
        await this.appendEvent({ ...createBaseEvent('drawFailed', this.now, this.createId), drawId, reason });
        return { confirmed: false, reason };
      }

      if (
        expectedWinnerParticipantIds &&
        (expectedWinnerParticipantIds.length !== winners.length ||
          expectedWinnerParticipantIds.some((participantId, index) => participantId !== winners[index].participantId))
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
    const syncedInputs = await this.syncCurrentParticipants(true, request.participantInputs);

    const setup = getSimulationParticipantSetup(request.participantInputs);
    if (!setup || setup.totalCount <= 0 || setup.totalCount > MAX_MARBLES) return null;
    const mappingRows = syncedInputs.map((input) => ({ participantId: input.participantId, count: input.count }));
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
    token?: number
  ): Promise<SyncedInput[]> {
    if (!force && !this.enabled) return [];
    await this.ensureLoaded();
    if (!this.available) throw new Error(this.error ?? DEFAULT_RECENT_ERROR);

    return this.enqueueMutation(async () => {
      if (token !== undefined) this.assertCurrent(token);
      if (!force && !this.enabled) return [];
      await this.ensureEpoch();
      const syncedInputs = await this.syncCurrentParticipantsNow(inputs, token);
      if (token !== undefined) this.assertCurrent(token);
      return syncedInputs;
    });
  }

  private async syncCurrentParticipantsNow(
    inputs: readonly string[] = this.currentInputs,
    token?: number
  ): Promise<SyncedInput[]> {
    const rows: Array<{ rawInput: string; displayName: string; weight: number; count: number }> = [];
    inputs.forEach((rawInput) => {
      const parsed = parseName(rawInput);
      if (parsed) rows.push({ rawInput, displayName: parsed.name, weight: parsed.weight, count: parsed.count });
    });

    const usedIds = new Set<string>();
    const nextBindings: Array<string | null> = [];
    const currentIds = new Set<string>();
    const syncedInputs: SyncedInput[] = [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      if (token !== undefined) this.assertCurrent(token);
      const row = rows[rowIndex];
      const priorBinding = this.inputBindings[rowIndex];
      const boundParticipant = priorBinding
        ? this.projection.participants.find((candidate) => candidate.id === priorBinding && !usedIds.has(candidate.id))
        : undefined;
      const namedParticipant = this.projection.participants.find(
        (candidate) => candidate.displayName === row.displayName && !usedIds.has(candidate.id)
      );
      const pinnedParticipant = this.projection.participants.find(
        (candidate) => this.manualRenames.get(candidate.id) === row.rawInput && !usedIds.has(candidate.id)
      );
      // Preserve a row's identity across a rename, but do not let reordering
      // two existing names silently swap their participant IDs.
      const isPinnedRename = boundParticipant && this.manualRenames.get(boundParticipant.id) === row.rawInput;
      let participant =
        boundParticipant &&
        (isPinnedRename ||
          (!namedParticipant && !pinnedParticipant) ||
          boundParticipant.displayName === row.displayName)
          ? boundParticipant
          : (namedParticipant ?? pinnedParticipant);

      if (!participant) {
        const participantId = this.createId('participant');
        const base = createBaseEvent('participantDiscovered', this.now, this.createId);
        await this.appendEvent({
          ...base,
          participantId,
          displayName: row.displayName,
          active: true,
          excluded: false,
        });
        participant = this.projection.participants.find((candidate) => candidate.id === participantId);
      }
      if (!participant) throw new Error('Fairness participant discovery failed');

      usedIds.add(participant.id);
      currentIds.add(participant.id);
      nextBindings[rowIndex] = participant.id;

      if (!participant.active) {
        const base = createBaseEvent('participantParticipationChanged', this.now, this.createId);
        await this.appendEvent({ ...base, participantId: participant.id, active: true });
      }
      const latestParticipant = this.projection.participants.find((candidate) => candidate.id === participant.id);
      const manualRename = this.manualRenames.get(participant.id);
      if (latestParticipant && latestParticipant.displayName !== row.displayName && manualRename !== row.rawInput) {
        this.manualRenames.set(latestParticipant.id, row.rawInput);
        const base = createBaseEvent('participantRenamed', this.now, this.createId);
        await this.appendEvent({
          ...base,
          participantId: latestParticipant.id,
          displayName: row.displayName,
          rawInput: row.rawInput,
        });
      }
      syncedInputs.push({ participantId: participant.id, ...row });
    }

    // Keep absence events sequential so each event is persisted and projected
    // before the next participant operation can observe the roster.
    for (const participant of this.projection.participants.slice()) {
      if (token !== undefined) this.assertCurrent(token);
      if (!participant.active || currentIds.has(participant.id)) continue;
      const base = createBaseEvent('participantParticipationChanged', this.now, this.createId);
      await this.appendEvent({ ...base, participantId: participant.id, active: false });
    }
    this.inputBindings = nextBindings;
    return syncedInputs;
  }

  private createPreparedEvent(
    request: FairnessStartRequest,
    seed: Seed,
    syncedInputs: readonly SyncedInput[],
    mappingRows: readonly Readonly<{ participantId: string; count: number }>[],
    totalCount: number,
    drawId: string,
    fairnessEnabledAtDraw: boolean
  ): FairnessDrawPreparedEvent {
    const mapping = mapMarbleIdsToParticipants(seed, mappingRows);
    const base = createBaseEvent('drawPrepared', this.now, this.createId);
    const participants: FairnessParticipantSnapshot[] = syncedInputs.map((input) => {
      const participant = this.projection.participants.find((candidate) => candidate.id === input.participantId);
      if (!participant) throw new Error('Fairness participant mapping is unavailable');
      return {
        participantId: input.participantId,
        displayName: participant.displayName,
        rawInput: input.rawInput,
        weight: input.weight,
        count: input.count,
        marbleIds: [...mapping]
          .filter(([, participantId]) => participantId === input.participantId)
          .map(([marbleId]) => marbleId),
        active: participant.active,
        excluded: participant.excluded,
        included: participant.active && !participant.excluded,
        effectiveBalance: participant.effectiveBalance,
      };
    });

    if (participants.reduce((total, participant) => total + participant.count, 0) !== totalCount) {
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
      participants,
    };
  }

  private async searchForWinner(
    request: FairnessStartRequest,
    participants: readonly MarbleParticipant[],
    totalCount: number,
    spawnPositions: readonly { x: number; y: number }[],
    mappingRows: readonly Readonly<{ participantId: string; count: number }>[],
    eligibleIds: readonly string[],
    token: number
  ): Promise<SearchResult> {
    const activeParticipantCount = this.projection.participants.filter((participant) => participant.active).length;
    const budget = searchBudget(totalCount, Math.max(1, activeParticipantCount), eligibleIds.length);
    if (budget <= 0) throw new Error('Fairness search has no valid budget');

    const mappingByMarble = (seed: Seed) => mapMarbleIdsToParticipants(seed, mappingRows);
    const eligible = new Set(eligibleIds);
    let lastError: unknown;
    for (let attempt = 0; attempt < budget; attempt++) {
      this.assertCurrent(token);
      const seed = this.createCandidateSeed();
      try {
        const winnerMarbleIds = await this.headlessRunner({
          seed,
          stage: request.stage,
          participants,
          totalCount,
          spawnPositions,
          skillsEnabled: request.skillsEnabled,
          targetRank: request.winnerRange.end,
        });
        const mapping = mappingByMarble(seed);
        const winnerParticipantIds = winnerMarbleIds.map((marbleId) => mapping.get(marbleId));
        const winnerId = winnerParticipantIds[request.winnerRange.end];
        if (winnerId && eligible.has(winnerId)) {
          return {
            seed,
            winnerMarbleIds: winnerMarbleIds.slice(),
            winnerParticipantIds: winnerParticipantIds.filter((id): id is string => id !== undefined),
          };
        }
      } catch (error) {
        lastError = error;
      }
      await yieldToHost();
    }

    const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
    throw new Error(`Fairness could not find an eligible winner within ${budget} attempts${detail}`);
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
    this.projection = projectFairnessEvents(this.events);
  }

  private markUnavailable(error: unknown): void {
    this.available = false;
    this.enabled = false;
    this.error = getErrorMessage(error);
    writeLocalStorage(FAIRNESS_ENABLED_STORAGE_KEY, 'false');
  }
}

export { searchBudget };
