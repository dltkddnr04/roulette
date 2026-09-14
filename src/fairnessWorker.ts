import {
  HeadlessSimulationCancelledError,
  type HeadlessSimulationRequest,
  simulateHeadlessRace,
} from './headlessSimulation';

type WorkerMessage =
  | Readonly<{ type: 'run'; jobId: string; request: HeadlessSimulationRequest; stepLimit: number }>
  | Readonly<{ type: 'cancel'; jobId: string }>;

type WorkerResponse =
  | Readonly<{ type: 'ready' }>
  | Readonly<{ type: 'result'; jobId: string; finishedMarbleIds: readonly number[] }>
  | Readonly<{ type: 'cancelled'; jobId: string }>
  | Readonly<{ type: 'error'; jobId: string; message: string }>;

type WorkerScope = {
  postMessage: (message: WorkerResponse) => void;
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
};

const scope = globalThis as unknown as WorkerScope;
const controllers = new Map<string, AbortController>();

scope.postMessage({ type: 'ready' });
scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'cancel') {
    controllers.get(message.jobId)?.abort();
    return;
  }

  const controller = new AbortController();
  controllers.set(message.jobId, controller);
  void simulateHeadlessRace(message.request, { signal: controller.signal, stepLimit: message.stepLimit })
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
        type: 'error',
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
};
