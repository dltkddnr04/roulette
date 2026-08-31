import { Camera } from './camera';
import { canvasHeight, canvasWidth, initialZoom, Themes, zoomThreshold } from './data/constants';
import { stages } from './data/maps';
import { FastForwader } from './fastForwader';
import type { GameObject } from './gameObject';
import { Minimap } from './minimap';
import options, { isRenderScale, type RenderScale, type WinnerRange } from './options';
import { ParticleManager } from './particleManager';
import { FIXED_PHYSICS_INTERVAL, type RaceRenderState } from './raceSimulation';
import { RankRenderer } from './rankRenderer';
import { RouletteRenderer } from './rouletteRenderer';
import { RoundSession, type RoundState } from './roundSession';
import { SkillEffect } from './skillEffect';
import { type SponsorAssetInfo, SponsorManager, type SponsorState } from './sponsorStore';
import type { ColorTheme } from './types/ColorTheme';
import type { MouseEventHandlerName, MouseEventName } from './types/mouseEvents.type';
import type { UIObject } from './UIObject';
import { bound } from './utils/bound.decorator';
import type { Seed } from './utils/random';
import { VideoRecorder } from './utils/videoRecorder';

export type { RoundState } from './roundSession';

export class Roulette extends EventTarget {
  private _roundSession = new RoundSession();

  private _lastTime: number = 0;

  private _speed = 1;

  private _particleManager = new ParticleManager();

  protected _camera: Camera = new Camera();
  protected _renderer: RouletteRenderer;

  private _effects: GameObject[] = [];

  private _goalDist: number = Infinity;

  private _uiObjects: UIObject[] = [];

  private _autoRecording: boolean = false;
  private _recorder!: VideoRecorder;
  private _recordingStopTimer: ReturnType<typeof setTimeout> | null = null;
  private _recordingStartGeneration: number | null = null;
  private _activeRecordingGeneration: number | null = null;
  private _sponsorManager = new SponsorManager();

  protected fastForwarder!: FastForwader;
  protected _theme: ColorTheme = Themes.dark;

  /** Renderer/physics 초기화 완료 여부이며, 현재 round가 start 가능한지는 의미하지 않는다. */
  public get isReady(): boolean {
    return this._roundSession.isInitialized;
  }

  public get roundState(): RoundState {
    return this._roundSession.roundState;
  }

  protected createRenderer(): RouletteRenderer {
    return new RouletteRenderer();
  }

  protected createFastForwader(): FastForwader {
    return new FastForwader();
  }

  constructor() {
    super();
    document.addEventListener('visibilitychange', this._handleVisibilityChange);
    this._renderer = this.createRenderer();
    this._renderer.setRenderScale(options.renderScale);
    this._renderer.init().then(() => {
      this._init().then(() => {
        this._roundSession.markReady();
        this._update();
      });
    });
  }

  public getZoom() {
    return initialZoom * this._camera.zoom;
  }

  private addUiObject(obj: UIObject) {
    this._uiObjects.push(obj);
    if (obj.onWheel) {
      this._renderer.canvas.addEventListener('wheel', obj.onWheel);
    }
    if (obj.onMessage) {
      obj.onMessage((msg) => {
        console.log('onMessage', msg);
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      });
    }
  }

  @bound
  private _handleVisibilityChange() {
    this._lastTime = Date.now();
    if (document.hidden) return;

    this._roundSession.resetTiming();
    if (this._roundSession.isInitialized) {
      this._roundSession.resetInterpolationSnapshots();
    }
  }

