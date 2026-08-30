export type WinnerRange = { start: number; end: number };
export type RenderScale = 0.5 | 1 | 2;

export function isRenderScale(value: unknown): value is RenderScale {
  return value === 0.5 || value === 1 || value === 2;
}

class Options {
  useSkills: boolean = true;
  /** 0-based, 양끝 포함. 1명 추첨은 start === end */
  winnerRange: WinnerRange = { start: 0, end: 0 };
  autoRecording: boolean = true;
  renderScale: RenderScale = 0.5;
}

const options = new Options();
export default options;
