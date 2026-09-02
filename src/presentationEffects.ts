import type { ParticleRenderState } from './particle';
import { ParticleManager } from './particleManager';
import { SkillEffect, type SkillEffectRenderState } from './skillEffect';
import type { VectorLike } from './types/VectorLike';

export type PresentationEffectsRenderState = Readonly<{
  skillEffects: readonly SkillEffectRenderState[];
  particles: readonly ParticleRenderState[];
}>;

export class PresentationEffects {
  private skillEffects: SkillEffect[] = [];
  private readonly particles = new ParticleManager();

  addImpact(position: VectorLike): void {
    this.skillEffects.push(new SkillEffect(position.x, position.y));
  }

  shot(width: number, height: number): void {
    this.particles.shot(width, height);
  }

  update(deltaTime: number): void {
    this.particles.update(deltaTime);
    this.skillEffects.forEach((effect) => effect.update(deltaTime));
    this.skillEffects = this.skillEffects.filter((effect) => !effect.isDestroy);
  }

  clear(): void {
    this.skillEffects = [];
    this.particles.clear();
  }

  getRenderState(): PresentationEffectsRenderState {
    return {
      skillEffects: this.skillEffects.map((effect) => effect.getRenderState()),
      particles: this.particles.getRenderStates(),
    };
  }
}