  @bound
  private _update() {
    if (!this._lastTime) this._lastTime = Date.now();
    const currentTime = Date.now();
    const frameDelta = currentTime - this._lastTime;

    this._lastTime = currentTime;

    const alpha = this._roundSession.advance(frameDelta, this._speed, this.fastForwarder.speed, {
      onImpact: (position) => {
        this._effects.push(new SkillEffect(position.x, position.y));
      },
      onFinish: (_marble, isWinningRank) => {
        if (isWinningRank) {
          this._particleManager.shot(this._renderer.width, this._renderer.height);
        }
      },
      afterStep: () => {
        const targetIndex = this._targetIndex;
        const topY = this._roundSession.getActiveMarbleY(targetIndex) ?? 0;
        const stage = this._roundSession.currentStage;
        this._goalDist = Math.abs(stage ? stage.camera.zoomTriggerY - topY : Infinity);
        const timeScale = this._calcTimeScale();
        this._checkFinish();
        return timeScale;
      },
      onStepComplete: () => {
        this._particleManager.update(FIXED_PHYSICS_INTERVAL);
        this._updateEffects(FIXED_PHYSICS_INTERVAL);
        this._uiObjects.forEach((obj) => obj.update(FIXED_PHYSICS_INTERVAL));
      },
    });

    const renderStates = this._roundSession.getRenderStates(alpha);
    const stage = this._roundSession.currentStage;
    if (stage) {
      this._camera.update({
        marbleRenderStates: renderStates.marbles,
        stage,
        needToZoom: this._goalDist < zoomThreshold,
        targetIndex: this._roundSession.getWinners().length > 0 ? this._targetIndex : 0,
        deltaTime: frameDelta,
      });
    }

    this._render(alpha, renderStates);
    window.requestAnimationFrame(this._update);
  }

  /** 카메라와 슬로우모션이 주목할 구슬 = 당첨 커트라인에 걸쳐있는 구슬 */
  private get _targetIndex() {
    return this._roundSession.getTargetIndex();
  }

  private _clearRecordingStopTimer() {
    if (this._recordingStopTimer === null) return;

    clearTimeout(this._recordingStopTimer);
    this._recordingStopTimer = null;
  }

  private _invalidateRecording() {
    this._clearRecordingStopTimer();
    this._recordingStartGeneration = null;
    this._activeRecordingGeneration = null;
    if (this._recorder?.isRecording) {
      this._recorder.stop();
    }
  }

  private _checkFinish() {
    const finish = this._roundSession.checkFinish();
    if (!finish) return;

    if (finish.earlyWinning) {
      this._particleManager.shot(this._renderer.width, this._renderer.height);
    }

    this._clearRecordingStopTimer();
    this._recordingStopTimer = setTimeout(() => {
      this._recordingStopTimer = null;
      this._activeRecordingGeneration = null;
      this._recorder.stop();
    }, 1000);
    this.dispatchEvent(
      new CustomEvent('goal', {
        detail: { winner: finish.result[0].name, winners: finish.result.map((m) => m.name) },
      })
    );
  }

  private _calcTimeScale(): number {
    const stage = this._roundSession.currentStage;
    if (!stage) return 1;
    const targetIndex = this._targetIndex;
    const targetMarbleY = this._roundSession.getActiveMarbleY(targetIndex);
    const winnerRange = this._roundSession.getWinnerRange();
    if (this._roundSession.getWinners().length < winnerRange.end + 1 && this._goalDist < zoomThreshold) {
      if (
        targetMarbleY !== undefined &&
        targetMarbleY > stage.camera.zoomTriggerY - zoomThreshold * 1.2 &&
        (this._roundSession.hasActiveMarbleAt(targetIndex - 1) || this._roundSession.hasActiveMarbleAt(targetIndex + 1))
      ) {
        return Math.max(0.2, this._goalDist / zoomThreshold);
      }
    }
    return 1;
  }

  private _updateEffects(deltaTime: number) {
    this._effects.forEach((effect) => effect.update(deltaTime));
    this._effects = this._effects.filter((effect) => !effect.isDestroy);
  }

  private _render(alpha: number, renderStates: RaceRenderState) {
    const stage = this._roundSession.currentStage;
    if (!stage) return;
    const winners = this._roundSession.getWinners();
    const renderParams = {
      camera: this._camera,
      stage,
      sponsorImage: this._sponsorManager.renderImage,
      entities: renderStates.entities,
      marbles: renderStates.marbles,
      winners,
      particleManager: this._particleManager,
      effects: this._effects,
      winnerRange: this._roundSession.getWinnerRange(),
      result: this._roundSession.getResult(),
      size: { x: this._renderer.width, y: this._renderer.height },
      theme: this._theme,
      alpha,
    };
    this._renderer.render(renderParams, this._uiObjects);
  }

