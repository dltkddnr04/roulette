import { HeadlessSimulationCancelledError, type HeadlessSimulationRequest } from './headlessSimulation';
import type { Seed } from './utils/random';

export const MAX_FAIRNESS_WORKERS = 4;
export const DEFAULT_FAIRNESS_WORKERS = 3;
const FAIRNESS_WORKER_WARMUP_DELAY_MS = 16;

export type FairnessWorkerPlan = Readonly<{
  planId: string;
  /** Optional caller-owned generation for replacing a plan with the same ID. */
  generation?: number;
  stage: HeadlessSimulationRequest['stage'];
  participants: HeadlessSimulationRequest['participants'];
  totalCount: HeadlessSimulationRequest['totalCount'];
  spawnPositions: HeadlessSimulationRequest['spawnPositions'];
  skillsEnabled: HeadlessSimulationRequest['skillsEnabled'];
  targetRank: HeadlessSimulationRequest['targetRank'];
}>;

export type FairnessWorkerPoolRunOptions = Readonly<{ signal?: AbortSignal; stepLimit: number }>;

export type FairnessWorkerPoolPlanRunOptions = Readonly<{
  signal?: AbortSignal;
  stepLimit: number;
  attemptIndex?: number;
}>;

export type FairnessWorkerPoolLike = Readonly<{
  concurrency: number;
  readonly readyConcurrency?: number;
  run: (request: HeadlessSimulationRequest, options: FairnessWorkerPoolRunOptions) => Promise<readonly number[]>;
  warmUp?: () => Promise<void>;
  waitForReadyConcurrency?: (minimum: number, signal?: AbortSignal) => Promise<void>;
  configurePlan?: (plan: FairnessWorkerPlan) => Promise<string>;
  runPlan?: (planId: string, seed: Seed, options: FairnessWorkerPoolPlanRunOptions) => Promise<readonly number[]>;
  dropPlan?: (planId: string) => void;
}>;

export class WorkerPoolUnavailableError extends Error {
  constructor(message = 'Fairness worker pool is unavailable') {
    super(message);
    this.name = 'WorkerPoolUnavailableError';
  }
}

type WorkerResponse =
  | Readonly<{ type: 'ready' }>
  | Readonly<{ type: 'initError'; message: string }>
  | Readonly<{ type: 'planReady'; planId: string }>
  | Readonly<{ type: 'result'; jobId: string; finishedMarbleIds: readonly number[] }>
  | Readonly<{ type: 'cancelled'; jobId: string }>
  | Readonly<{ type: 'simulationError'; jobId: string; message: string }>
  | Readonly<{ type: 'fatal'; jobId?: string; message: string }>;

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const type = (value as { type?: unknown }).type;
  if (type === 'ready') return true;
  if (type === 'initError') return typeof (value as { message?: unknown }).message === 'string';
  if (type === 'planReady') return typeof (value as { planId?: unknown }).planId === 'string';
  if (type === 'fatal') {
    const jobId = (value as { jobId?: unknown }).jobId;
    return (
      (jobId === undefined || typeof jobId === 'string') && typeof (value as { message?: unknown }).message === 'string'
    );
  }
  if (!('jobId' in value) || typeof (value as { jobId?: unknown }).jobId !== 'string') return false;
  if (type === 'result') {
    const finishedMarbleIds = (value as { finishedMarbleIds?: unknown }).finishedMarbleIds;
    return (
      Array.isArray(finishedMarbleIds) &&
      finishedMarbleIds.every((id) => typeof id === 'number' && Number.isSafeInteger(id))
    );
  }
  if (type === 'cancelled') return true;
  return type === 'simulationError' && typeof (value as { message?: unknown }).message === 'string';
}

type Job = {
  id: string;
  request?: HeadlessSimulationRequest;
  planId?: string;
  seed?: Seed;
  attemptIndex?: number;
  stepLimit: number;
  signal?: AbortSignal;
  resolve: (result: readonly number[]) => void;
  reject: (error: unknown) => void;
  slot: WorkerSlot | null;
  removeAbortListener: (() => void) | null;
  settled: boolean;
};

