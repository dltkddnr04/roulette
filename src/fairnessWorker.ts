import {
  HeadlessSimulationCancelledError,
  type HeadlessSimulationRequest,
  simulateHeadlessRace,
} from './headlessSimulation';
import { RaceSimulation } from './raceSimulation';

type HeadlessSimulationRequestWithoutSeed = Omit<HeadlessSimulationRequest, 'seed'>;

type WorkerMessage =
  | Readonly<{
      type: 'configurePlan';
      planId: string;
      requestWithoutSeed: HeadlessSimulationRequestWithoutSeed;
    }>
  | Readonly<{
      type: 'run';
      jobId: string;
      request: HeadlessSimulationRequest;
      stepLimit: number;
    }>
  | Readonly<{
      type: 'run';
      jobId: string;
      planId: string;
      seed: HeadlessSimulationRequest['seed'];
      attemptIndex?: number;
      stepLimit: number;
    }>
  | Readonly<{ type: 'cancel'; jobId: string }>
  | Readonly<{ type: 'dropPlan'; planId: string }>;

type WorkerResponse =
  | Readonly<{ type: 'ready' }>
  | Readonly<{ type: 'initError'; message: string }>
  | Readonly<{ type: 'planReady'; planId: string }>
  | Readonly<{ type: 'result'; jobId: string; finishedMarbleIds: readonly number[] }>
  | Readonly<{ type: 'cancelled'; jobId: string }>
  | Readonly<{ type: 'simulationError'; jobId: string; message: string }>
  | Readonly<{ type: 'fatal'; jobId?: string; message: string }>;

type WorkerScope = {
  postMessage: (message: WorkerResponse) => void;
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
};

const scope = globalThis as unknown as WorkerScope;
const controllers = new Map<string, AbortController>();
const cancelledBeforeStart = new Set<string>();
const plans = new Map<string, HeadlessSimulationRequestWithoutSeed>();

let initializationError: Error | null = null;

const initialization = (async () => {
  const simulation = new RaceSimulation();
  try {
    // Keep readiness tied to the same production Box2D initialization used by
    // simulateHeadlessRace. A worker is not ready until WASM is usable.
    await simulation.init();
  } finally {
    simulation.dispose();
  }
})()
  .then(() => {
    scope.postMessage({ type: 'ready' });
  })
  .catch((error: unknown) => {
    initializationError = error instanceof Error ? error : new Error('Fairness worker could not initialize');
    scope.postMessage({ type: 'initError', message: initializationError.message });
  });

function postCancelled(jobId: string): void {
  scope.postMessage({ type: 'cancelled', jobId });
}

function runJob(message: Extract<WorkerMessage, { type: 'run' }>): void {
  let request: HeadlessSimulationRequest;
  if ('planId' in message) {
    const requestWithoutSeed = plans.get(message.planId);
    if (!requestWithoutSeed) {
      scope.postMessage({
        type: 'fatal',
        jobId: message.jobId,
        message: `Fairness worker plan is not configured: ${message.planId}`,
      });
      return;
    }
    // The plan is seed-independent. Reconstruct the exact production request
    // only by adding the seed supplied for this candidate run.
    request = { ...requestWithoutSeed, seed: message.seed };
  } else {
    request = message.request;
  }

  if (cancelledBeforeStart.delete(message.jobId)) {
    postCancelled(message.jobId);
    return;
  }

  const controller = new AbortController();
  controllers.set(message.jobId, controller);
  void simulateHeadlessRace(request, { signal: controller.signal, stepLimit: message.stepLimit })
    .then((result) => {
      if (controller.signal.aborted) {
        postCancelled(message.jobId);
        return;
      }
      scope.postMessage({ type: 'result', jobId: message.jobId, finishedMarbleIds: result.finishedMarbleIds });
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted || error instanceof HeadlessSimulationCancelledError) {
        postCancelled(message.jobId);
        return;
      }
      scope.postMessage({
        type: 'simulationError',
        jobId: message.jobId,
        message: error instanceof Error ? error.message : 'Headless worker simulation failed',
      });
    })
    .then(
      () => {
        controllers.delete(message.jobId);
      },
      () => {
        controllers.delete(message.jobId);
      }
    );
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'cancel') {
    const controller = controllers.get(message.jobId);
    if (controller) controller.abort();
    else cancelledBeforeStart.add(message.jobId);
    return;
  }

  // Keep non-cancellation messages in arrival order behind initialization.
  // This makes configurePlan -> run and configurePlan -> dropPlan ordering
  // deterministic even when the main thread posts before ready.
  void initialization.then(() => {
    if (initializationError) return;
    if (message.type === 'configurePlan') {
      plans.set(message.planId, message.requestWithoutSeed);
      scope.postMessage({ type: 'planReady', planId: message.planId });
      return;
    }
    if (message.type === 'dropPlan') {
      plans.delete(message.planId);
      return;
    }
    runJob(message);
  });
};
