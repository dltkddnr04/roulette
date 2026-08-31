import type { StageDef } from './data/maps';
import type { IPhysics } from './IPhysics';
import { Marble } from './marble';
import { Box2dPhysics } from './physics-box2d';
import type { MapEntityRenderState } from './types/MapEntity.type';
import type { MarblePresentationState, MarbleRenderState } from './types/MarbleRenderState.type';
import type { VectorLike } from './types/VectorLike';
import type { Transform } from './utils/interpolation';
import { interpolateTransform } from './utils/interpolation';
import { createRandomSeed, createSeededRandom, type Seed, type SeededRandomSource } from './utils/random';
import { shuffle } from './utils/utils';

export const FIXED_PHYSICS_INTERVAL = 10;
export const MAX_PHYSICS_STEPS_PER_FRAME = 8;

export type MarbleParticipant = Readonly<{
  name: string;
  weight: number;
  count: number;
}>;

export type SimulationStepCallbacks = {
  onImpact: (position: VectorLike) => void;
  onFinish: (marble: MarblePresentationState) => void;
  afterStep: () => number;
  onStepComplete: () => void;
};

export type RaceRenderState = {
  marbles: MarbleRenderState[];
  entities: MapEntityRenderState[];
};

export function getStepBudget(updateInterval: number, timeScale: number): number {
  return updateInterval / timeScale;
}

export function preservePhysicsDebt(
  accumulatedTime: number,
  stepBudget: number
): {
  debt: number;
  remainder: number;
} {
  if (accumulatedTime < stepBudget) {
    return { debt: 0, remainder: accumulatedTime };
  }

  const debt = Math.floor(accumulatedTime / stepBudget) * stepBudget;
  return { debt, remainder: accumulatedTime - debt };
}

export class RaceSimulation {
  private readonly physics: IPhysics;
  private readonly randomSource: SeededRandomSource;
  private marbles: Marble[] = [];

  private elapsed = 0;
  private physicsDebt = 0;
  private timeScale = 1;
  private stage: StageDef | null = null;
  private seed: Seed;
  // An omitted seed gets a new seed whenever participants are rebuilt; an
  // explicit seed keeps the stream stable across those rebuilds.
  private hasExplicitSeed: boolean;

  private previousEntities: MapEntityRenderState[] = [];
  private currentEntities: MapEntityRenderState[] = [];
  private previousMarbleTransforms = new Map<number, Transform>();
  private currentMarbleTransforms = new Map<number, Transform>();

  constructor(physics?: IPhysics, seed?: Seed) {
    this.seed = seed ?? createRandomSeed();
    this.hasExplicitSeed = seed !== undefined;
    this.randomSource = createSeededRandom(this.seed);
    this.physics = physics ?? new Box2dPhysics(this.randomSource);
  }

  /** Configure the seed for the next participant rebuild without rewinding a running race. */
  setSeed(seed: Seed): void {
    if (typeof seed === 'number' && !Number.isFinite(seed)) {
      throw new Error('Seed must be finite');
    }
    this.seed = seed;
    this.hasExplicitSeed = true;
  }

  getSeed(): Seed {
    return this.seed;
  }

  async init(): Promise<void> {
    await this.physics.init();
  }

  loadStage(stage: StageDef): void {
    this.stage = stage;
    this.physics.loadStage(stage);
    this.resetInterpolationSnapshots();
  }

  replaceMarbles(participants: readonly MarbleParticipant[], totalCount: number, spawnPositions: VectorLike[]): void {
    this.clearMarbles();
    if (!this.hasExplicitSeed) {
      this.seed = createRandomSeed();
    }
    this.randomSource.reset(this.seed);

    const orders = shuffle(
      Array(totalCount)
        .fill(0)
        .map((_, i) => i),
      this.randomSource
    );
    participants.forEach((participant) => {
      for (let i = 0; i < participant.count; i++) {
        const order = orders.pop() || 0;
        this.marbles.push(
          new Marble(
            this.physics,
            order,
            totalCount,
            spawnPositions[order],
            this.randomSource,
            participant.name,
            participant.weight
          )
        );
      }
    });
    this.resetInterpolationSnapshots();
  }

  clearMarbles(): void {
    this.physics.clearMarbles();
    this.marbles = [];
    this.previousMarbleTransforms.clear();
    this.currentMarbleTransforms.clear();
  }

  resetTiming(): void {
    this.elapsed = 0;
    this.physicsDebt = 0;
  }

  resetInterpolationSnapshots(): void {
    this.captureCurrentMarbleTransforms();
    this.previousMarbleTransforms = new Map(
      [...this.currentMarbleTransforms].map(([id, transform]) => [id, { ...transform }])
    );
    const entities = this.copyEntityStates(this.physics.getEntityRenderStates());
    this.previousEntities = entities;
    this.currentEntities = this.copyEntityStates(entities);
  }

