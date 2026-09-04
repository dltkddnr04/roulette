export type WinnerRange = { start: number; end: number };
export type RenderScale = 0.5 | 1;

export function isRenderScale(value: unknown): value is RenderScale {
  return value === 0.5 || value === 1;
}
