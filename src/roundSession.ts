import type { StageDef } from './data/maps';
import { type RaceRenderState, RaceSimulation, type SimulationStepCallbacks } from './raceSimulation';
import type { MarblePresentationState } from './types/MarbleRenderState.type';
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

export class RoundSession {
  private readonly simulation: RaceSimulation;
  private state: RoundState = 'initializing';
  private stage: StageDef | null = null;
  private participantInputs: string[] = [];
  private seed: Seed;
  private winners: MarblePresentationState[] = [];
  private result: MarblePresentationState[] | null = null;
  private winnerRange = { start: 0, end: 0 };
  private roundId = 0;

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
    this.stage = stage;
    this.simulation.loadStage(stage);
  }

  setSeed(seed: Seed): void {
    this.seed = seed;
    this.simulation.setSeed(seed);
  }

  setRandomSeedMode(): void {
    this.simulation.setRandomSeedMode();
  }

  getParticipantInputs(): readonly string[] {
    return this.participantInputs.slice();
  }

  setSkillsEnabled(enabled: boolean): boolean {
    if (this.simulation.getSkillsEnabled() === enabled) return false;
    this.simulation.setSkillsEnabled(enabled);
    return true;
  }

  getSkillsEnabled(): boolean {
    return this.simulation.getSkillsEnabled();
  }

  setWinnerRange(start: number, end: number): boolean {
    const nextRange = clipWinnerRange(start, end, this.simulation.getCount());
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

    this.participantInputs = names.slice();
    return this.state === 'ready' ? this.rebuildMarbles() : this.rebuildParticipants();
  }

  rebuildMarblesForCurrentParticipants(): MarbleSpawnLayout | null {
    if (!this.isInitialized || this.state !== 'ready') return null;
    return this.rebuildMarbles();
  }

  setMap(stage: StageDef): MarbleSpawnLayout | null {
    if (!this.isInitialized) return null;

    this.stage = stage;
    return this.rebuildParticipants();
  }

  reset(): void {
    if (!this.isInitialized) return;

    this.simulation.resetTiming();
    this.invalidateRound();
    this.simulation.clearMarbles();
    this.clearResults();
    this.state = 'ready';
    if (this.stage) {
      this.simulation.loadStage(this.stage);
    }
  }

  clearMarbles(): void {
    if (!this.isInitialized) return;

    this.invalidateRound();
    this.simulation.clearMarbles();
    this.clearResults();
    this.state = 'ready';
  }

  prepareStart(): number | null {
    if (this.state !== 'ready' || this.simulation.getCount() === 0) return null;

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
    return {
      result: this.result.slice(),
      early,
      earlyWinning,
    };
  }

  getCount(): number {
    return this.simulation.getCount();
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
    return this.simulation.getRenderStates(alpha);
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
    if (!setup || setup.totalCount > MAX_MARBLES) return null;

    const spawnLayout = getMarbleSpawnLayout(setup.totalCount, this.stage.spawn);
    this.simulation.replaceMarbles(setup.participants, setup.totalCount, spawnLayout.positions);
    this.seed = this.simulation.getSeed();
    return spawnLayout;
  }

  private rebuildMarbles(): MarbleSpawnLayout | null {
    if (!this.stage) return null;

    const setup = getSimulationParticipantSetup(this.participantInputs);
    if (!setup || setup.totalCount > MAX_MARBLES) return null;

    this.simulation.resetTiming();
    this.invalidateRound();
    this.simulation.clearMarbles();
    this.clearResults();
    this.state = 'ready';
    const spawnLayout = getMarbleSpawnLayout(setup.totalCount, this.stage.spawn);
    this.simulation.replaceMarbles(setup.participants, setup.totalCount, spawnLayout.positions);
    this.seed = this.simulation.getSeed();
    return spawnLayout;
  }

  private invalidateRound(): void {
    this.roundId++;
  }

  private clearResults(): void {
    this.winners = [];
    this.result = null;
  }
}
