export function rad(degree: number) {
  return (Math.PI * degree) / 180;
}

function getRegexValue(regex: RegExp, str: string) {
  const result = regex.exec(str);
  return result ? result[1] : '';
}

export function parseName(nameStr: string) {
  const weightRegex = /\/(\d+)/;
  const countRegex = /\*(\d+)/;
  const name = getRegexValue(/^\s*([^/*]+)?/, nameStr);
  if (!name) return null;
  const weight = weightRegex.test(nameStr) ? Number(getRegexValue(weightRegex, nameStr)) : 1;
  const count = countRegex.test(nameStr) ? Number(getRegexValue(countRegex, nameStr)) : 1;
  if (!Number.isSafeInteger(weight) || weight <= 0 || !Number.isSafeInteger(count) || count <= 0) return null;
  return {
    name,
    weight,
    count,
  };
}

export function pad(v: number) {
  return v.toString().padStart(2, '0');
}

export function shuffle<T>(originalArray: T[]): T[] {
  const array = originalArray.slice();
  let currentIndex = array.length;
  let randomIndex;

  // While there remain elements to shuffle.
  while (currentIndex !== 0) {
    // Pick a remaining element.
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;

    // And swap it with the current element.
    [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
  }

  return array;
}
