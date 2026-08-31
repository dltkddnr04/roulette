import { type ParsedName, parseName } from './utils';

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
