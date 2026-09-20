import { Camera } from './camera';
import { canvasHeight, canvasWidth, initialZoom, Themes, zoomThreshold } from './data/constants';
import { stages } from './data/maps';
import type { FairnessExport, FairnessMode, FairnessProfile, FairnessState } from './fairness';
import {
  FairnessCancelledError,
  FairnessCoordinator,
  FairnessStaleStateError,
  type FairnessPrecomputedPlan,
  type FairnessPreparedDraw,
} from './fairnessCoordinator';
import { FastForwader } from './fastForwader';
import { Minimap } from './minimap';
import { isRenderScale, type RenderScale, type WinnerRange } from './options';
import { PresentationEffects } from './presentationEffects';
import { FIXED_PHYSICS_INTERVAL, type RaceRenderState } from './raceSimulation';
import { RankRenderer } from './rankRenderer';
import { type ReplayDescriptor, type RouletteState, type ThemeName, validateReplayDescriptor } from './replay';
import { RouletteRenderer } from './rouletteRenderer';
import { RoundSession, type RoundState } from './roundSession';
import { SimulationClient } from './simulationClient';
import { type SponsorAssetInfo, SponsorManager, type SponsorState } from './sponsorStore';
import type { ColorTheme } from './types/ColorTheme';
import type { MouseEventHandlerName, MouseEventName } from './types/mouseEvents.type';
import type { UIObject } from './UIObject';
import { bound } from './utils/bound.decorator';
import type { Seed } from './utils/random';
import { VideoRecorder } from './utils/videoRecorder';

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export type {
  FairnessCurrentEpoch,
  FairnessDrawEntrySnapshot,
  FairnessDrawStatus,
  FairnessDrawSummary,
  FairnessEvent,
  FairnessExport,
  FairnessMemberSnapshot,
  FairnessMode,
  FairnessPublicParticipant,
  FairnessProfile,
  FairnessState,
  FairnessWinnerMemberSnapshot,
} from './fairness';
export type { ReplayDescriptor, ReplayDescriptorV1, RouletteState, ThemeName } from './replay';
export type { RoundState } from './roundSession';
export type {
  SimulationExpectation,
  SimulationFinisher,
  SimulationOptions,
  SimulationResult,
  SimulationVerificationResult,
} from './simulationClient';

export class Roulette extends EventTarget {
  private _roundSession = new RoundSession();
  private readonly _fairnessCoordinator: FairnessCoordinator;
  private _fairnessRound: {
    drawId: string;
    operationToken: number;
    generation: number;
    expectedWinnerEntryIds: readonly string[] | null;
    expectedWinnerParticipantIds: readonly string[] | null;
    expectedWinnerMarbleIds: readonly number[] | null;
  } | null = null;
  private _normalDraw: {
    generation: number;
    prepared: Promise<FairnessPreparedDraw | null>;
  } | null = null;
  private _fairnessStartPromise: Promise<void> | null = null;
  private _firstFairnessPhysicsDiagnosticGeneration: number | null = null;
  private _initialParticipantSetupPending = true;
  private _allowPersistedFairnessReservationSeed = false;
  private _standbyRequestToken = 0;
  private _standbyScheduleCancel: (() => void) | null = null;
  private _scheduledStandby: {
    token: number;
    key: string;
    generation: number;
    seed: Seed;
    reservationId?: string;
  } | null = null;
  private _standbyPreparation: {
    token: number;
    key: string;
    generation: number;
    seed: Seed;
    reservationId?: string;
    promise: Promise<unknown>;
  } | null = null;
  private _readyToStart: {
    token: number;
    key: string;
    generation: number;
    seed: Seed;
    reservationId?: string;
  } | null = null;
  private _fairnessBatchDepth = 0;
  private _fairnessBatchInvalidated = false;
  private _fairnessBatchPrecomputeDelay: number | null = null;
  private _replayPending = false;
  private _applyingReplay = false;

  private _lastTime: number = 0;

  private _speed = 1;

  private _presentationEffects = new PresentationEffects();

  public readonly simulation = new SimulationClient();

  protected _camera: Camera = new Camera();
  protected _renderer: RouletteRenderer;

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
  private _themeName: ThemeName = 'dark';
  private _renderScale: RenderScale;

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

