import type { VectorLike } from './types/VectorLike';

const lifetime = 500;

export type SkillEffectRenderState = Readonly<{
  x: number;
  y: number;
  size: number;
  alpha: number;
}>;

export class SkillEffect {
  private _size: number = 0;
  position: VectorLike;
  private _elapsed: number = 0;
  isDestroy: boolean = false;

  constructor(x: number, y: number) {
    this.position = { x, y };
  }

  update(deltaTime: number) {
    this._elapsed += deltaTime;
    this._size = (this._elapsed / lifetime) * 10;
    if (this._elapsed > lifetime) {
      this.isDestroy = true;
    }
  }

  getRenderState(): SkillEffectRenderState {
    const rate = this._elapsed / lifetime;
    return {
      x: this.position.x,
      y: this.position.y,
      size: this._size,
      alpha: 1 - rate * rate,
    };
  }
}
