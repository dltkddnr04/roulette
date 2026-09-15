import { HeadlessSimulationCancelledError, type HeadlessSimulationRequest } from './headlessSimulation';

export const MAX_FAIRNESS_WORKERS = 4;
export const DEFAULT_FAIRNESS_WORKERS = 3;

export type FairnessWorkerPoolRunOptions = Readonly<{ signal?: AbortSignal; stepLimit: number }>;

export type FairnessWorkerPoolLike = Readonly<{
  concurrency: number;
  run: (request: HeadlessSimulationRequest, options: FairnessWorkerPoolRunOptions) => Promise<readonly number[]>;
  warmUp?: () => Promise<void>;
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
  | Readonly<{ type: 'result'; jobId: string; finishedMarbleIds: readonly number[] }>
  | Readonly<{ type: 'cancelled'; jobId: string }>
  | Readonly<{ type: 'simulationError'; jobId: string; message: string }>;

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const type = (value as { type?: unknown }).type;
  if (type === 'ready') return true;
  if (type === 'initError') return typeof (value as { message?: unknown }).message === 'string';
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
  request: HeadlessSimulationRequest;
  stepLimit: number;
  signal?: AbortSignal;
  resolve: (result: readonly number[]) => void;
  reject: (error: unknown) => void;
  slot: WorkerSlot | null;
  removeAbortListener: (() => void) | null;
  settled: boolean;
};

type WorkerSlot = {
  worker: Worker;
  ready: boolean;
  job: Job | null;
  resolveInitialization: (() => void) | null;
  rejectInitialization: ((error: unknown) => void) | null;
};

function workerCount(): number {
  const concurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
  if (!Number.isFinite(concurrency) || !concurrency || concurrency <= 1) return 1;
  return Math.min(DEFAULT_FAIRNESS_WORKERS, MAX_FAIRNESS_WORKERS, Math.max(1, Math.floor(concurrency - 1)));
}

export class FairnessWorkerPool {
  readonly supported = typeof Worker !== 'undefined';
  readonly concurrency: number;
  private readonly slots: WorkerSlot[] = [];
  private readonly pending: Job[] = [];
  private nextJobId = 0;
  private readyPromise: Promise<void> | null = null;
  private failure: WorkerPoolUnavailableError | null = null;

  constructor() {
    this.concurrency = workerCount();
  }

  async warmUp(): Promise<void> {
    await this.ensureReady();
  }

  async run(request: HeadlessSimulationRequest, options: FairnessWorkerPoolRunOptions): Promise<readonly number[]> {
    const signal = options.signal;
    if (signal?.aborted) throw new HeadlessSimulationCancelledError();
    await this.ensureReady();
    if (signal?.aborted) throw new HeadlessSimulationCancelledError();

    return new Promise<readonly number[]>((resolve, reject) => {
      const job: Job = {
        id: `fairness-job-${this.nextJobId++}`,
        request,
        stepLimit: options.stepLimit,
        signal,
        resolve,
        reject,
        slot: null,
        removeAbortListener: null,
        settled: false,
      };
      if (signal) {
        const onAbort = () => this.cancel(job);
        signal.addEventListener('abort', onAbort, { once: true });
        job.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
      if (signal?.aborted) {
        this.finishJob(job, new HeadlessSimulationCancelledError());
        return;
      }
      if (this.failure) {
        this.finishJob(job, this.failure);
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

    this.readyPromise = this.initializeWorkers().catch((error: unknown) => {
      throw this.failPool(error);
    });
    return this.readyPromise;
  }

  private async initializeWorkers(): Promise<void> {
    const initializationPromises: Promise<void>[] = [];
    for (let index = 0; index < this.concurrency; index++) {
      if (this.failure) throw this.failure;
      let worker: Worker;
      try {
        worker = new Worker(new URL('./fairnessWorker.ts', import.meta.url), { type: 'module' });
      } catch (error) {
        throw new WorkerPoolUnavailableError(
          error instanceof Error ? error.message : 'Fairness worker could not start'
        );
      }

      let resolveInitialization!: () => void;
      let rejectInitialization!: (error: unknown) => void;
      const initialization = new Promise<void>((resolve, reject) => {
        resolveInitialization = resolve;
        rejectInitialization = reject;
      });
      const slot: WorkerSlot = {
        worker,
        ready: false,
        job: null,
        resolveInitialization,
        rejectInitialization,
      };
      this.slots.push(slot);
      worker.onmessage = (event: MessageEvent<unknown>) => this.handleMessage(slot, event.data);
      worker.onerror = () => {
        this.handleWorkerFailure(
          slot,
          new WorkerPoolUnavailableError(slot.ready ? 'Fairness worker failed' : 'Fairness worker could not initialize')
        );
      };
      initializationPromises.push(initialization);
    }
    await Promise.all(initializationPromises);
  }

  private pump(): void {
    if (this.failure) return;
    for (const slot of this.slots) {
      if (!slot.ready || slot.job) continue;
      const job = this.pending.shift();
      if (!job) break;
      if (job.signal?.aborted) {
        this.finishJob(job, new HeadlessSimulationCancelledError());
        continue;
      }
      slot.job = job;
      job.slot = slot;
      try {
        slot.worker.postMessage({ type: 'run', jobId: job.id, request: job.request, stepLimit: job.stepLimit });
      } catch (error) {
        this.handleWorkerFailure(
          slot,
          new WorkerPoolUnavailableError(error instanceof Error ? error.message : 'Fairness worker rejected a job')
        );
      }
    }
  }

  private cancel(job: Job): void {
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
      this.pump();
      return;
    }
    if (message.type === 'initError') {
      this.handleWorkerFailure(slot, new WorkerPoolUnavailableError(message.message));
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
    if (message.type === 'result' && job.signal?.aborted) this.finishJob(job, new HeadlessSimulationCancelledError());
    else if (message.type === 'result') this.finishJob(job, null, message.finishedMarbleIds);
    else if (message.type === 'cancelled') this.finishJob(job, new HeadlessSimulationCancelledError());
    else this.finishJob(job, new Error(message.message));
    this.pump();
  }

  private handleWorkerFailure(_slot: WorkerSlot, error: WorkerPoolUnavailableError): void {
    this.failPool(error);
  }

  private failPool(error: unknown): WorkerPoolUnavailableError {
    if (this.failure) return this.failure;
    this.failure = error instanceof WorkerPoolUnavailableError ? error : new WorkerPoolUnavailableError();
    this.slots.forEach((currentSlot) => {
      currentSlot.rejectInitialization?.(this.failure);
      currentSlot.resolveInitialization = null;
      currentSlot.rejectInitialization = null;
      const job = currentSlot.job;
      currentSlot.job = null;
      if (job) {
        job.slot = null;
        this.finishJob(job, job.signal?.aborted ? new HeadlessSimulationCancelledError() : this.failure);
      }
      currentSlot.worker.onmessage = null;
      currentSlot.worker.onerror = null;
      currentSlot.worker.terminate();
    });
    while (this.pending.length) {
      const job = this.pending.shift()!;
      this.finishJob(job, job.signal?.aborted ? new HeadlessSimulationCancelledError() : this.failure);
    }
    return this.failure;
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
