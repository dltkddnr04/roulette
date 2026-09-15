import type { StageDef } from './data/maps';
import {
  createMarblePreviewStates,
  type RaceRenderState,
  RaceSimulation,
  type SimulationStepCallbacks,
} from './raceSimulation';
import type { MarblePresentationState, MarbleRenderState } from './types/MarbleRenderState.type';
import { getMarbleSpawnLayout, type MarbleSpawnLayout } from './utils/marbleSpawn';
import { getSimulationParticipantSetup } from './utils/participants';
import type { Seed } from './utils/random';

export type RoundState = 'initializing' | 'ready' | 'running' | 'finished';

export type RoundStepCallbacks = Omit<SimulationStepCallbacks, 'onFinish'> & {
  onFinish: (marble: MarblePresentationState, isWinningRank: boolean) => void;
};

export type RoundFinish = {
  result: readonly MarblePresentationState[];
  early: boolean;
  earlyWinning: boolean;
};

export const MAX_MARBLES = 1000;

function clipWinnerRange(start: number, end: number, marbleCount: number): { start: number; end: number } {
  const last = Math.max(0, marbleCount - 1);
  const clippedStart = Math.min(Math.max(0, start), last);
  return { start: clippedStart, end: Math.min(Math.max(clippedStart, end), last) };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

type AuthoritativeStandby = Readonly<{
  simulation: RaceSimulation;
  seed: Seed;
  stage: StageDef;
  participantInputs: readonly string[];
  skillsEnabled: boolean;
  layout: MarbleSpawnLayout;
  count: number;
}>;

export class RoundSession {
  private simulation: RaceSimulation;
  private state: RoundState = 'initializing';
  private stage: StageDef | null = null;
  private participantInputs: string[] = [];
  private seed: Seed;
  private winners: MarblePresentationState[] = [];
  private result: MarblePresentationState[] | null = null;
  private winnerRange = { start: 0, end: 0 };
  private roundId = 0;
  private configuredCount = 0;
  private previewMarbles: MarbleRenderState[] = [];
  private authoritativeStandby: AuthoritativeStandby | null = null;
  private standbyRequestId = 0;
  private standbyPromise: Promise<MarbleSpawnLayout | null> | null = null;
  private standbyPromiseSpec: {
    seed: Seed;
    stage: StageDef;
    skillsEnabled: boolean;
    participantInputs: readonly string[];
  } | null = null;

  constructor(simulation = new RaceSimulation()) {
    this.simulation = simulation;
    this.seed = simulation.getSeed();
  }

  get roundState(): RoundState {
    return this.state;
  }

  get isInitialized(): boolean {
    return this.state !== 'initializing';
  }

  get currentStage(): StageDef | null {
    return this.stage;
  }

  get generation(): number {
    return this.roundId;
  }

  getSeed(): Seed {
    return this.seed;
  }

  getSeedMode(): 'random' | 'explicit' {
    return this.simulation.getSeedMode();
  }

  async init(): Promise<void> {
    await this.simulation.init();
  }

  markReady(): void {
    this.state = 'ready';
  }

  loadStage(stage: StageDef): void {
    this.discardAuthoritativeStandby();
    this.stage = stage;
    this.simulation.loadStage(stage);
  }

  setSeed(seed: Seed): void {
    this.discardAuthoritativeStandby();
    this.seed = seed;
    this.simulation.setSeed(seed);
    if (this.state === 'ready' && this.stage) this.rebuildPreview(false);
  }

  setRandomSeedMode(): void {
    this.discardAuthoritativeStandby();
    this.simulation.setRandomSeedMode();
  }

  getParticipantInputs(): readonly string[] {
    return this.participantInputs.slice();
  }

  setSkillsEnabled(enabled: boolean): boolean {
    if (this.simulation.getSkillsEnabled() === enabled) return false;
    this.discardAuthoritativeStandby();
    this.simulation.setSkillsEnabled(enabled);
    return true;
  }

  getSkillsEnabled(): boolean {
    return this.simulation.getSkillsEnabled();
  }

  setWinnerRange(start: number, end: number): boolean {
    const nextRange = clipWinnerRange(start, end, this.getCount());
    if (nextRange.start === this.winnerRange.start && nextRange.end === this.winnerRange.end) return false;
    this.winnerRange = nextRange;
    return true;
  }

  getWinnerRange(): { start: number; end: number } {
    return { ...this.winnerRange };
  }

  isWinningRank(rank: number): boolean {
    return rank >= this.winnerRange.start && rank <= this.winnerRange.end;
  }

  getWinners(): readonly MarblePresentationState[] {
    return this.winners.slice();
  }

  getResult(): readonly MarblePresentationState[] | null {
    return this.result ? this.result.slice() : null;
  }

  getTargetIndex(): number {
    return this.winnerRange.end - this.winners.length;
  }

  setParticipants(names: string[]): MarbleSpawnLayout | null {
    if (!this.isInitialized) return null;

    if (!sameStrings(this.participantInputs, names)) this.discardAuthoritativeStandby();
    this.participantInputs = names.slice();
    return this.state === 'ready' || this.state === 'finished' ? this.rebuildPreview(true) : this.rebuildParticipants();
  }

  rebuildMarblesForCurrentParticipants(): MarbleSpawnLayout | null {
    if (!this.isInitialized || this.state !== 'ready') return null;
    return this.rebuildPreview(true);
  }

  /**
   * Recreate the complete authoritative round state from the stage's initial
   * physics state. Fairness predictions start from this same state.
   */
  rebuildAuthoritativeRoundForCurrentParticipants(): MarbleSpawnLayout | null {
    if (!this.isInitialized || (this.state !== 'ready' && this.state !== 'finished')) return null;
    return this.rebuildParticipants();
  }

  /**
   * Prepare a canonical t=0 race away from the Start click. The standby owns
   * its own physics world, so the moving ready-screen preview can continue
   * independently until the prepared round is adopted.
   */
  prepareAuthoritativeStandby(seed: Seed): Promise<MarbleSpawnLayout | null> {
    if (!this.isInitialized || (this.state !== 'ready' && this.state !== 'finished') || !this.stage) {
      return Promise.resolve(null);
    }

    const setup = getSimulationParticipantSetup(this.participantInputs);
    if (!setup || setup.totalCount <= 0 || setup.totalCount > MAX_MARBLES) return Promise.resolve(null);
    const stage = this.stage;
    const skillsEnabled = this.getSkillsEnabled();
    const pending = this.standbyPromiseSpec;
    if (
      this.standbyPromise &&
      pending &&
      pending.seed === seed &&
      pending.stage === stage &&
      pending.skillsEnabled === skillsEnabled &&
      sameStrings(pending.participantInputs, this.participantInputs)
    ) {
      return this.standbyPromise;
    }
    const current = this.authoritativeStandby;
    if (
      current &&
      current.seed === seed &&
      current.stage === stage &&
      current.skillsEnabled === skillsEnabled &&
      sameStrings(current.participantInputs, this.participantInputs)
    ) {
      return Promise.resolve(current.layout);
    }
    if (current) {
      this.authoritativeStandby = null;
      this.retireSimulation(current.simulation);
    }

    const requestId = ++this.standbyRequestId;
    const simulation = new RaceSimulation(undefined, seed);
    const spawnLayout = getMarbleSpawnLayout(setup.totalCount, stage.spawn);
    const promise = (async () => {
      try {
        await simulation.init();
        if (requestId !== this.standbyRequestId) {
          simulation.dispose();
          return null;
        }
        simulation.loadStage(stage);
        simulation.setSkillsEnabled(skillsEnabled);
        simulation.replaceMarbles(setup.participants, setup.totalCount, spawnLayout.positions, seed, false);
        if (requestId !== this.standbyRequestId || this.state === 'running') {
          simulation.dispose();
          return null;
        }
        this.authoritativeStandby = {
          simulation,
          seed,
          stage,
          participantInputs: this.participantInputs.slice(),
          skillsEnabled,
          layout: spawnLayout,
          count: setup.totalCount,
        };
        return spawnLayout;
      } catch {
        simulation.dispose();
        return null;
      }
    })();
    let trackedPromise!: Promise<MarbleSpawnLayout | null>;
    trackedPromise = promise.then(
      (layout) => {
        if (this.standbyPromise === trackedPromise) {
          this.standbyPromise = null;
          this.standbyPromiseSpec = null;
        }
        return layout;
      },
      (error) => {
        if (this.standbyPromise === trackedPromise) {
          this.standbyPromise = null;
          this.standbyPromiseSpec = null;
        }
        throw error;
      }
    );
    this.standbyPromise = trackedPromise;
    this.standbyPromiseSpec = {
      seed,
      stage,
      skillsEnabled,
      participantInputs: this.participantInputs.slice(),
    };
    return trackedPromise;
  }

  /** Adopt a previously prepared canonical round without rebuilding bodies. */
  adoptPreparedAuthoritativeRound(seed: Seed): MarbleSpawnLayout | null {
    const standby = this.authoritativeStandby;
    if (
      !standby ||
      standby.seed !== seed ||
      standby.stage !== this.stage ||
      standby.skillsEnabled !== this.getSkillsEnabled() ||
      !sameStrings(standby.participantInputs, this.participantInputs) ||
      (this.state !== 'ready' && this.state !== 'finished')
    ) {
      return null;
    }

    const previousSimulation = this.simulation;
    this.simulation = standby.simulation;
    this.authoritativeStandby = null;
    this.standbyRequestId++;
    this.previewMarbles = [];
    this.clearResults();
    this.configuredCount = standby.count;
    this.seed = seed;
    this.state = 'ready';
    this.retireSimulation(previousSimulation);
    return standby.layout;
  }

  discardAuthoritativeStandby(): void {
    this.standbyRequestId++;
    this.standbyPromise = null;
    this.standbyPromiseSpec = null;
    const standby = this.authoritativeStandby;
    this.authoritativeStandby = null;
    if (standby) this.retireSimulation(standby.simulation);
  }

  setMap(stage: StageDef): MarbleSpawnLayout | null {
    if (!this.isInitialized) return null;

    const isPreviewState = this.state === 'ready' || this.state === 'finished';
    this.discardAuthoritativeStandby();
    this.stage = stage;
    if (isPreviewState) {
      // A map change still needs a full stage/world reset, but a ready-screen
      // preview must not leave authoritative marble bodies behind. The next
      // Start will create those bodies from this canonical stage as needed.
      this.simulation.clearMarbles();
      this.simulation.loadStage(stage);
      return this.rebuildPreview(true);
    }
    return this.rebuildParticipants();
  }

  reset(): void {
    if (!this.isInitialized) return;

    this.discardAuthoritativeStandby();
    this.simulation.resetTiming();
    this.invalidateRound();
    this.simulation.clearMarbles();
    this.previewMarbles = [];
    this.configuredCount = 0;
    this.clearResults();
    this.state = 'ready';
    if (this.stage) {
      this.simulation.loadStage(this.stage);
    }
  }

  clearMarbles(): void {
    if (!this.isInitialized) return;

    this.discardAuthoritativeStandby();
    this.invalidateRound();
    this.simulation.clearMarbles();
    this.previewMarbles = [];
    this.configuredCount = 0;
    this.clearResults();
    this.state = 'ready';
  }

  prepareStart(): number | null {
    if (this.state === 'finished') {
      if (!this.rebuildParticipants()) return null;
    }
    if (this.state !== 'ready') return null;
    if (this.simulation.getCount() === 0 && this.configuredCount > 0) {
      if (!this.rebuildParticipants()) return null;
    }
    if (this.simulation.getCount() === 0) return null;

    this.simulation.resetInterpolationSnapshots();
    this.state = 'running';
    this.roundId++;
    this.winnerRange = clipWinnerRange(this.winnerRange.start, this.winnerRange.end, this.simulation.getCount());
    return this.roundId;
  }

  activate(generation: number): boolean {
    if (this.state !== 'running' || this.roundId !== generation) return false;

    this.simulation.start();
    return true;
  }

  isRunning(generation: number): boolean {
    return this.state === 'running' && this.roundId === generation;
  }

  advance(frameDelta: number, speed: number, fastForwardSpeed: number, callbacks: RoundStepCallbacks): number {
    const simulationCallbacks: SimulationStepCallbacks = {
      onImpact: callbacks.onImpact,
      onFinish: (marble) => {
        this.winners.push(marble);
        callbacks.onFinish(marble, this.isWinningRank(this.winners.length - 1));
      },
      afterStep: callbacks.afterStep,
      onStepComplete: callbacks.onStepComplete,
    };
    return this.simulation.advance(frameDelta, speed, fastForwardSpeed, simulationCallbacks);
  }

  checkFinish(): RoundFinish | null {
    if (this.state !== 'running') return null;

    const { start, end } = this.winnerRange;
    const lastMarble = this.simulation.getActiveMarblePresentationAt(0);
    const early = this.winners.length > 0 && this.simulation.getCount() === 1;
    const ranked = early && lastMarble ? [...this.winners, lastMarble] : this.winners;
    if (ranked.length <= end) return null;

    const earlyWinning = early && this.isWinningRank(this.winners.length);
    this.result = ranked.slice(start, end + 1);
    this.state = 'finished';
    // The finished result is retained in presentation state, so the
    // authoritative bodies can be released before the next Shuffle click.
    // This keeps the ready-screen path free of Box2D destruction work.
    this.simulation.clearMarbles();
    this.previewMarbles = [];
    return {
      result: this.result.slice(),
      early,
      earlyWinning,
    };
  }

  getCount(): number {
    return this.state === 'running' ? this.simulation.getCount() : this.configuredCount;
  }

  getActiveMarbleY(index: number): number | undefined {
    return this.simulation.getActiveMarbleY(index);
  }

  hasActiveMarbleAt(index: number): boolean {
    return this.simulation.hasActiveMarbleAt(index);
  }

  getActiveMarblePresentationAt(index: number): MarblePresentationState | undefined {
    return this.simulation.getActiveMarblePresentationAt(index);
  }

  getRenderStates(alpha: number): RaceRenderState {
    const renderStates = this.simulation.getRenderStates(alpha);
    if (this.state === 'ready' && this.previewMarbles.length > 0) {
      return { ...renderStates, marbles: this.previewMarbles };
    }
    return renderStates;
  }

  resetTiming(): void {
    this.simulation.resetTiming();
  }

  resetInterpolationSnapshots(): void {
    this.simulation.resetInterpolationSnapshots();
  }

  private rebuildParticipants(): MarbleSpawnLayout | null {
    this.reset();
    if (!this.stage) return null;

    const setup = getSimulationParticipantSetup(this.participantInputs);
    if (!setup || setup.totalCount > MAX_MARBLES) {
      this.configuredCount = 0;
      this.previewMarbles = [];
      return null;
    }

    const spawnLayout = getMarbleSpawnLayout(setup.totalCount, this.stage.spawn);
    this.configuredCount = setup.totalCount;
    this.seed = this.simulation.prepareSeedForRebuild();
    this.simulation.replaceMarbles(setup.participants, setup.totalCount, spawnLayout.positions, this.seed, false);
    this.previewMarbles = [];
    this.seed = this.simulation.getSeed();
    return spawnLayout;
  }

  private rebuildPreview(chooseNewSeed: boolean): MarbleSpawnLayout | null {
    if (!this.stage) return null;

    const setup = getSimulationParticipantSetup(this.participantInputs);
    if (!setup || setup.totalCount > MAX_MARBLES) {
      this.configuredCount = 0;
      this.previewMarbles = [];
      return null;
    }

    // The normal ready path already has no authoritative bodies. Keep this
    // guard for callers that leave a prepared authoritative round in the
    // ready state, so a later preview rebuild can never keep stale bodies.
    if (this.simulation.getCount() > 0) this.simulation.clearMarbles();
    this.simulation.resetTiming();
    this.invalidateRound();
    this.clearResults();
    this.state = 'ready';
    this.configuredCount = setup.totalCount;
    if (chooseNewSeed) this.seed = this.simulation.prepareSeedForRebuild();
    const spawnLayout = getMarbleSpawnLayout(setup.totalCount, this.stage.spawn);
    this.previewMarbles = createMarblePreviewStates(
      setup.participants,
      setup.totalCount,
      spawnLayout.positions,
      this.seed
    );
    return spawnLayout;
  }

  private invalidateRound(): void {
    this.roundId++;
  }

  private clearResults(): void {
    this.winners = [];
    this.result = null;
  }

  private retireSimulation(simulation: RaceSimulation): void {
    if (simulation === this.simulation) return;
    const dispose = () => simulation.dispose();
    const idleScheduler = (
      globalThis as typeof globalThis & {
        requestIdleCallback?: (callback: () => void) => unknown;
      }
    ).requestIdleCallback;
    if (typeof idleScheduler === 'function') idleScheduler(dispose);
    else if (typeof setTimeout === 'function') setTimeout(dispose, 0);
    else dispose();
  }
}
