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
  | Readonly<{ type: 'result'; jobId: string; finishedMarbleIds: readonly number[] }>
  | Readonly<{ type: 'cancelled'; jobId: string }>
  | Readonly<{ type: 'error'; jobId: string; message: string }>;

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const type = (value as { type?: unknown }).type;
  if (type === 'ready') return true;
  if (!('jobId' in value) || typeof (value as { jobId?: unknown }).jobId !== 'string') return false;
  if (type === 'result') {
    const finishedMarbleIds = (value as { finishedMarbleIds?: unknown }).finishedMarbleIds;
    return (
      Array.isArray(finishedMarbleIds) &&
      finishedMarbleIds.every((id) => typeof id === 'number' && Number.isSafeInteger(id))
    );
  }
  if (type === 'cancelled') return true;
  return type === 'error' && typeof (value as { message?: unknown }).message === 'string';
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
};

type WorkerSlot = {
  worker: Worker;
  ready: boolean;
  job: Job | null;
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
  private failed = false;

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
      };
      if (signal) {
        const onAbort = () => this.cancel(job);
        signal.addEventListener('abort', onAbort, { once: true });
        job.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
      this.pending.push(job);
      this.pump();
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.failed) throw new WorkerPoolUnavailableError();
    if (this.readyPromise) return this.readyPromise;
    if (!this.supported) {
      this.failed = true;
      throw new WorkerPoolUnavailableError('Web Workers are unavailable');
    }

    this.readyPromise = Promise.all(
      Array.from({ length: this.concurrency }, () => {
        let worker: Worker;
        try {
          worker = new Worker(new URL('./fairnessWorker.ts', import.meta.url), { type: 'module' });
        } catch (error) {
          return Promise.reject(
            new WorkerPoolUnavailableError(error instanceof Error ? error.message : 'Fairness worker could not start')
          );
        }
        const slot: WorkerSlot = { worker, ready: false, job: null };
        this.slots.push(slot);
        worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleMessage(slot, event.data);
        worker.onerror = () => this.handleWorkerFailure(slot, new WorkerPoolUnavailableError('Fairness worker failed'));
        return new Promise<void>((resolve, reject) => {
          const previous = worker.onmessage;
          worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            if (!isWorkerResponse(event.data)) {
              reject(new WorkerPoolUnavailableError('Fairness worker sent an invalid initialization response'));
              return;
            }
            if (event.data.type === 'ready') {
              slot.ready = true;
              resolve();
              worker.onmessage = previous;
              worker.onerror = () =>
                this.handleWorkerFailure(slot, new WorkerPoolUnavailableError('Fairness worker failed'));
              return;
            }
            previous?.call(worker, event);
          };
          worker.onerror = () => reject(new WorkerPoolUnavailableError('Fairness worker could not initialize'));
        });
      })
    )
      .then(() => undefined)
      .catch((error) => {
        this.failed = true;
        this.slots.forEach(({ worker }) => worker.terminate());
        throw error instanceof WorkerPoolUnavailableError ? error : new WorkerPoolUnavailableError();
      });
    return this.readyPromise;
  }

  private pump(): void {
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
      slot.ready = true;
      this.pump();
      return;
    }
    if (!slot.job || slot.job.id !== message.jobId) return;
    const job = slot.job;
    slot.job = null;
    job.slot = null;
    if (message.type === 'result') this.finishJob(job, null, message.finishedMarbleIds);
    else if (message.type === 'cancelled') this.finishJob(job, new HeadlessSimulationCancelledError());
    else this.finishJob(job, new Error(message.message));
    this.pump();
  }

  private handleWorkerFailure(_slot: WorkerSlot, error: WorkerPoolUnavailableError): void {
    if (this.failed) return;
    this.failed = true;
    this.slots.forEach((currentSlot) => {
      const job = currentSlot.job;
      currentSlot.job = null;
      if (job) {
        job.slot = null;
        this.finishJob(job, error);
      }
      currentSlot.worker.terminate();
    });
    while (this.pending.length) this.finishJob(this.pending.shift()!, error);
  }

  private finishJob(job: Job, error: unknown, result?: readonly number[]): void {
    job.removeAbortListener?.();
    job.removeAbortListener = null;
    if (error) job.reject(error);
    else job.resolve(result ?? []);
  }
}
