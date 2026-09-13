import { type StageDef, stages } from './data/maps';
import {
  DEFAULT_HEADLESS_STEP_LIMIT,
  type HeadlessSimulationOptions,
  mapMarbleIdsToLabels,
  simulateHeadlessRace,
} from './headlessSimulation';
import type { ReplayDescriptorV1 } from './replay';
import { validateReplayDescriptor } from './replay';
import { MAX_MARBLES } from './roundSession';
import { getMarbleSpawnLayout } from './utils/marbleSpawn';
import { getSimulationParticipantSetup } from './utils/participants';

export type SimulationFinisher = Readonly<{
  marbleId: number;
  name: string;
}>;

export type SimulationResult = Readonly<{
  replay: ReplayDescriptorV1;
  finished: readonly SimulationFinisher[];
  winners: readonly SimulationFinisher[];
  /** Number of completed fixed 10 ms physics steps. */
  steps: number;
}>;

export type SimulationOptions = Readonly<Pick<HeadlessSimulationOptions, 'stepLimit'>>;

export type SimulationExpectation = Readonly<Pick<SimulationResult, 'finished' | 'winners' | 'steps'>>;

export type SimulationVerificationResult = Readonly<{
  matches: boolean;
  actual: SimulationResult;
  expected: SimulationExpectation;
}>;

function cloneReplay(replay: ReplayDescriptorV1): ReplayDescriptorV1 {
  return {
    version: 1,
    seed: replay.seed,
    mapIndex: replay.mapIndex,
    participants: replay.participants.slice(),
    winnerRange: { ...replay.winnerRange },
    skillsEnabled: replay.skillsEnabled,
  };
}

function cloneFinishers(finishers: readonly SimulationFinisher[]): SimulationFinisher[] {
  return finishers.map((finisher) => ({ ...finisher }));
}

function invalid(message: string): never {
  throw new Error(`Invalid simulation expectation: ${message}`);
}

function normalizeExpectation(value: SimulationExpectation): SimulationExpectation {
  if (!value || typeof value !== 'object') invalid('expected result must be an object');
  if (!Number.isSafeInteger(value.steps) || value.steps < 0) invalid('steps must be a non-negative safe integer');

  const validateFinishers = (name: string, finishers: readonly SimulationFinisher[]): SimulationFinisher[] => {
    if (!Array.isArray(finishers)) invalid(`${name} must be an array`);
    return finishers.map((finisher) => {
      if (
        !finisher ||
        typeof finisher !== 'object' ||
        !Number.isSafeInteger(finisher.marbleId) ||
        finisher.marbleId < 0 ||
        typeof finisher.name !== 'string'
      ) {
        invalid(`${name} contains an invalid finisher`);
      }
      return { marbleId: finisher.marbleId, name: finisher.name };
    });
  };

  return {
    finished: validateFinishers('finished', value.finished),
    winners: validateFinishers('winners', value.winners),
    steps: value.steps,
  };
}

function sameFinishers(left: readonly SimulationFinisher[], right: readonly SimulationFinisher[]): boolean {
  return (
    left.length === right.length &&
    left.every((finisher, index) => {
      const other = right[index];
      return finisher.marbleId === other.marbleId && finisher.name === other.name;
    })
  );
}

function sameExpectation(actual: SimulationResult, expected: SimulationExpectation): boolean {
  return (
    actual.steps === expected.steps &&
    sameFinishers(actual.finished, expected.finished) &&
    sameFinishers(actual.winners, expected.winners)
  );
}

function clippedWinnerRange(replay: ReplayDescriptorV1, totalCount: number): { start: number; end: number } {
  const last = Math.max(0, totalCount - 1);
  const start = Math.min(Math.max(0, replay.winnerRange.start), last);
  return { start, end: Math.min(Math.max(start, replay.winnerRange.end), last) };
}

export class SimulationClient {
  private readonly stageDefinitions: readonly StageDef[];

  constructor(stageDefinitions: readonly StageDef[] = stages) {
    this.stageDefinitions = stageDefinitions;
  }

  async simulate(value: unknown, options: SimulationOptions = {}): Promise<SimulationResult> {
    const replay = validateReplayDescriptor(value, this.stageDefinitions.length);
    const stage = this.stageDefinitions[replay.mapIndex];
    if (!stage) throw new Error('Invalid simulation configuration: map is unavailable');

    const setup = getSimulationParticipantSetup(replay.participants);
    if (!setup || setup.totalCount <= 0 || setup.totalCount > MAX_MARBLES) {
      throw new Error(`Invalid simulation configuration: participant count must be between 1 and ${MAX_MARBLES}`);
    }

    const winnerRange = clippedWinnerRange(replay, setup.totalCount);
    const spawnLayout = getMarbleSpawnLayout(setup.totalCount, stage.spawn);
    const headless = await simulateHeadlessRace(
      {
        seed: replay.seed,
        stage,
        participants: setup.participants,
        totalCount: setup.totalCount,
        spawnPositions: spawnLayout.positions,
        skillsEnabled: replay.skillsEnabled,
        targetRank: winnerRange.end,
      },
      { stepLimit: options.stepLimit ?? DEFAULT_HEADLESS_STEP_LIMIT }
    );

    const marbleNames = mapMarbleIdsToLabels(
      replay.seed,
      setup.participants.map((participant) => ({ label: participant.name, count: participant.count }))
    );
    const finished = headless.finishedMarbleIds.map((marbleId) => {
      const name = marbleNames.get(marbleId);
      if (name === undefined) throw new Error('Simulation result could not be mapped to a participant');
      return { marbleId, name };
    });

    return {
      replay: cloneReplay(replay),
      finished: cloneFinishers(finished),
      winners: cloneFinishers(finished.slice(winnerRange.start, winnerRange.end + 1)),
      steps: headless.steps,
    };
  }

  preview(value: unknown, options: SimulationOptions = {}): Promise<SimulationResult> {
    return this.simulate(value, options);
  }

  async verify(value: unknown, expected: SimulationExpectation): Promise<SimulationVerificationResult> {
    const normalizedExpected = normalizeExpectation(expected);
    const actual = await this.simulate(value);
    return {
      matches: sameExpectation(actual, normalizedExpected),
      actual,
      expected: {
        finished: cloneFinishers(normalizedExpected.finished),
        winners: cloneFinishers(normalizedExpected.winners),
        steps: normalizedExpected.steps,
      },
    };
  }
}
