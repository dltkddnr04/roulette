import type { ParticleRenderState } from './particle';
import { Particle } from './particle';

export class ParticleManager {
  private _particles: Particle[] = [];

  update(deltaTime: number) {
    this._particles.forEach((particle) => {
      particle.update(deltaTime);
    });
    this._particles = this._particles.filter((particle) => !particle.isDestroy);
  }

  clear(): void {
    this._particles = [];
  }

  getRenderStates(): readonly ParticleRenderState[] {
    return this._particles.map((particle) => particle.getRenderState());
  }

  shot(x: number, y: number) {
    for (let i = 0; i < 200; i++) {
      this._particles.push(new Particle(x, y));
    }
  }
}