type RegisteredPlan = {
  plan: FairnessWorkerPlan;
  version: number;
  fingerprint: string;
};

type PendingPlanConfiguration = {
  version: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type ReadyConcurrencyWaiter = {
  minimum: number;
  resolve: () => void;
  reject: (error: unknown) => void;
  removeAbortListener: (() => void) | null;
  settled: boolean;
};

type WorkerSlot = {
  worker: Worker;
  ready: boolean;
  alive: boolean;
  job: Job | null;
  initialization: Promise<void>;
  resolveInitialization: (() => void) | null;
  rejectInitialization: ((error: unknown) => void) | null;
  configuredPlans: Map<string, number>;
  pendingPlans: Map<string, PendingPlanConfiguration>;
  plansSynchronized: boolean;
  planSyncPromise: Promise<void> | null;
};

function workerCount(): number {
  const concurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
  if (!Number.isFinite(concurrency) || !concurrency || concurrency <= 1) return 1;
  // Keep at least one logical core available for rendering and input. The
  // bucket at four cores is deliberately conservative for mobile Safari;
  // higher-end devices can add a third search worker without consuming every
  // reported logical core.
  if (concurrency <= 2) return 1;
  if (concurrency <= 4) return 2;
  return Math.min(DEFAULT_FAIRNESS_WORKERS, MAX_FAIRNESS_WORKERS, 3);
}

function planFingerprint(plan: FairnessWorkerPlan): string {
  return JSON.stringify({
    generation: plan.generation,
    stage: plan.stage,
    participants: plan.participants,
    totalCount: plan.totalCount,
    spawnPositions: plan.spawnPositions,
    skillsEnabled: plan.skillsEnabled,
    targetRank: plan.targetRank,
  });
}

function requestWithoutSeed(plan: FairnessWorkerPlan): Omit<HeadlessSimulationRequest, 'seed'> {
  return {
    stage: plan.stage,
    participants: plan.participants,
    totalCount: plan.totalCount,
    spawnPositions: plan.spawnPositions,
    skillsEnabled: plan.skillsEnabled,
    targetRank: plan.targetRank,
  };
}

function workerError(error: unknown, fallback: string): WorkerPoolUnavailableError {
  return new WorkerPoolUnavailableError(error instanceof Error && error.message ? error.message : fallback);
}

export class FairnessWorkerPool {
  readonly supported = typeof Worker !== 'undefined';
  readonly concurrency: number;
  private readonly slots: WorkerSlot[] = [];
  private readonly pending: Job[] = [];
  private readonly readyConcurrencyWaiters: ReadyConcurrencyWaiter[] = [];
  private readonly plans = new Map<string, RegisteredPlan>();
  private nextJobId = 0;
  private nextPlanVersion = 0;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: unknown) => void) | null = null;
  private failure: WorkerPoolUnavailableError | null = null;
  private workerSpawnScheduled = false;
  private planEpoch = 0;

  constructor() {
    this.concurrency = workerCount();
  }

  get readyConcurrency(): number {
    return this.slots.reduce((count, slot) => count + (slot.ready && slot.alive ? 1 : 0), 0);
  }

  async warmUp(): Promise<void> {
    await this.ensureReady();
  }

  waitForReadyConcurrency(minimum: number, signal?: AbortSignal): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(new HeadlessSimulationCancelledError());
    if (!Number.isSafeInteger(minimum) || minimum < 0) {
      return Promise.reject(new Error('Fairness ready concurrency minimum must be a non-negative safe integer'));
    }
    if (minimum === 0 || this.readyConcurrency >= minimum) return Promise.resolve();
    if (minimum > this.concurrency) {
      return Promise.reject(new WorkerPoolUnavailableError('Requested fairness worker concurrency is unavailable'));
    }

    let waiter!: ReadyConcurrencyWaiter;
    const promise = new Promise<void>((resolve, reject) => {
      waiter = {
        minimum,
        resolve,
        reject,
        removeAbortListener: null,
        settled: false,
      };
      this.readyConcurrencyWaiters.push(waiter);
      if (signal) {
        const onAbort = () => this.settleReadyConcurrencyWaiter(waiter, new HeadlessSimulationCancelledError());
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
    });

    // Re-check after registration so a synchronous readiness transition cannot
    // leave a waiter behind. Starting readiness after registration also lets
    // an unsupported pool reject this waiter through failPool().
    this.notifyReadyConcurrencyWaiters();
    void this.ensureReady().catch((error: unknown) => {
      if (!this.failure) this.failPool(error);
    });
    return promise;
  }

  async configurePlan(plan: FairnessWorkerPlan): Promise<string> {
    if (typeof plan?.planId !== 'string' || !plan.planId) {
      throw new Error('Fairness plan ID is invalid');
    }
    if (this.failure) throw this.failure;
    if (!this.supported) {
      throw this.failPool(new WorkerPoolUnavailableError('Web Workers are unavailable'));
    }

    const fingerprint = planFingerprint(plan);
    let registered = this.plans.get(plan.planId);
    if (!registered || registered.fingerprint !== fingerprint) {
      registered = {
        plan,
        version: ++this.nextPlanVersion,
        fingerprint,
      };
      this.plans.set(plan.planId, registered);
      this.planEpoch++;
      this.slots.forEach((slot) => {
        if (slot.ready && slot.alive) slot.plansSynchronized = false;
      });
    }

    await this.ensureReady();
    if (this.failure) throw this.failure;
    await Promise.all(this.slots.filter((slot) => slot.ready && slot.alive).map((slot) => this.startPlanSync(slot)));
    return plan.planId;
  }

  async runPlan(planId: string, seed: Seed, options: FairnessWorkerPoolPlanRunOptions): Promise<readonly number[]> {
    if (options.signal?.aborted) throw new HeadlessSimulationCancelledError();
    if (this.failure) throw this.failure;
    if (!this.supported) {
      throw this.failPool(new WorkerPoolUnavailableError('Web Workers are unavailable'));
    }
    if (!this.plans.has(planId)) throw new Error(`Fairness plan is not configured: ${planId}`);
    await this.ensureReady();
    if (options.signal?.aborted) throw new HeadlessSimulationCancelledError();
    if (!this.plans.has(planId)) throw new Error(`Fairness plan is not configured: ${planId}`);

    return this.enqueueJob({
      planId,
      seed,
      attemptIndex: options.attemptIndex,
      stepLimit: options.stepLimit,
      signal: options.signal,
    });
  }

  dropPlan(planId: string): void {
    this.plans.delete(planId);
    this.planEpoch++;
    this.slots.forEach((slot) => {
      if (!slot.alive) return;
      slot.configuredPlans.delete(planId);
      const pendingConfiguration = slot.pendingPlans.get(planId);
      if (pendingConfiguration) {
        slot.pendingPlans.delete(planId);
        // A drop is an intentional invalidation. Resolve the transport wait so
        // its caller can observe the missing plan and settle its job normally.
        pendingConfiguration.resolve();
      }
      if (slot.ready) {
        slot.plansSynchronized = false;
        try {
          slot.worker.postMessage({ type: 'dropPlan', planId });
        } catch (error) {
          this.handleWorkerFailure(slot, workerError(error, 'Fairness worker rejected plan removal'));
          return;
        }
        void this.startPlanSync(slot).catch(() => undefined);
      }
    });
    this.pump();
  }

  async run(request: HeadlessSimulationRequest, options: FairnessWorkerPoolRunOptions): Promise<readonly number[]> {
    const signal = options.signal;
    if (signal?.aborted) throw new HeadlessSimulationCancelledError();
    await this.ensureReady();
    if (signal?.aborted) throw new HeadlessSimulationCancelledError();

    return this.enqueueJob({ request, stepLimit: options.stepLimit, signal });
  }

  private enqueueJob(input: {
    request?: HeadlessSimulationRequest;
    planId?: string;
    seed?: Seed;
    attemptIndex?: number;
    stepLimit: number;
    signal?: AbortSignal;
  }): Promise<readonly number[]> {
    return new Promise<readonly number[]>((resolve, reject) => {
      const job: Job = {
        id: `fairness-job-${this.nextJobId++}`,
        request: input.request,
        planId: input.planId,
        seed: input.seed,
        attemptIndex: input.attemptIndex,
        stepLimit: input.stepLimit,
        signal: input.signal,
        resolve,
        reject,
        slot: null,
        removeAbortListener: null,
        settled: false,
      };
      if (input.signal) {
        const onAbort = () => this.cancel(job);
        input.signal.addEventListener('abort', onAbort, { once: true });
        job.removeAbortListener = () => input.signal?.removeEventListener('abort', onAbort);
      }
      if (input.signal?.aborted) {
        this.finishJob(job, new HeadlessSimulationCancelledError());
        return;
      }
      if (this.failure) {
        this.finishJob(job, this.failure);
        return;
      }
      if (input.planId !== undefined && !this.plans.has(input.planId)) {
        this.finishJob(job, new Error(`Fairness plan is not configured: ${input.planId}`));
        return;
      }
      this.pending.push(job);
      this.pump();
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.readyPromise) return this.readyPromise;
    if (!this.supported) {
      throw this.failPool(new WorkerPoolUnavailableError('Web Workers are unavailable'));
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.createWorkerSlot();
    return this.readyPromise;
  }

  private createWorkerSlot(): void {
    if (this.failure || this.slots.length >= this.concurrency) return;

    let worker: Worker;
    try {
      worker = new Worker(new URL('./fairnessWorker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      this.failPool(workerError(error, 'Fairness worker could not start'));
      return;
    }

    let resolveInitialization!: () => void;
    let rejectInitialization!: (error: unknown) => void;
    const initialization = new Promise<void>((resolve, reject) => {
      resolveInitialization = resolve;
      rejectInitialization = reject;
    });
    // A slot may fail before a caller needs its initialization promise. Keep
    // that failure handled while still allowing dispatchers to await it.
    void initialization.catch(() => undefined);

    const slot: WorkerSlot = {
      worker,
      ready: false,
      alive: true,
      job: null,
      initialization,
      resolveInitialization,
      rejectInitialization,
      configuredPlans: new Map(),
      pendingPlans: new Map(),
      plansSynchronized: false,
      planSyncPromise: null,
    };
    this.slots.push(slot);
    worker.onmessage = (event: MessageEvent<unknown>) => this.handleMessage(slot, event.data);
    worker.onerror = () => {
      this.handleWorkerFailure(
        slot,
        new WorkerPoolUnavailableError(slot.ready ? 'Fairness worker failed' : 'Fairness worker could not initialize')
      );
    };
  }

  private scheduleAdditionalWorker(): void {
    if (this.failure || this.workerSpawnScheduled || this.slots.length >= this.concurrency) return;
    if (this.slots.some((slot) => !slot.alive || !slot.ready)) return;
    this.workerSpawnScheduled = true;

    const spawn = () => {
      this.workerSpawnScheduled = false;
      if (this.failure || this.slots.length >= this.concurrency) return;
      if (this.slots.some((slot) => !slot.alive || !slot.ready)) return;
      this.createWorkerSlot();
    };

    const idleScheduler = (globalThis as unknown as { requestIdleCallback?: (callback: () => void) => unknown })
      .requestIdleCallback;
    if (typeof idleScheduler === 'function') idleScheduler(spawn);
    else if (typeof setTimeout === 'function') setTimeout(spawn, FAIRNESS_WORKER_WARMUP_DELAY_MS);
    else void Promise.resolve().then(spawn);
  }

  private startPlanSync(slot: WorkerSlot): Promise<void> {
    if (!slot.alive || this.failure) return Promise.reject(this.failure ?? new WorkerPoolUnavailableError());
    if (!slot.ready) return slot.initialization.then(() => this.startPlanSync(slot));
    if (this.plans.size === 0) {
      slot.plansSynchronized = true;
      return Promise.resolve();
    }
    if (slot.planSyncPromise) return slot.planSyncPromise;

    slot.plansSynchronized = false;
    const sync = this.syncPlansToSlot(slot).then(
      () => {
        slot.planSyncPromise = null;
        slot.plansSynchronized = true;
        this.pump();
      },
      (error: unknown) => {
        slot.planSyncPromise = null;
        if (!this.failure) this.handleWorkerFailure(slot, workerError(error, 'Fairness worker plan setup failed'));
        throw this.failure ?? error;
      }
    );
    slot.planSyncPromise = sync;
    void sync.catch(() => undefined);
    return sync;
  }

  private async syncPlansToSlot(slot: WorkerSlot): Promise<void> {
    while (true) {
      const epoch = this.planEpoch;
      const planIds = [...this.plans.keys()];
      for (const planId of planIds) {
        const registered = this.plans.get(planId);
        if (registered) await this.ensurePlanForSlot(slot, registered);
      }
      if (epoch === this.planEpoch) return;
    }
  }

  private ensurePlanForSlot(slot: WorkerSlot, registered: RegisteredPlan): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (!slot.alive) return Promise.reject(new WorkerPoolUnavailableError('Fairness worker is unavailable'));
    const current = this.plans.get(registered.plan.planId);
    if (!current) return Promise.resolve();
    if (current.version !== registered.version) return this.ensurePlanForSlot(slot, current);
    if (!slot.ready) return slot.initialization.then(() => this.ensurePlanForSlot(slot, registered));
    if (slot.configuredPlans.get(registered.plan.planId) === registered.version) return Promise.resolve();

    const pending = slot.pendingPlans.get(registered.plan.planId);
    if (pending) {
      if (pending.version === registered.version) return pending.promise;
      return pending.promise.then(() => this.ensurePlanForSlot(slot, registered));
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    void promise.catch(() => undefined);
    slot.pendingPlans.set(registered.plan.planId, { version: registered.version, promise, resolve, reject });
    try {
      slot.worker.postMessage({
        type: 'configurePlan',
        planId: registered.plan.planId,
        requestWithoutSeed: requestWithoutSeed(registered.plan),
      });
    } catch (error) {
      this.handleWorkerFailure(slot, workerError(error, 'Fairness worker rejected plan setup'));
    }
    return promise;
  }

  private async dispatchJob(slot: WorkerSlot, job: Job): Promise<void> {
    try {
      if (job.planId !== undefined) {
        const registered = this.plans.get(job.planId);
        if (!registered) {
          this.releaseJob(slot, job);
          this.finishJob(
            job,
            job.signal?.aborted
              ? new HeadlessSimulationCancelledError()
              : new Error(`Fairness plan is not configured: ${job.planId}`)
          );
          this.pump();
          return;
        }
        await this.startPlanSync(slot);
        if (this.failure || job.settled || slot.job !== job) return;
        const current = this.plans.get(job.planId);
        if (!current) {
          this.releaseJob(slot, job);
          this.finishJob(
            job,
            job.signal?.aborted
              ? new HeadlessSimulationCancelledError()
              : new Error(`Fairness plan is not configured: ${job.planId}`)
          );
          this.pump();
          return;
        }
        await this.ensurePlanForSlot(slot, current);
        if (this.failure || job.settled || slot.job !== job) return;
        // A plan may have been registered while the slot was waiting for its
        // requested plan. Re-check the full registry immediately before the
        // run so late registrations are also acknowledged first.
        await this.startPlanSync(slot);
        if (this.failure || job.settled || slot.job !== job) return;
        if (!this.plans.has(job.planId)) {
          this.releaseJob(slot, job);
          this.finishJob(
            job,
            job.signal?.aborted
              ? new HeadlessSimulationCancelledError()
              : new Error(`Fairness plan is not configured: ${job.planId}`)
          );
          this.pump();
          return;
        }
        slot.worker.postMessage({
          type: 'run',
          jobId: job.id,
          planId: job.planId,
          seed: job.seed as Seed,
          stepLimit: job.stepLimit,
          ...(job.attemptIndex === undefined ? {} : { attemptIndex: job.attemptIndex }),
        });
        return;
      }

      if (!job.request) {
        this.releaseJob(slot, job);
        this.finishJob(job, new WorkerPoolUnavailableError('Fairness worker job request is unavailable'));
        this.pump();
        return;
      }
      slot.worker.postMessage({ type: 'run', jobId: job.id, request: job.request, stepLimit: job.stepLimit });
    } catch (error) {
      if (this.failure || job.settled) return;
      this.handleWorkerFailure(slot, workerError(error, 'Fairness worker rejected a job'));
    }
  }

  private pump(): void {
    if (this.failure) return;
    for (const slot of this.slots) {
      if (!slot.ready || !slot.alive || slot.job || !slot.plansSynchronized) continue;

      let job: Job | undefined;
      while (this.pending.length) {
        const candidate = this.pending.shift()!;
        if (candidate.settled) continue;
        if (candidate.signal?.aborted) {
          this.finishJob(candidate, new HeadlessSimulationCancelledError());
          continue;
        }
        if (candidate.planId !== undefined && !this.plans.has(candidate.planId)) {
          this.finishJob(candidate, new Error(`Fairness plan is not configured: ${candidate.planId}`));
          continue;
        }
        job = candidate;
        break;
      }
      if (!job) continue;

      slot.job = job;
      job.slot = slot;
      void this.dispatchJob(slot, job);
    }
  }

  private cancel(job: Job): void {
    if (job.settled) return;
    if (job.slot) {
      try {
        job.slot.worker.postMessage({ type: 'cancel', jobId: job.id });
      } catch {
        this.handleWorkerFailure(job.slot, new WorkerPoolUnavailableError('Fairness worker rejected cancellation'));
      }
      return;
    }
    const index = this.pending.indexOf(job);
    if (index >= 0) this.pending.splice(index, 1);
    this.finishJob(job, new HeadlessSimulationCancelledError());
  }

  private handleMessage(slot: WorkerSlot, message: unknown): void {
    if (!slot.alive) return;
    if (!isWorkerResponse(message)) {
      this.handleWorkerFailure(slot, new WorkerPoolUnavailableError('Fairness worker sent an invalid response'));
      return;
    }
    if (message.type === 'ready') {
      if (slot.ready) return;
      slot.ready = true;
      slot.resolveInitialization?.();
      slot.resolveInitialization = null;
      slot.rejectInitialization = null;
      if (this.resolveReady) {
        const resolve = this.resolveReady;
        this.resolveReady = null;
        this.rejectReady = null;
        resolve();
      }
      if (this.plans.size > 0) void this.startPlanSync(slot).catch(() => undefined);
      else slot.plansSynchronized = true;
      this.notifyReadyConcurrencyWaiters();
      this.scheduleAdditionalWorker();
      this.pump();
      return;
    }
    if (message.type === 'initError') {
      this.handleWorkerFailure(slot, new WorkerPoolUnavailableError(message.message));
      return;
    }
    if (message.type === 'fatal') {
      const staleJob = message.jobId ? (slot.job?.id === message.jobId ? slot.job : null) : null;
      if (staleJob?.signal?.aborted) {
        this.releaseJob(slot, staleJob);
        this.finishJob(staleJob, new HeadlessSimulationCancelledError());
        this.pump();
        return;
      }
      this.handleWorkerFailure(slot, new WorkerPoolUnavailableError(message.message));
      return;
    }
    if (message.type === 'planReady') {
      if (!slot.ready) {
        this.handleWorkerFailure(
          slot,
          new WorkerPoolUnavailableError('Fairness worker sent a plan response before initialization')
        );
        return;
      }
      const pending = slot.pendingPlans.get(message.planId);
      if (!pending) return;
      slot.pendingPlans.delete(message.planId);
      const registered = this.plans.get(message.planId);
      if (registered && registered.version === pending.version) {
        slot.configuredPlans.set(message.planId, pending.version);
      }
      pending.resolve();
      return;
    }
    if (!slot.ready) {
      this.handleWorkerFailure(
        slot,
        new WorkerPoolUnavailableError('Fairness worker sent an invalid initialization response')
      );
      return;
    }
    if (!slot.job || slot.job.id !== message.jobId) return;
    const job = slot.job;
    slot.job = null;
    job.slot = null;
    if (job.signal?.aborted || message.type === 'cancelled') {
      this.finishJob(job, new HeadlessSimulationCancelledError());
    } else if (message.type === 'result') {
      this.finishJob(job, null, message.finishedMarbleIds);
    } else {
      this.finishJob(job, new Error(message.message));
    }
    this.pump();
  }

  private handleWorkerFailure(_slot: WorkerSlot, error: WorkerPoolUnavailableError): void {
    this.failPool(error);
  }

  private settleReadyConcurrencyWaiter(waiter: ReadyConcurrencyWaiter, error: unknown | null): void {
    if (waiter.settled) return;
    waiter.settled = true;
    const index = this.readyConcurrencyWaiters.indexOf(waiter);
    if (index >= 0) this.readyConcurrencyWaiters.splice(index, 1);
    waiter.removeAbortListener?.();
    waiter.removeAbortListener = null;
    if (error === null) waiter.resolve();
    else waiter.reject(error);
  }

  private notifyReadyConcurrencyWaiters(): void {
    if (this.readyConcurrencyWaiters.length === 0) return;
    const readyConcurrency = this.readyConcurrency;
    [...this.readyConcurrencyWaiters].forEach((waiter) => {
      if (readyConcurrency >= waiter.minimum) this.settleReadyConcurrencyWaiter(waiter, null);
    });
  }

  private rejectReadyConcurrencyWaiters(error: unknown): void {
    [...this.readyConcurrencyWaiters].forEach((waiter) => this.settleReadyConcurrencyWaiter(waiter, error));
  }

  private failPool(error: unknown): WorkerPoolUnavailableError {
    if (this.failure) return this.failure;
    this.failure = error instanceof WorkerPoolUnavailableError ? error : new WorkerPoolUnavailableError();
    this.rejectReady?.(this.failure);
    this.resolveReady = null;
    this.rejectReady = null;
    this.rejectReadyConcurrencyWaiters(this.failure);

    this.slots.forEach((currentSlot) => {
      currentSlot.alive = false;
      currentSlot.rejectInitialization?.(this.failure);
      currentSlot.resolveInitialization = null;
      currentSlot.rejectInitialization = null;
      currentSlot.pendingPlans.forEach((pending) => pending.reject(this.failure));
      currentSlot.pendingPlans.clear();
      currentSlot.configuredPlans.clear();
      const job = currentSlot.job;
      currentSlot.job = null;
      if (job) {
        job.slot = null;
        this.finishJob(job, job.signal?.aborted ? new HeadlessSimulationCancelledError() : this.failure);
      }
      currentSlot.worker.onmessage = null;
      currentSlot.worker.onerror = null;
      try {
        currentSlot.worker.terminate();
      } catch {
        // The worker is already unusable; termination is best effort.
      }
    });
    while (this.pending.length) {
      const job = this.pending.shift()!;
      this.finishJob(job, job.signal?.aborted ? new HeadlessSimulationCancelledError() : this.failure);
    }
    return this.failure;
  }

  private releaseJob(slot: WorkerSlot, job: Job): void {
    if (slot.job === job) slot.job = null;
    if (job.slot === slot) job.slot = null;
  }

  private finishJob(job: Job, error: unknown, result?: readonly number[]): void {
    if (job.settled) return;
    job.settled = true;
    job.removeAbortListener?.();
    job.removeAbortListener = null;
    job.slot = null;
    if (error) job.reject(error);
    else job.resolve(result ?? []);
  }
}