  private async _init() {
    this._recorder = new VideoRecorder(this._renderer.canvas);

    await this._roundSession.init();

    this.addUiObject(new RankRenderer());
    this.attachEvent();
    const minimap = new Minimap();
    minimap.onViewportChange((pos) => {
      if (pos) {
        this._camera.setTargetPosition(pos);
        this._camera.lock(true);
      } else {
        this._camera.lock(false);
      }
    });
    this.addUiObject(minimap);
    this.fastForwarder = this.createFastForwader();
    this.addUiObject(this.fastForwarder);
    this._roundSession.loadStage(stages[0]);
    this._camera.initializePosition();
  }

  @bound
  private mouseHandler(eventName: MouseEventName, e: MouseEvent) {
    const handlerName = `on${eventName}` as MouseEventHandlerName;

    const sizeFactor = this._renderer.sizeFactor;
    const pos = { x: e.offsetX * sizeFactor, y: e.offsetY * sizeFactor };
    this._uiObjects.forEach((obj) => {
      if (!obj[handlerName]) return;
      const bounds = obj.getBoundingBox();
      if (!bounds) {
        obj[handlerName]({ ...pos, button: e.button });
      } else if (
        bounds &&
        pos.x >= bounds.x &&
        pos.y >= bounds.y &&
        pos.x <= bounds.x + bounds.w &&
        pos.y <= bounds.y + bounds.h
      ) {
        obj[handlerName]({ x: pos.x - bounds.x, y: pos.y - bounds.y, button: e.button });
      } else {
        obj[handlerName](undefined);
      }
    });
  }

