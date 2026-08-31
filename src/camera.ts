import { initialZoom, zoomThreshold } from './data/constants';
import type { StageDef } from './data/maps';
import type { MarbleRenderState } from './types/MarbleRenderState.type';
import type { VectorLike } from './types/VectorLike';

const REFERENCE_FRAME_TIME = 1000 / 60;
const MAX_CAMERA_DELTA_TIME = 100;

export class Camera {
  private _position: VectorLike = { x: 0, y: 0 };
  private _targetPosition: VectorLike = { x: 0, y: 0 };
  private _zoom: number = 1;
  private _targetZoom: number = 1;
  private _locked = false;
  private _shouldFollowMarbles = false;

  get zoom(): number {
    return this._zoom;
  }

  get x(): number {
    return this._position.x;
  }

  get y(): number {
    return this._position.y;
  }

  get position(): VectorLike {
    return { x: this._position.x, y: this._position.y };
  }

  setTargetPosition(v: VectorLike): void {
    this._targetPosition = { x: v.x, y: v.y };
  }

  setTargetZoom(v: number): void {
    this._targetZoom = v;
  }

  lock(v: boolean) {
    this._locked = v;
  }

  startFollowingMarbles() {
    this._shouldFollowMarbles = true;
  }

  initializePosition(center?: VectorLike, zoom?: number) {
    const x = center?.x ?? 12.95;
    const y = center?.y ?? 2;
    const z = zoom ?? 1;

    this._position = { x, y };
    this._targetPosition = { x, y };
    this._zoom = z;
    this._targetZoom = z;
    this._shouldFollowMarbles = false;
  }

  update({
    marbleRenderStates,
    stage,
    needToZoom,
    targetIndex,
    deltaTime,
  }: {
    marbleRenderStates: MarbleRenderState[];
    stage: StageDef;
    needToZoom: boolean;
    targetIndex: number;
    deltaTime: number;
  }) {
    // set target position
    if (!this._locked) {
      this._calcTargetPositionAndZoom(marbleRenderStates, stage, needToZoom, targetIndex);
    }

    // Clamp camera time only; physics wall-clock/debt handling must remain lossless.
    const smoothingDeltaTime = Math.min(Math.max(deltaTime, 0), MAX_CAMERA_DELTA_TIME);

    // Exponential smoothing preserves the old 60 FPS response across refresh rates.
    this._position.x = this._interpolation(this.x, this._targetPosition.x, 120, smoothingDeltaTime);
    this._position.y = this._interpolation(this.y, this._targetPosition.y, 10, smoothingDeltaTime);

    // interpolate zoom
    this._zoom = this._interpolation(this._zoom, this._targetZoom, 10, smoothingDeltaTime);
  }

  private _calcTargetPositionAndZoom(
    marbleRenderStates: MarbleRenderState[],
    stage: StageDef,
    needToZoom: boolean,
    targetIndex: number
  ) {
    if (!this._shouldFollowMarbles) {
      return;
    }

    if (marbleRenderStates.length > 0) {
      const targetMarble = marbleRenderStates[targetIndex] ? marbleRenderStates[targetIndex] : marbleRenderStates[0];
      this.setTargetPosition(targetMarble.position);
      if (needToZoom) {
        const goalDist = Math.abs(stage.camera.zoomTriggerY - this._position.y);
        this.setTargetZoom(Math.max(1, (1 - goalDist / zoomThreshold) * 4));
      } else {
        this.setTargetZoom(1);
      }
    } else {
      this.setTargetZoom(1);
    }
  }

  private _interpolation(current: number, target: number, delta: number, deltaTime: number) {
    const d = target - current;
    if (Math.abs(d) < 1 / initialZoom) {
      return target;
    }

    const factor = 1 - (1 - 1 / delta) ** (deltaTime / REFERENCE_FRAME_TIME);
    return current + d * factor;
  }

  renderScene(
    ctx: CanvasRenderingContext2D,
    callback: (ctx: CanvasRenderingContext2D) => void,
    viewportSize?: VectorLike
  ) {
    const zoomFactor = initialZoom * 2 * this._zoom;
    const viewportWidth = viewportSize?.x ?? ctx.canvas.width;
    const viewportHeight = viewportSize?.y ?? ctx.canvas.height;
    ctx.save();
    ctx.translate(-this.x * this._zoom, -this.y * this._zoom);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(viewportWidth / zoomFactor, viewportHeight / zoomFactor);
    callback(ctx);
    ctx.restore();
  }
}
