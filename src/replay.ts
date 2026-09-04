import type { RenderScale, WinnerRange } from './options';
import { MAX_MARBLES, type RoundState } from './roundSession';
import type { Seed } from './utils/random';
import { parseName } from './utils/utils';

export type ReplayDescriptorV1 = Readonly<{
  version: 1;
  seed: Seed;
  mapIndex: number;
  participants: readonly string[];
  winnerRange: Readonly<WinnerRange>;
  skillsEnabled: boolean;
}>;

export type ReplayDescriptor = ReplayDescriptorV1;

export type ThemeName = 'dark' | 'light';

export type RouletteState = Readonly<{
  roundState: RoundState;
  map: Readonly<{ index: number; title: string }> | null;
  count: number;
  seed: Seed;
  seedMode: 'random' | 'explicit';
  winnerRange: Readonly<WinnerRange>;
  speed: number;
  fastForward: boolean;
  skillsEnabled: boolean;
  renderScale: RenderScale;
  autoRecording: boolean;
  theme: ThemeName;
}>;

function invalid(message: string): never {
  throw new Error(`Invalid replay descriptor: ${message}`);
}

export function validateReplayDescriptor(value: unknown, mapCount: number): ReplayDescriptorV1 {
  if (!value || typeof value !== 'object') invalid('expected an object');

  const descriptor = value as Partial<ReplayDescriptorV1>;
  if (descriptor.version !== 1) invalid('unsupported version');
  if (
    (typeof descriptor.seed !== 'string' && typeof descriptor.seed !== 'number') ||
    (typeof descriptor.seed === 'number' && !Number.isFinite(descriptor.seed))
  ) {
    invalid('seed must be a finite number or string');
  }
  const mapIndex = descriptor.mapIndex;
  if (typeof mapIndex !== 'number' || !Number.isSafeInteger(mapIndex) || mapIndex < 0 || mapIndex >= mapCount) {
    invalid('mapIndex is out of range');
  }
  if (!Array.isArray(descriptor.participants) || descriptor.participants.length === 0) {
    invalid('participants must be a non-empty array');
  }

  let totalCount = 0;
  const participants = descriptor.participants.map((participant) => {
    if (typeof participant !== 'string' || !parseName(participant)) {
      invalid('participants must contain valid participant strings');
    }
    totalCount += parseName(participant)?.count ?? 0;
    return participant;
  });
  if (!Number.isSafeInteger(totalCount) || totalCount <= 0 || totalCount > MAX_MARBLES) {
    invalid(`participant count must be between 1 and ${MAX_MARBLES}`);
  }

  const range = descriptor.winnerRange;
  if (
    !range ||
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start
  ) {
    invalid('winnerRange must contain a valid non-negative range');
  }
  if (typeof descriptor.skillsEnabled !== 'boolean') invalid('skillsEnabled must be boolean');

  return {
    version: 1,
    seed: descriptor.seed,
    mapIndex,
    participants: participants.slice(),
    winnerRange: { start: range.start, end: range.end },
    skillsEnabled: descriptor.skillsEnabled,
  };
}