  private attachEvent() {
    const canvas = this._renderer.canvas;
    const onPointerRelease = (e: Event) => {
      this.mouseHandler('MouseUp', e as MouseEvent);
      window.removeEventListener('pointerup', onPointerRelease);
      window.removeEventListener('pointercancel', onPointerRelease);
    };

    canvas.addEventListener('pointerdown', (e: Event) => {
      this.mouseHandler('MouseDown', e as MouseEvent);
      window.addEventListener('pointerup', onPointerRelease);
      window.addEventListener('pointercancel', onPointerRelease);
    });

    ['MouseMove', 'DblClick'].forEach((ev) => {
      // @ts-expect-error
      canvas.addEventListener(ev.toLowerCase().replace('mouse', 'pointer'), this.mouseHandler.bind(this, ev));
    });
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    canvas.addEventListener('click', (e) => {
      if (this.resultCloseHitAt(e)) {
        this._renderer.closeResultPopup();
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      canvas.style.cursor = this.resultCloseHitAt(e) ? 'pointer' : '';
    });
  }

  public clearMarbles() {
    if (!this._roundSession.isInitialized) return;

    this._invalidateRecording();
    this._roundSession.clearMarbles();
  }

  public async startRecording() {
    if (!this._roundSession.isInitialized) return;
    if (!this._autoRecording) return;
    try {
      await this._recorder.start();
    } catch (e) {
      console.error('recording failed to start', e);
    }
  }

  public start() {
    const roundGeneration = this._roundSession.prepareStart();
    if (roundGeneration === null) return;

    this._clearRecordingStopTimer();
    this._camera.startFollowingMarbles();

    const startPhysics = () => {
      this._roundSession.activate(roundGeneration);
    };

    if (this._autoRecording) {
      this._recordingStartGeneration = roundGeneration;
      this._recorder
        .start()
        .then(() => {
          if (this._recordingStartGeneration !== roundGeneration) {
            if (
              this._recordingStartGeneration === null &&
              this._activeRecordingGeneration === null &&
              this._recorder.isRecording
            ) {
              this._recorder.stop();
            }
            return;
          }
          this._recordingStartGeneration = null;
          if (!this._roundSession.isRunning(roundGeneration)) {
            if (this._recorder.isRecording) this._recorder.stop();
            return;
          }
          this._activeRecordingGeneration = roundGeneration;
          startPhysics();
        })
        .catch((e) => {
          if (this._recordingStartGeneration !== roundGeneration) return;
          this._recordingStartGeneration = null;
          if (!this._roundSession.isRunning(roundGeneration)) {
            if (this._recorder.isRecording) this._recorder.stop();
            return;
          }
          console.error('recording failed to start', e);
          startPhysics();
        });
    } else {
      startPhysics();
    }
  }

  public setSpeed(value: number) {
    if (value <= 0) {
      throw new Error('Speed multiplier must larger than 0');
    }
    this._speed = value;
  }

  private resultCloseHitAt(e: MouseEvent): boolean {
    const sizeFactor = this._renderer.sizeFactor;
    return this._renderer.getResultCloseHitAt(e.offsetX * sizeFactor, e.offsetY * sizeFactor);
  }

  public setTheme(themeName: keyof typeof Themes) {
    this._theme = Themes[themeName];
  }

  public getSpeed() {
    return this._speed;
  }

  public setSeed(seed: Seed) {
    this._roundSession.setSeed(seed);
  }

  public getSeed(): Seed {
    return this._roundSession.getSeed();
  }

  public setWinningRank(rank: number) {
    this.setWinnerRange(rank, rank);
  }

  public setWinnerRange(start: number, end: number) {
    this._roundSession.setWinnerRange(start, end);
  }

  /** 실제 구슬 수에 맞춰 잘린 범위 (0-based, 양끝 포함) */
  public getWinnerRange(): WinnerRange {
    return this._roundSession.getWinnerRange();
  }

  public setAutoRecording(value: boolean) {
    this._autoRecording = value;
  }

  public getSponsorState(): Promise<SponsorState> {
    return this._sponsorManager.getState();
  }

  public addSponsorAsset(file: File): Promise<SponsorAssetInfo> {
    return this._sponsorManager.addAsset(file);
  }

  public selectSponsorAsset(assetId: string | null): Promise<void> {
    return this._sponsorManager.selectAsset(assetId);
  }

  public deleteSponsorAsset(assetId: string): Promise<void> {
    return this._sponsorManager.deleteAsset(assetId);
  }

  public setSponsorsEnabled(enabled: boolean): Promise<void> {
    return this._sponsorManager.setEnabled(enabled);
  }

  public setRenderScale(value: RenderScale) {
    if (!isRenderScale(value)) return;

    options.renderScale = value;
    this._renderer.setRenderScale(value);
  }

  public setMarbles(names: string[]) {
    if (!this._roundSession.isInitialized) return;

    this._invalidateRecording();
    const spawnLayout = this._roundSession.setParticipants(names);
    if (!spawnLayout) return;

    // 카메라를 구슬 생성 위치 중앙으로 이동 + 줌인
    const margin = 3;
    const viewW = canvasWidth / initialZoom;
    const viewH = canvasHeight / initialZoom;
    const zoom = Math.max(
      1.5,
      Math.min(Math.min(viewW / (spawnLayout.width + margin * 2), viewH / (spawnLayout.height + margin * 2)), 3)
    );

    this._camera.initializePosition(spawnLayout.center, zoom);
  }

  public reset() {
    if (!this._roundSession.isInitialized) return;

    this._invalidateRecording();
    this._roundSession.reset();
    this._lastTime = Date.now();
    this._goalDist = Infinity;
  }

  public getCount() {
    return this._roundSession.getCount();
  }

  public getMaps() {
    return stages.map((stage, index) => {
      return {
        index,
        title: stage.title,
      };
    });
  }

  public getCurrentMap() {
    const stage = this._roundSession.currentStage;
    if (!stage) return null;
    return {
      index: stages.indexOf(stage),
      title: stage.title,
    };
  }

  public setMap(index: number) {
    if (!this._roundSession.isInitialized) return;

    if (index < 0 || index > stages.length - 1) {
      throw new Error('Incorrect map number');
    }
    this._invalidateRecording();
    this._roundSession.setMap(stages[index]);
    this._camera.initializePosition();
  }
}
