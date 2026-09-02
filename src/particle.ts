import type { VectorLike } from './types/VectorLike';
import { rad } from './utils/utils';
import { Vector } from './utils/Vector';

const lifetime = 3000;

export type ParticleRenderState = Readonly<{
  x: number;
  y: number;
  color: string;
  alpha: number;
}>;

export class Particle {
  private _elapsed: number = 0;
  position: VectorLike = { x: 0, y: 0 };
  force: VectorLike = { x: 0, y: 0 };
  color: string = '';
  isDestroy: boolean = false;

  constructor(x: number, y: number) {
    this.position.x = x;
    this.position.y = y;

    const force = Math.random() * 250;
    const ang = rad(90 * Math.random() - 180);
    const fx = Math.cos(ang) * force;
    const fy = Math.sin(ang) * force;
    this.color = `hsl(${Math.random() * 360} 50% 50%)`;
    this.force = { x: fx, y: fy };
  }

  update(deltaTime: number) {
    this._elapsed += deltaTime;
    const delta = Vector.mul(this.force, deltaTime / 100);
    this.position = Vector.add(this.position, delta);
    this.force.y += (10 * deltaTime) / 100;
    if (this._elapsed > lifetime) {
      this.isDestroy = true;
    }
  }

  getRenderState(): ParticleRenderState {
    return {
      x: this.position.x,
      y: this.position.y,
      color: this.color,
      alpha: 1 - (this._elapsed / lifetime) ** 2,
    };
  }
}