  start(): void {
    this.physics.start();
    this.marbles.forEach((marble) => (marble.isActive = true));
  }

  getCount(): number {
    return this.marbles.length;
  }

  getActiveMarbleY(index: number): number | undefined {
    return this.marbles[index]?.y;
  }

  hasActiveMarbleAt(index: number): boolean {
    return this.marbles[index] !== undefined;
  }

  getActiveMarblePresentationAt(index: number): MarblePresentationState | undefined {
    return this.marbles[index]?.getPresentationState();
  }

  getRenderStates(alpha: number): RaceRenderState {
    return {
      marbles: this.getMarbleRenderStates(alpha),
      entities: this.getInterpolatedEntities(alpha),
    };
  }

  advance(frameDelta: number, speed: number, fastForwardSpeed: number, callbacks: SimulationStepCallbacks): number {
    this.elapsed += frameDelta * speed * fastForwardSpeed;

    let accumulatedTime = this.physicsDebt + this.elapsed;
    this.physicsDebt = 0;
    let physicsSteps = 0;

    // Keep each Box2D step fixed at 10ms. The cap prevents a long stall from
    // monopolizing a frame, while the unprocessed whole budgets remain debt.
    while (physicsSteps < MAX_PHYSICS_STEPS_PER_FRAME) {
      const stepBudget = getStepBudget(FIXED_PHYSICS_INTERVAL, this.timeScale);
      if (accumulatedTime < stepBudget) break;

      this.capturePreviousTransforms();
      this.physics.step(FIXED_PHYSICS_INTERVAL / 1000);
      if (this.marbles.length > 1) {
        this.marbles.sort((a, b) => b.y - a.y || a.id - b.id);
      }
      this.currentEntities = this.copyEntityStates(this.physics.getEntityRenderStates());
      this.updateMarbles(callbacks);

      this.timeScale = callbacks.afterStep();
      this.captureCurrentMarbleTransforms();

      accumulatedTime -= stepBudget;
      physicsSteps++;
      callbacks.onStepComplete();
    }

    const stepBudget = getStepBudget(FIXED_PHYSICS_INTERVAL, this.timeScale);
    const preserved = preservePhysicsDebt(accumulatedTime, stepBudget);
    this.physicsDebt = preserved.debt;
    this.elapsed = preserved.remainder;

    return this.elapsed / stepBudget;
  }

  private updateMarbles(callbacks: SimulationStepCallbacks): void {
    const finishedMarbles: Marble[] = [];
    const finishY = this.stage?.finish.y;

    for (const marble of this.marbles) {
      marble.update(FIXED_PHYSICS_INTERVAL);
      if (marble.skill) {
        const position = marble.getSimulationPosition();
        callbacks.onImpact({ x: position.x, y: position.y });
        this.physics.impact(marble.id);
      }
      if (finishY !== undefined && marble.y > finishY) {
        finishedMarbles.push(marble);
        callbacks.onFinish(marble.getPresentationState());
      }
    }

    // Filter before destroying bodies so no later path can read a finished
    // marble through a missing physics body.
    this.marbles = this.marbles.filter((marble) => !finishedMarbles.includes(marble));
    finishedMarbles.forEach((marble) => this.physics.removeMarble(marble.id));
  }

  private copyEntityStates(entities: MapEntityRenderState[]): MapEntityRenderState[] {
    return entities.map((entity) => ({ ...entity }));
  }

  private capturePreviousTransforms(): void {
    this.previousMarbleTransforms = new Map(
      [...this.currentMarbleTransforms].map(([id, transform]) => [id, { ...transform }])
    );
    this.previousEntities = this.copyEntityStates(this.currentEntities);
  }

  private captureCurrentMarbleTransforms(): void {
    this.currentMarbleTransforms = new Map(
      this.marbles.map((marble) => [marble.id, { ...marble.getSimulationPosition() }])
    );
  }

  private getMarbleRenderStates(alpha: number): MarbleRenderState[] {
    return this.marbles.map((marble) => {
      const current = this.currentMarbleTransforms.get(marble.id) ?? marble.getSimulationPosition();
      const previous = this.previousMarbleTransforms.get(marble.id) ?? current;
      return marble.getRenderState(interpolateTransform(previous, current, alpha));
    });
  }

  private getInterpolatedEntities(alpha: number): MapEntityRenderState[] {
    const previousById = new Map(this.previousEntities.map((entity) => [entity.id, entity]));
    return this.currentEntities.map((entity) => {
      const previous = previousById.get(entity.id);
      if (!previous) return { ...entity };

      return {
        ...entity,
        ...interpolateTransform(previous, entity, alpha),
      };
    });
  }
}