  constructor(renderScale: RenderScale = 0.5, fairnessCoordinator = new FairnessCoordinator()) {
    super();
    this._fairnessCoordinator = fairnessCoordinator;
    this._fairnessCoordinator.addStateChangeListener((change) => {
      if (change.external && change.autoPrecompute && !change.foreignActiveDraw) {
        // Another tab may have advanced the durable projection while this tab
        // was holding an older ReadyToStart/standby cache. Drop only the
        // speculative physical preparation; the visible round remains owned
        // by this session and is never interrupted by a state notification.
        this._invalidateStandby();
        this._scheduleFairnessPrecompute(0, true);
      }
      this._emitFairnessStateChange();
    });
    this._renderScale = renderScale;
    document.addEventListener('visibilitychange', this._handleVisibilityChange);
    this._renderer = this.createRenderer();
    this._renderer.setRenderScale(renderScale);
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
        this._presentationEffects.addImpact(position);
      },
      onFinish: (_marble, isWinningRank) => {
        if (isWinningRank) {
          this._presentationEffects.shot(this._renderer.width, this._renderer.height);
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
        this._presentationEffects.update(FIXED_PHYSICS_INTERVAL);
        this._uiObjects.forEach((obj) => obj.update(FIXED_PHYSICS_INTERVAL));
        const fairnessRound = this._fairnessRound;
        if (
          fairnessRound &&
          this._roundSession.isRunning(fairnessRound.generation) &&
          this._firstFairnessPhysicsDiagnosticGeneration !== fairnessRound.generation
        ) {
          this._firstFairnessPhysicsDiagnosticGeneration = fairnessRound.generation;
          this._fairnessCoordinator.recordDiagnostic('start.first-physics-step', {
            roundGeneration: fairnessRound.generation,
          });
        }
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

  private _emitMessage(message: string) {
    this.dispatchEvent(new CustomEvent('message', { detail: message }));
  }

  private _emitFairnessStateChange() {
    this.dispatchEvent(new Event('fairness'));
  }

  /** Coalesce the invalidation/scheduling work caused by one logical UI action. */
  public batchFairnessUpdates<T>(callback: () => T): T {
    this._fairnessBatchDepth += 1;
    try {
      return callback();
    } finally {
      this._fairnessBatchDepth -= 1;
      if (this._fairnessBatchDepth === 0) {
        const delay = this._fairnessBatchPrecomputeDelay;
        this._fairnessBatchPrecomputeDelay = null;
        this._fairnessBatchInvalidated = false;
        if (delay !== null) this._scheduleFairnessPrecompute(delay);
      }
    }
  }

  private _scheduleFairnessPrecompute(delay = 150, includeFinished = true): void {
    if (this._applyingReplay) return;
    if (!this._fairnessCoordinator.getFairnessEnabled()) return;
    if (
      this._roundSession.roundState !== 'ready' &&
      !(includeFinished && this._roundSession.roundState === 'finished')
    ) {
      return;
    }
    if (this._roundSession.getCount() === 0) return;

    if (this._fairnessBatchDepth > 0) {
      this._fairnessBatchPrecomputeDelay =
        this._fairnessBatchPrecomputeDelay === null ? delay : Math.min(this._fairnessBatchPrecomputeDelay, delay);
      return;
    }

    const stage = this._roundSession.currentStage;
    if (!stage) return;
    const request = {
      stage,
      mapIndex: stages.indexOf(stage),
      participantInputs: this._roundSession.getParticipantInputs(),
      winnerRange: this._roundSession.getWinnerRange(),
      skillsEnabled: this._roundSession.getSkillsEnabled(),
      currentSeed: this._roundSession.getSeed(),
      nextRoundSeed: this._roundSession.getNextRoundSeed(),
      allowPersistedReservationSeed: this._allowPersistedFairnessReservationSeed,
    } as const;
    const token = this._standbyRequestToken;
    this._fairnessCoordinator.recordDiagnostic('precompute.schedule', {
      delay,
      token,
      participantCount: this._roundSession.getCount(),
    });
    void this._fairnessCoordinator.schedulePrecompute(request, delay).then((plan) => {
      if (!plan || token !== this._standbyRequestToken) return;
      this._fairnessCoordinator.recordDiagnostic('precompute.plan-ready', {
        key: plan.key,
        generation: plan.generation,
        seed: plan.seed,
        reservationId: plan.reservationId,
      });
      this._scheduleAuthoritativeStandby(plan, token);
    });
  }

  private _scheduleAuthoritativeStandby(plan: FairnessPrecomputedPlan, token: number): void {
    if (this._matchesReadyToStart(plan, token)) return;
    if (
      this._scheduledStandby &&
      this._scheduledStandby.token === token &&
      this._sameStandbyPlan(this._scheduledStandby, plan)
    ) {
      return;
    }
    if (
      this._standbyPreparation &&
      this._standbyPreparation.token === token &&
      this._sameStandbyPlan(this._standbyPreparation, plan)
    ) {
      return;
    }
    this._readyToStart = null;
    this._cancelScheduledStandby();
    this._scheduledStandby = {
      token,
      key: plan.key,
      generation: plan.generation,
      seed: plan.seed,
      ...(plan.reservationId ? { reservationId: plan.reservationId } : {}),
    };
    const prepare = () => {
      this._standbyScheduleCancel = null;
      if (token !== this._standbyRequestToken) return;
      if (!this._scheduledStandby || !this._sameStandbyPlan(this._scheduledStandby, plan)) return;
      this._scheduledStandby = null;
      const promise = this._beginStandbyPreparation(plan, token);
      void promise.then(
        (layout) => {
          if (this._standbyPreparation?.promise === promise) this._standbyPreparation = null;
          if (layout && token === this._standbyRequestToken && plan.reservationId) {
            this._readyToStart = {
              token,
              key: plan.key,
              generation: plan.generation,
              seed: plan.seed,
              reservationId: plan.reservationId,
            };
            this._fairnessCoordinator.recordDiagnostic('start.ready-to-start', {
              key: plan.key,
              generation: plan.generation,
              seed: plan.seed,
              reservationId: plan.reservationId,
            });
          }
        },
        () => {
          if (this._standbyPreparation?.promise === promise) this._standbyPreparation = null;
        }
      );
    };
    this._fairnessCoordinator.recordDiagnostic('standby.scheduled', {
      key: plan.key,
      generation: plan.generation,
      seed: plan.seed,
      reservationId: plan.reservationId,
    });
    this._standbyScheduleCancel = this._scheduleStandbyPreparation(prepare);
  }

  private _beginStandbyPreparation(plan: FairnessPrecomputedPlan, token: number): Promise<unknown> {
    const existing = this._standbyPreparation;
    if (existing && existing.token === token && this._sameStandbyPlan(existing, plan)) return existing.promise;
    if (existing) this._roundSession.discardAuthoritativeStandby();
    this._fairnessCoordinator.recordDiagnostic('standby.start', {
      key: plan.key,
      generation: plan.generation,
      seed: plan.seed,
      reservationId: plan.reservationId,
    });
    const promise = this._roundSession.prepareAuthoritativeStandby(plan.seed);
    this._standbyPreparation = {
      token,
      key: plan.key,
      generation: plan.generation,
      seed: plan.seed,
      ...(plan.reservationId ? { reservationId: plan.reservationId } : {}),
      promise,
    };
    return promise;
  }

  private _startScheduledStandby(plan: FairnessPrecomputedPlan, token: number): void {
    if (
      !this._scheduledStandby ||
      this._scheduledStandby.token !== token ||
      !this._sameStandbyPlan(this._scheduledStandby, plan)
    ) {
      return;
    }
    this._cancelScheduledStandby();
    this._scheduledStandby = null;
    const promise = this._beginStandbyPreparation(plan, token);
    void promise.then(
      (layout) => {
        if (this._standbyPreparation?.promise === promise) this._standbyPreparation = null;
        if (layout && token === this._standbyRequestToken && plan.reservationId) {
          this._readyToStart = {
            token,
            key: plan.key,
            generation: plan.generation,
            seed: plan.seed,
            reservationId: plan.reservationId,
          };
          this._fairnessCoordinator.recordDiagnostic('start.ready-to-start', {
            key: plan.key,
            generation: plan.generation,
            seed: plan.seed,
            reservationId: plan.reservationId,
          });
        }
      },
      () => {
        if (this._standbyPreparation?.promise === promise) this._standbyPreparation = null;
      }
    );
  }

  private _sameStandbyPlan(
    left: { key: string; generation: number; seed: Seed; reservationId?: string },
    right: { key: string; generation: number; seed: Seed; reservationId?: string }
  ): boolean {
    return (
      left.key === right.key &&
      left.generation === right.generation &&
      left.seed === right.seed &&
      left.reservationId === right.reservationId
    );
  }

  private _matchesReadyToStart(plan: FairnessPrecomputedPlan | FairnessPreparedDraw, token: number): boolean {
    const ready = this._readyToStart;
    return ready !== null && ready.token === token && this._sameStandbyPlan(ready, plan);
  }

  private _invalidateStandby(): void {
    this._standbyRequestToken++;
    this._cancelScheduledStandby();
    this._scheduledStandby = null;
    this._readyToStart = null;
    this._standbyPreparation = null;
    this._roundSession.discardAuthoritativeStandby();
  }

  private _cancelScheduledStandby(): void {
    this._standbyScheduleCancel?.();
    this._standbyScheduleCancel = null;
  }

  /**
   * Keep the synchronous Shuffle/paint path free of authoritative Box2D
   * preparation. requestIdleCallback is preferred; the frame fallback waits
   * until after a paint, and the timer fallback yields to a later task.
   */
  private _scheduleStandbyPreparation(callback: () => void): () => void {
    const scope = globalThis as typeof globalThis & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
      requestAnimationFrame?: (callback: () => void) => number;
      cancelAnimationFrame?: (handle: number) => void;
    };
    if (typeof scope.requestIdleCallback === 'function') {
      const handle = scope.requestIdleCallback(callback, { timeout: 1000 });
      return () => scope.cancelIdleCallback?.(handle);
    }
    if (typeof scope.requestAnimationFrame === 'function') {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const frame = scope.requestAnimationFrame(() => {
        timer = setTimeout(callback, 0);
      });
      return () => {
        scope.cancelAnimationFrame?.(frame);
        if (timer !== null) clearTimeout(timer);
      };
    }
    const timer = setTimeout(callback, 16);
    return () => clearTimeout(timer);
  }

  private _cancelActiveFairnessDraw(reason: string, cancelNormalDraw = true): void {
    this._invalidateStandby();
    const activeDraw = this._fairnessRound;
    this._fairnessRound = null;
    if (activeDraw) {
      void this._fairnessCoordinator.cancelDraw(activeDraw.drawId, reason).catch((error) => {
        console.warn('Fairness draw cancellation failed', error);
      });
    }
    if (cancelNormalDraw) {
      const normalDraw = this._normalDraw;
      this._normalDraw = null;
      if (normalDraw) {
        void normalDraw.prepared
          .then((prepared) => {
            if (prepared) {
              return this._fairnessCoordinator.cancelDraw(prepared.drawId, reason);
            }
            return undefined;
          })
          .catch((error) => {
            console.warn('Fairness draw cancellation failed', error);
          });
      }
    }
    if (this._fairnessBatchDepth > 0) {
      if (!this._fairnessBatchInvalidated) {
        this._fairnessCoordinator.invalidateStart();
        this._fairnessBatchInvalidated = true;
      }
    } else {
      this._fairnessCoordinator.invalidateStart();
    }
  }

  private _checkFinish() {
    const finish = this._roundSession.checkFinish();
    if (!finish) return;

    if (finish.earlyWinning) {
      this._presentationEffects.shot(this._renderer.width, this._renderer.height);
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

    const fairnessRound = this._fairnessRound;
    if (fairnessRound && fairnessRound.generation === this._roundSession.generation) {
      void this._fairnessCoordinator
        .confirmDraw(
          fairnessRound.drawId,
          finish.result.map((marble) => marble.id),
          fairnessRound.operationToken,
          fairnessRound.expectedWinnerParticipantIds,
          fairnessRound.expectedWinnerMarbleIds,
          fairnessRound.expectedWinnerEntryIds
        )
        .then((confirmation) => {
          if (!confirmation.confirmed && confirmation.reason) this._emitMessage(confirmation.reason);
          if (confirmation.confirmed) {
            // Confirmation changes the policy projection and invalidates any
            // standby that was prepared for the previous balance state before
            // the next-round search is scheduled.
            this._invalidateStandby();
            this._scheduleFairnessPrecompute(0, true);
          }
        })
        .catch((error) => {
          this._emitMessage(error instanceof Error ? error.message : 'Fairness could not record this draw');
          this._emitFairnessStateChange();
        })
        .then(
          () => {
            if (this._fairnessRound === fairnessRound) this._fairnessRound = null;
          },
          () => {
            if (this._fairnessRound === fairnessRound) this._fairnessRound = null;
          }
        );
    } else {
      const normalDraw = this._normalDraw;
      this._normalDraw = null;
      if (normalDraw && normalDraw.generation === this._roundSession.generation) {
        void normalDraw.prepared
          .then(async (prepared) => {
            if (!prepared) return undefined;
            if (normalDraw.generation !== this._roundSession.generation) {
              await this._fairnessCoordinator.cancelDraw(
                prepared.drawId,
                'Fairness draw was cancelled after the round ended'
              );
              return undefined;
            }
            const confirmation = await this._fairnessCoordinator.confirmDraw(
              prepared.drawId,
              finish.result.map((marble) => marble.id),
              null
            );
            if (!confirmation.confirmed && confirmation.reason) {
              this._emitMessage(confirmation.reason);
            }
            return undefined;
          })
          .catch((error) => {
            this._emitMessage(error instanceof Error ? error.message : 'Fairness could not record this draw');
            this._emitFairnessStateChange();
          });
      }
    }
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
      effects: this._presentationEffects.getRenderState(),
      winnerRange: this._roundSession.getWinnerRange(),
      result: this._roundSession.getResult(),
      size: { x: this._renderer.width, y: this._renderer.height },
      theme: this._theme,
      alpha,
      skillsEnabled: this._roundSession.getSkillsEnabled(),
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
    this._fairnessCoordinator.initializeBackgroundResources();
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

    const pointerEvents: ReadonlyArray<readonly [MouseEventName, string]> = [
      ['MouseMove', 'pointermove'],
      ['DblClick', 'dblclick'],
    ];
    pointerEvents.forEach(([eventName, eventType]) => {
      canvas.addEventListener(eventType, (event) => this.mouseHandler(eventName, event as MouseEvent));
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

    this._replayPending = false;
    this._cancelActiveFairnessDraw('Fairness draw was cancelled because the participants changed');
    this._invalidateRecording();
    this._presentationEffects.clear();
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

  public start(): void | Promise<void> {
    if (this._replayPending) {
      this._replayPending = false;
      return this._startWithoutFairness(false);
    }

    if (this._fairnessCoordinator.getFairnessEnabled()) {
      if (this._fairnessStartPromise) return this._fairnessStartPromise;

      let trackedPromise!: Promise<void>;
      trackedPromise = this._startWithFairness().then(
        () => {
          if (this._fairnessStartPromise === trackedPromise) this._fairnessStartPromise = null;
        },
        (error) => {
          if (this._fairnessStartPromise === trackedPromise) this._fairnessStartPromise = null;
          throw error;
        }
      );
      this._fairnessStartPromise = trackedPromise;
      return trackedPromise;
    }

    return this._startWithoutFairness();
  }

  private _startWithoutFairness(recordHistory = true) {
    this._fairnessCoordinator.invalidatePrecompute();
    const roundGeneration = this._roundSession.prepareStart();
    if (roundGeneration === null) return;

    if (recordHistory) {
      const stage = this._roundSession.currentStage;
      if (stage) {
        const prepared = this._fairnessCoordinator
          .prepareUnconstrainedDraw({
            stage,
            mapIndex: stages.indexOf(stage),
            participantInputs: this._roundSession.getParticipantInputs(),
            winnerRange: this._roundSession.getWinnerRange(),
            skillsEnabled: this._roundSession.getSkillsEnabled(),
            currentSeed: this._roundSession.getSeed(),
          })
          .catch(() => null);
        this._normalDraw = { generation: roundGeneration, prepared };
      }
    }

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

  private _restoreRandomSeedMode(): void {
    this._roundSession.setRandomSeedMode();
  }

  private async _startWithFairness(): Promise<void> {
    if (
      !this._roundSession.isInitialized ||
      (this._roundSession.roundState !== 'ready' && this._roundSession.roundState !== 'finished')
    ) {
      return;
    }
    if (this._roundSession.getCount() === 0) return;

    const winnerRange = this._roundSession.getWinnerRange();
    if (winnerRange.start !== winnerRange.end) {
      this._emitMessage('Cumulative fairness supports one winning rank at a time');
      return;
    }

    const stage = this._roundSession.currentStage;
    if (!stage) return;

    const operationToken = this._fairnessCoordinator.beginStart();
    this._fairnessCoordinator.recordDiagnostic('start.click', { operationToken });
    const request = {
      stage,
      mapIndex: stages.indexOf(stage),
      participantInputs: this._roundSession.getParticipantInputs(),
      winnerRange,
      skillsEnabled: this._roundSession.getSkillsEnabled(),
      currentSeed: this._roundSession.getSeed(),
      nextRoundSeed: this._roundSession.getNextRoundSeed(),
      allowPersistedReservationSeed: this._allowPersistedFairnessReservationSeed,
    } as const;
    const restoreRandomSeedMode = this._roundSession.getSeedMode() === 'random';

    let prepared: FairnessPreparedDraw;
    try {
      prepared = await this._fairnessCoordinator.tryPrepareDrawFromCache(request, operationToken, {
        includeEvent: false,
      });
      if (!prepared) {
        prepared = await this._fairnessCoordinator.prepareDraw(request, operationToken, { includeEvent: false });
      }
      this._fairnessCoordinator.recordDiagnostic('start.prepare.ready', {
        operationToken,
        drawId: prepared.drawId,
        key: prepared.key,
        generation: prepared.generation,
        seed: prepared.seed,
        reservationId: prepared.reservationId,
        readyToStart: this._matchesReadyToStart(prepared, this._standbyRequestToken),
      });
    } catch (error) {
      if (error instanceof FairnessCancelledError) {
        if (error instanceof FairnessStaleStateError) {
          this._invalidateStandby();
          this._scheduleFairnessPrecompute(0, true);
        }
        this.dispatchEvent(new Event('startcancelled'));
        return;
      }
      const state = await this._fairnessCoordinator.getState();
      this._emitMessage(error instanceof Error ? error.message : 'Fairness could not start this draw');
      // A storage failure disables fairness and leaves the old roulette path
      // usable. Search/policy failures deliberately do not fall back to a draw.
      if (!state.available) this._startWithoutFairness();
      return;
    }

    if (!this._fairnessCoordinator.isStartCurrent(operationToken)) {
      void this._fairnessCoordinator.cancelDraw(prepared.drawId, 'Fairness draw was cancelled before start');
      return;
    }

    this._invalidateRecording();
    this._presentationEffects.clear();
    let spawnLayout = this._roundSession.adoptPreparedAuthoritativeRound(prepared.seed);
    if (spawnLayout) {
      this._readyToStart = null;
      this._fairnessCoordinator.recordDiagnostic('start.standby-adopt', {
        key: prepared.key,
        generation: prepared.generation,
        seed: prepared.seed,
        reservationId: prepared.reservationId,
      });
    }
    if (!spawnLayout) {
      this._startScheduledStandby(prepared, this._standbyRequestToken);
      const standby = this._standbyPreparation;
      if (standby && standby.token === this._standbyRequestToken && this._sameStandbyPlan(standby, prepared)) {
        this._fairnessCoordinator.recordDiagnostic('start.standby-wait', {
          key: prepared.key,
          generation: prepared.generation,
          seed: prepared.seed,
        });
        await standby.promise;
        spawnLayout = this._roundSession.adoptPreparedAuthoritativeRound(prepared.seed);
        if (spawnLayout) {
          this._readyToStart = null;
          this._fairnessCoordinator.recordDiagnostic('start.standby-adopt', {
            key: prepared.key,
            generation: prepared.generation,
            seed: prepared.seed,
            reservationId: prepared.reservationId,
          });
        }
      }
    }
    if (!this._fairnessCoordinator.isStartCurrent(operationToken)) {
      await this._fairnessCoordinator.cancelDraw(prepared.drawId, 'Fairness draw was cancelled before start');
      return;
    }
    if (!spawnLayout) {
      this._roundSession.setSeed(prepared.seed);
      spawnLayout = this._roundSession.rebuildAuthoritativeRoundForCurrentParticipants();
    }
    if (!spawnLayout) {
      await this._fairnessCoordinator.cancelDraw(prepared.drawId, 'Fairness could not rebuild the round');
      this._emitMessage('Fairness could not rebuild the round');
      return;
    }
    if (restoreRandomSeedMode) this._restoreRandomSeedMode();

    const margin = 3;
    const viewW = canvasWidth / initialZoom;
    const viewH = canvasHeight / initialZoom;
    const zoom = Math.max(
      1.5,
      Math.min(Math.min(viewW / (spawnLayout.width + margin * 2), viewH / (spawnLayout.height + margin * 2)), 3)
    );
    this._camera.initializePosition(spawnLayout.center, zoom);

    const roundGeneration = this._roundSession.prepareStart();
    this._fairnessCoordinator.recordDiagnostic('start.prepare-start', { roundGeneration });
    if (roundGeneration === null) {
      await this._fairnessCoordinator.cancelDraw(prepared.drawId, 'Fairness could not start the round');
      this._emitMessage('Fairness could not start the round');
      return;
    }
    this._fairnessRound = {
      drawId: prepared.drawId,
      operationToken,
      generation: roundGeneration,
      expectedWinnerEntryIds: prepared.expectedWinnerEntryIds
        ? [prepared.expectedWinnerEntryIds[prepared.expectedWinnerEntryIds.length - 1]]
        : null,
      expectedWinnerParticipantIds: prepared.expectedWinnerParticipantIds
        ? [prepared.expectedWinnerParticipantIds[prepared.expectedWinnerParticipantIds.length - 1]]
        : null,
      expectedWinnerMarbleIds: prepared.expectedWinnerMarbleIds
        ? [prepared.expectedWinnerMarbleIds[prepared.expectedWinnerMarbleIds.length - 1]]
        : null,
    };

    this._clearRecordingStopTimer();
    this._camera.startFollowingMarbles();

    const startPhysics = () => {
      if (!this._roundSession.isRunning(roundGeneration)) return;
      this._fairnessCoordinator.recordDiagnostic('start.activate', { roundGeneration });
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
        .catch((error) => {
          if (this._recordingStartGeneration !== roundGeneration) return;
          this._recordingStartGeneration = null;
          if (!this._roundSession.isRunning(roundGeneration)) {
            if (this._recorder.isRecording) this._recorder.stop();
            return;
          }
          console.error('recording failed to start', error);
          startPhysics();
        });
    } else {
      startPhysics();
    }
    this._fairnessCoordinator.recordDiagnostic('start.activate-requested', { roundGeneration });
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

  public setTheme(themeName: ThemeName) {
    this._theme = Themes[themeName];
    this._themeName = themeName;
  }

  public getTheme(): ThemeName {
    return this._themeName;
  }

  public getSpeed() {
    return this._speed;
  }

  public setSeed(seed: Seed) {
    this._allowPersistedFairnessReservationSeed = false;
    if (!this._applyingReplay) this._cancelActiveFairnessDraw('Fairness draw was cancelled because the seed changed');
    this._roundSession.setSeed(seed);
  }

  public getSeed(): Seed {
    return this._roundSession.getSeed();
  }

  public useRandomSeed(): void {
    this._allowPersistedFairnessReservationSeed = false;
    if (!this._applyingReplay) this._cancelActiveFairnessDraw('Fairness draw was cancelled because the seed changed');
    this._roundSession.setRandomSeedMode();
  }

  public getSeedMode(): 'random' | 'explicit' {
    return this._roundSession.getSeedMode();
  }

  public setWinningRank(rank: number) {
    this.setWinnerRange(rank, rank);
  }

  public setWinnerRange(start: number, end: number, fairnessPrecomputeDelay = 150) {
    const changed = this._roundSession.setWinnerRange(start, end);
    if (!changed) return true;
    this._allowPersistedFairnessReservationSeed = false;
    if (!this._applyingReplay) this._cancelActiveFairnessDraw('Fairness draw was cancelled because the winner changed');
    this._scheduleFairnessPrecompute(fairnessPrecomputeDelay);
    return true;
  }

  /** 실제 구슬 수에 맞춰 잘린 범위 (0-based, 양끝 포함) */
  public getWinnerRange(): WinnerRange {
    return this._roundSession.getWinnerRange();
  }

  public setAutoRecording(value: boolean) {
    this._autoRecording = value;
  }

  public getAutoRecording(): boolean {
    return this._autoRecording;
  }

  public setSkillsEnabled(enabled: boolean): void {
    const changed = this._roundSession.setSkillsEnabled(enabled);
    if (!changed) return;
    this._allowPersistedFairnessReservationSeed = false;
    if (!this._applyingReplay) this._cancelActiveFairnessDraw('Fairness draw was cancelled because skills changed');
    this._scheduleFairnessPrecompute();
  }

  public getSkillsEnabled(): boolean {
    return this._roundSession.getSkillsEnabled();
  }

  public getFairnessState(): Promise<FairnessState> {
    return this._fairnessCoordinator.getState();
  }

  public async setFairnessEnabled(enabled: boolean): Promise<void> {
    if (!enabled && this._roundSession.roundState !== 'running') {
      this._cancelActiveFairnessDraw('Fairness was disabled', false);
    }
    await this._fairnessCoordinator.setEnabled(enabled);
    this._scheduleFairnessPrecompute();
  }

  public getFairnessEnabled(): boolean {
    return this._fairnessCoordinator.getFairnessEnabled();
  }

  public setFairnessMode(mode: FairnessMode): Promise<void> {
    return this._fairnessCoordinator.setMode(mode);
  }

  public getFairnessMode(): FairnessMode {
    return this._fairnessCoordinator.getMode();
  }

  public setFairnessParticipantExcluded(participantId: string, excluded: boolean): Promise<void> {
    this._invalidateStandby();
    return this._fairnessCoordinator.setParticipantExcluded(participantId, excluded).then(() => {
      this._scheduleFairnessPrecompute();
    });
  }

  public addFairnessParticipant(name: string): Promise<string> {
    this._invalidateStandby();
    return this._fairnessCoordinator.addParticipant(name).then((participantId) => {
      this._scheduleFairnessPrecompute();
      return participantId;
    });
  }

  public setFairnessParticipantActive(participantId: string, active: boolean): Promise<void> {
    this._invalidateStandby();
    return this._fairnessCoordinator.setParticipantActive(participantId, active).then(() => {
      this._scheduleFairnessPrecompute();
    });
  }

  public renameFairParticipant(participantId: string, name: string): Promise<void> {
    this._invalidateStandby();
    return this._fairnessCoordinator.renameParticipant(participantId, name).then(() => {
      this._scheduleFairnessPrecompute();
    });
  }

  public createFairnessProfile(name: string): Promise<FairnessProfile> {
    return this._fairnessCoordinator.createProfile(name);
  }

  public renameFairnessProfile(profileId: string, name: string): Promise<void> {
    return this._fairnessCoordinator.renameProfile(profileId, name);
  }

  public selectFairnessProfile(profileId: string): Promise<void> {
    this._invalidateStandby();
    return this._fairnessCoordinator.selectProfile(profileId).then(() => {
      this._scheduleFairnessPrecompute(0, true);
    });
  }

  public duplicateFairnessProfile(profileId: string, name: string): Promise<FairnessProfile> {
    return this._fairnessCoordinator.duplicateProfile(profileId, name);
  }

  public startNewFairnessEpoch(): Promise<void> {
    this._invalidateStandby();
    return this._fairnessCoordinator.startNewEpoch().then(() => {
      this._scheduleFairnessPrecompute();
    });
  }

  public voidFairnessDraw(drawId: string): Promise<void> {
    this._invalidateStandby();
    return this._fairnessCoordinator.voidDraw(drawId).then(() => {
      this._scheduleFairnessPrecompute();
    });
  }

  public exportFairnessData(): Promise<FairnessExport> {
    return this._fairnessCoordinator.exportData();
  }

  public importFairnessData(value: unknown): Promise<void> {
    this._invalidateStandby();
    return this._fairnessCoordinator.importData(value).then(() => {
      this._scheduleFairnessPrecompute();
    });
  }

  public deleteFairnessData(): Promise<void> {
    this._invalidateStandby();
    return this._fairnessCoordinator.clearData().then(() => {
      this._scheduleFairnessPrecompute();
    });
  }

  public setFastForward(enabled: boolean): void {
    this.fastForwarder?.setEnabled(enabled);
  }

  public getFastForward(): boolean {
    return this.fastForwarder?.enabled ?? false;
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

    this._renderScale = value;
    this._renderer.setRenderScale(value);
  }

  public getRenderScale(): RenderScale {
    return this._renderScale;
  }

  public setMarbles(names: string[], fairnessPrecomputeDelay = 150) {
    if (!this._roundSession.isInitialized) return;

    if (this._initialParticipantSetupPending) {
      this._initialParticipantSetupPending = false;
      this._allowPersistedFairnessReservationSeed = true;
    } else {
      this._allowPersistedFairnessReservationSeed = false;
    }

    const participantsChanged = !sameStrings(this._roundSession.getParticipantInputs(), names);
    if (!this._applyingReplay) {
      this._replayPending = false;
      if (participantsChanged) {
        this._cancelActiveFairnessDraw('Fairness draw was cancelled because the participants changed');
      }
    }
    this._invalidateRecording();
    this._presentationEffects.clear();
    const spawnLayout = this._roundSession.setParticipants(names);
    this._fairnessCoordinator.setCurrentParticipantInputs(
      names,
      this._applyingReplay,
      !this._applyingReplay && participantsChanged
    );
    this._scheduleFairnessPrecompute(fairnessPrecomputeDelay);
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

    this._replayPending = false;
    this._cancelActiveFairnessDraw('Fairness draw was cancelled because the round reset');
    this._invalidateRecording();
    this._presentationEffects.clear();
    this._roundSession.reset();
    this._lastTime = Date.now();
    this._goalDist = Infinity;
    this._scheduleFairnessPrecompute();
  }

  public getCount() {
    return this._roundSession.getCount();
  }

  public getState(): RouletteState {
    return {
      roundState: this.roundState,
      map: this.getCurrentMap(),
      count: this.getCount(),
      seed: this.getSeed(),
      seedMode: this.getSeedMode(),
      winnerRange: this.getWinnerRange(),
      speed: this.getSpeed(),
      fastForward: this.getFastForward(),
      skillsEnabled: this.getSkillsEnabled(),
      renderScale: this.getRenderScale(),
      autoRecording: this.getAutoRecording(),
      theme: this.getTheme(),
    };
  }

  public exportReplay(): ReplayDescriptor {
    const map = this.getCurrentMap();
    if (!map) throw new Error('Cannot export replay before initialization');

    const participants = this._roundSession.getParticipantInputs();
    if (participants.length === 0) {
      throw new Error('Cannot export replay without participants');
    }

    return validateReplayDescriptor(
      {
        version: 1,
        seed: this.getSeed(),
        mapIndex: map.index,
        participants: participants.slice(),
        winnerRange: this.getWinnerRange(),
        skillsEnabled: this.getSkillsEnabled(),
      },
      stages.length
    );
  }

  public loadReplay(value: unknown): void {
    if (!this._roundSession.isInitialized) throw new Error('Cannot load replay before initialization');
    const replay = validateReplayDescriptor(value, stages.length);

    this._cancelActiveFairnessDraw('Fairness draw was cancelled because a replay was loaded');
    this._applyingReplay = true;
    this._replayPending = true;
    try {
      // Apply the explicit seed before any rebuild so map/participant changes
      // do not consume an auto-generated seed or alter the replay stream.
      this.setSeed(replay.seed);
      this.setSkillsEnabled(replay.skillsEnabled);
      this.setMap(replay.mapIndex);
      this.setMarbles(replay.participants.slice());
      this.setWinnerRange(replay.winnerRange.start, replay.winnerRange.end);
    } catch (error) {
      this._replayPending = false;
      throw error;
    } finally {
      this._applyingReplay = false;
    }
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
    if (this._roundSession.currentStage === stages[index]) return;
    this._allowPersistedFairnessReservationSeed = false;
    if (!this._applyingReplay) {
      this._replayPending = false;
      this._cancelActiveFairnessDraw('Fairness draw was cancelled because the map changed');
    }
    this._invalidateRecording();
    this._presentationEffects.clear();
    this._roundSession.setMap(stages[index]);
    this._camera.initializePosition();
    this._scheduleFairnessPrecompute();
  }
}
