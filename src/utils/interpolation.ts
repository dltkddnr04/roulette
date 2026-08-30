export type Transform = {
  x: number;
  y: number;
  angle: number;
};

const TAU = Math.PI * 2;

export function interpolateAngle(previous: number, current: number, alpha: number): number {
  const delta = ((((current - previous + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return previous + delta * alpha;
}

export function interpolateTransform(previous: Transform, current: Transform, alpha: number): Transform {
  return {
    x: previous.x + (current.x - previous.x) * alpha,
    y: previous.y + (current.y - previous.y) * alpha,
    angle: interpolateAngle(previous.angle, current.angle, alpha),
  };
}
