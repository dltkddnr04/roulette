import { type ParsedName, parseName } from './utils';

export type SimulationParticipant = {
  name: string;
  weight: number;
  count: number;
};

export type SimulationParticipantSetup = {
  participants: SimulationParticipant[];
  totalCount: number;
};

export function getParticipantNames(value: string): string[] {
  return value
    .trim()
    .split(/[,\r\n]/g)
    .map((name) => name.trim())
    .filter(Boolean);
}

export function normalizeParticipantNames(names: string[]): string[] {
  const counts = new Map<string, number>();

  names.forEach((source) => {
    const parsed: ParsedName | null = parseName(source);
    if (!parsed) return;

    const key = parsed.weight > 1 ? `${parsed.name}/${parsed.weight}` : parsed.name;
    counts.set(key, (counts.get(key) ?? 0) + parsed.count);
  });

  return [...counts].map(([name, count]) => (count > 1 ? `${name}*${count}` : name));
}

/**
 * Keeps the exact parsing and weight normalization used by the rendered
 * RoundSession available to the fairness control plane.
 */
export function getSimulationParticipantSetup(names: readonly string[]): SimulationParticipantSetup | null {
  let maxWeight = -Infinity;
  let minWeight = Infinity;
  const participants: SimulationParticipant[] = names
    .map((nameString) => {
      const result = parseName(nameString);
      if (!result) return null;
      const { name, weight, count } = result;
      maxWeight = Math.max(maxWeight, weight);
      minWeight = Math.min(minWeight, weight);
      return { name, weight, count };
    })
    .filter((participant): participant is SimulationParticipant => participant !== null);

  const gap = maxWeight - minWeight;
  let totalCount = 0;
  participants.forEach((participant) => {
    participant.weight = 0.1 + (gap ? (participant.weight - minWeight) / gap : 0);
    totalCount += participant.count;
  });

  if (!Number.isSafeInteger(totalCount) || totalCount <= 0) return null;
  return { participants, totalCount };
}
