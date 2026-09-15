import type { StageDef } from './data/maps';
import type { MapEntityRenderState } from './types/MapEntity.type';
import type { Transform } from './utils/interpolation';

export interface IPhysics {
  init(): Promise<void>;

  clearEntities(): void;

  clearMarbles(): void;

  /** Remove at most `limit` marble bodies. Returns true when complete. */
  clearMarblesBatch?(limit: number): boolean;

  resetWorld(): void;

  loadStage(stage: StageDef): void;

  /** Begin a stage load that can be continued in bounded batches. */
  beginStageLoad?(stage: StageDef): void;

  /** Create at most `limit` stage fixture work units. Returns true when complete. */
  loadStageEntityBatch?(limit: number): boolean;

  createMarble(id: number, x: number, y: number): void;

  shakeMarble(id: number): void;

  removeMarble(id: number): void;

  getMarblePosition(id: number): Transform | undefined;

  getEntityRenderStates(): MapEntityRenderState[];

  impact(id: number): void;

  start(): void;

  step(deltaSeconds: number): void;

  dispose?(): void;
}
