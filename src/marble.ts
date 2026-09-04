import { MARBLE_RENDER_DIAMETER, Skills, STUCK_DELAY } from './data/constants';
import type { IPhysics } from './IPhysics';
import type { MarblePresentationState, MarbleRenderState } from './types/MarbleRenderState.type';
import type { VectorLike } from './types/VectorLike';
import type { Transform } from './utils/interpolation';
import type { RandomSource } from './utils/random';
import { Vector } from './utils/Vector';

export class Marble {
  readonly name: string;
  readonly weight: number;
  readonly hue: number;
  readonly id: number;

  impact = 0;
  skill: Skills = Skills.None;
  isActive = false;

  private _skillRate = 0.0005;
  private _coolTime = 5000;
  private _maxCoolTime = 5000;
  private _stuckTime = 0;
  private lastPosition: VectorLike = { x: 0, y: 0 };

  private physics: IPhysics;
  private readonly randomSource: RandomSource;

  get position(): Transform | undefined {
    return this.physics.getMarblePosition(this.id);
  }

  get x(): number {
    return this.requirePosition().x;
  }

  get y(): number {
    return this.requirePosition().y;
  }

  constructor(
    physics: IPhysics,
    order: number,
    max: number,
    spawnPosition: VectorLike,
    randomSource: RandomSource,
    name?: string,
    weight: number = 1
  ) {
    this.name = name || `M${order}`;
    this.weight = weight;
    this.physics = physics;
    this.randomSource = randomSource;

    this._maxCoolTime = 1000 + (1 - this.weight) * 4000;
    this._coolTime = this._maxCoolTime * this.randomSource.next();
    this._skillRate = 0.2 * this.weight;

    this.hue = (360 / max) * order;
    this.id = order;

    physics.createMarble(order, spawnPosition.x, spawnPosition.y);
  }

  getSimulationPosition(): Transform {
    return this.requirePosition();
  }

  getRenderState(position: Transform): MarbleRenderState {
    return {
      id: this.id,
      name: this.name,
      hue: this.hue,
      size: MARBLE_RENDER_DIAMETER,
      impact: this.impact,
      coolTime: this._coolTime,
      maxCoolTime: this._maxCoolTime,
      position,
    };
  }

  getPresentationState(): MarblePresentationState {
    return {
      id: this.id,
      name: this.name,
      hue: this.hue,
    };
  }

  private requirePosition(): Transform {
    const position = this.position;
    if (!position) {
      throw new Error(`Marble ${this.id} has no physics body`);
    }
    return position;
  }

  update(deltaTime: number, skillsEnabled = true) {
    if (this.isActive && Vector.lenSq(Vector.sub(this.lastPosition, this.requirePosition())) < 0.00001) {
      this._stuckTime += deltaTime;

      if (this._stuckTime > STUCK_DELAY) {
        this.physics.shakeMarble(this.id);
        this._stuckTime = 0;
      }
    } else {
      this._stuckTime = 0;
    }
    const position = this.requirePosition();
    this.lastPosition = { x: position.x, y: position.y };

    this.skill = Skills.None;
    if (this.impact) {
      this.impact = Math.max(0, this.impact - deltaTime);
    }
    if (!this.isActive) return;
    if (skillsEnabled) {
      this._updateSkillInformation(deltaTime);
    }
  }

  private _updateSkillInformation(deltaTime: number) {
    if (this._coolTime > 0) {
      this._coolTime -= deltaTime;
    }

    if (this._coolTime <= 0) {
      this.skill = this.randomSource.next() < this._skillRate ? Skills.Impact : Skills.None;
      this._coolTime = this._maxCoolTime;
    }
  }
}
