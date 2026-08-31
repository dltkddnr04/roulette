import type { RandomSource } from './random';

export function rad(degree: number) {
  return (Math.PI * degree) / 180;
}

export type ParsedName = {
  name: string;
  weight: number;
  count: number;
};

export function parseName(nameStr: string): ParsedName | null {
  const match = /^\s*([^/*]+?)(?:(?:\/([0-9]+)(?:\*([0-9]+))?)|(?:\*([0-9]+)(?:\/([0-9]+))?))?\s*$/.exec(nameStr);
  if (!match) return null;

  const name = match[1].trim();
  const weight = Number(match[2] ?? match[5] ?? 1);
  const count = Number(match[3] ?? match[4] ?? 1);
  if (!name || !Number.isSafeInteger(weight) || weight <= 0 || !Number.isSafeInteger(count) || count <= 0) return null;

  return {
    name,
    weight,
    count,
  };
}

export function pad(v: number) {
  return v.toString().padStart(2, '0');
}

export function shuffle<T>(originalArray: T[], randomSource: RandomSource): T[] {
  const array = originalArray.slice();
  let currentIndex = array.length;
  let randomIndex;

  // While there remain elements to shuffle.
  while (currentIndex !== 0) {
    // Pick a remaining element.
    randomIndex = Math.floor(randomSource.next() * currentIndex);
    currentIndex--;

    // And swap it with the current element.
    [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
  }

  return array;
}
