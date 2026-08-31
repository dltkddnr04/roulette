import type { StageDef } from './data/maps';
import type { MapEntityRenderState } from './types/MapEntity.type';
import type { Transform } from './utils/interpolation';

export interface IPhysics {
  init(): Promise<void>;

  clearEntities(): void;

  clearMarbles(): void;

  loadStage(stage: StageDef): void;

  createMarble(id: number, x: number, y: number): void;

  shakeMarble(id: number): void;

  removeMarble(id: number): void;

  getMarblePosition(id: number): Transform | undefined;

  getEntityRenderStates(): MapEntityRenderState[];

  impact(id: number): void;

  start(): void;

  step(deltaSeconds: number): void;
}
