export function transformGuard(ctx: CanvasRenderingContext2D, func: (ctx: CanvasRenderingContext2D) => void): void {
  const originalTransform = ctx.getTransform();
  try {
    func(ctx);
  } finally {
    ctx.setTransform(originalTransform);
  }
}
