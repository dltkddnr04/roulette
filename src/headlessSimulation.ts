import type { StageDef } from './data/maps';
import { type MarbleParticipant, RaceSimulation } from './raceSimulation';
import type { VectorLike } from './types/VectorLike';
import type { Seed } from './utils/random';
import { createSeededRandom } from './utils/random';
import { shuffle } from './utils/utils';

export const DEFAULT_HEADLESS_STEP_LIMIT = 30000;

export type HeadlessSimulationRequest = Readonly<{
  seed: Seed;
  stage: StageDef;
  participants: readonly MarbleParticipant[];
  totalCount: number;
  spawnPositions: readonly VectorLike[];
  skillsEnabled: boolean;
  targetRank: number;
}>;

export type HeadlessSimulationOptions = Readonly<{
  stepLimit?: number;
}>;

export type HeadlessSimulationResult = Readonly<{
  finishedMarbleIds: readonly number[];
  steps: number;
}>;

function validateStepLimit(stepLimit: number): void {
  if (!Number.isSafeInteger(stepLimit) || stepLimit <= 0) {
    throw new Error('Headless simulation step limit must be a positive safe integer');
  }
}

/**
 * Run the authoritative RaceSimulation loop without any renderer or UI.
 * `stepLimit` limits host advances, preserving the existing fairness runner
 * budget while `steps` reports completed fixed physics steps.
 */
export async function simulateHeadlessRace(
  request: HeadlessSimulationRequest,
  options: HeadlessSimulationOptions = {}
): Promise<HeadlessSimulationResult> {
  const stepLimit = options.stepLimit ?? DEFAULT_HEADLESS_STEP_LIMIT;
  validateStepLimit(stepLimit);

  const simulation = new RaceSimulation(undefined, request.seed);
  try {
    await simulation.init();
    simulation.loadStage(request.stage);
    simulation.setSkillsEnabled(request.skillsEnabled);
    simulation.replaceMarbles(request.participants, request.totalCount, [...request.spawnPositions]);
    simulation.start();

    const finishedMarbleIds: number[] = [];
    let steps = 0;
    let advances = 0;
    while (finishedMarbleIds.length <= request.targetRank && advances < stepLimit) {
      simulation.advance(80, 1, 1, {
        onImpact() {},
        onFinish(marble) {
          finishedMarbleIds.push(marble.id);
        },
        afterStep() {
          return 1;
        },
        onStepComplete() {
          steps++;
        },
      });
      advances++;
      if (advances % 16 === 0) await yieldToHost();
    }

    if (finishedMarbleIds.length <= request.targetRank) {
      throw new Error('Headless simulation did not reach the requested rank');
    }
    return { finishedMarbleIds: finishedMarbleIds.slice(0, request.targetRank + 1), steps };
  } finally {
    simulation.dispose();
  }
}

export function mapMarbleIdsToLabels(
  seed: Seed,
  participants: readonly Readonly<{ label: string; count: number }>[]
): Map<number, string> {
  const totalCount = participants.reduce((total, participant) => total + participant.count, 0);
  const orders = shuffle(
    Array.from({ length: totalCount }, (_, index) => index),
    createSeededRandom(seed)
  );
  const mapping = new Map<number, string>();
  participants.forEach((participant) => {
    for (let index = 0; index < participant.count; index++) {
      const order = orders.pop();
      if (order !== undefined) mapping.set(order, participant.label);
    }
  });
  return mapping;
}

async function yieldToHost(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, 0);
    else resolve();
  });
}
