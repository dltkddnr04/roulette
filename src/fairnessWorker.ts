import {
  HeadlessSimulationCancelledError,
  type HeadlessSimulationRequest,
  simulateHeadlessRace,
} from './headlessSimulation';
import { RaceSimulation } from './raceSimulation';

type WorkerMessage =
  | Readonly<{ type: 'run'; jobId: string; request: HeadlessSimulationRequest; stepLimit: number }>
  | Readonly<{ type: 'cancel'; jobId: string }>;

type WorkerResponse =
  | Readonly<{ type: 'ready' }>
  | Readonly<{ type: 'initError'; message: string }>
  | Readonly<{ type: 'result'; jobId: string; finishedMarbleIds: readonly number[] }>
  | Readonly<{ type: 'cancelled'; jobId: string }>
  | Readonly<{ type: 'simulationError'; jobId: string; message: string }>;

type WorkerScope = {
  postMessage: (message: WorkerResponse) => void;
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
};

const scope = globalThis as unknown as WorkerScope;
const controllers = new Map<string, AbortController>();
const cancelledBeforeStart = new Set<string>();

let initializationError: Error | null = null;

const initialization = (async () => {
  const simulation = new RaceSimulation();
  try {
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

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'cancel') {
    const controller = controllers.get(message.jobId);
    if (controller) controller.abort();
    else cancelledBeforeStart.add(message.jobId);
    return;
  }

  void initialization.then(() => {
    if (initializationError) return;

    if (cancelledBeforeStart.delete(message.jobId)) {
      scope.postMessage({ type: 'cancelled', jobId: message.jobId });
      return;
    }

    const controller = new AbortController();
    controllers.set(message.jobId, controller);
    return simulateHeadlessRace(message.request, { signal: controller.signal, stepLimit: message.stepLimit })
      .then((result) => {
        if (controller.signal.aborted) {
          scope.postMessage({ type: 'cancelled', jobId: message.jobId });
          return;
        }
        scope.postMessage({ type: 'result', jobId: message.jobId, finishedMarbleIds: result.finishedMarbleIds });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || error instanceof HeadlessSimulationCancelledError) {
          scope.postMessage({ type: 'cancelled', jobId: message.jobId });
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
  });
};
