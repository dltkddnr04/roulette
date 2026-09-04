import type { ColorTheme } from './types/ColorTheme';
import type { MarbleRenderState } from './types/MarbleRenderState.type';
import type { Transform } from './utils/interpolation';
import { transformGuard } from './utils/transformGuard';
import { rad } from './utils/utils';

export type MarbleViewport = {
  x: number;
  y: number;
  w: number;
  h: number;
  zoom: number;
};

export type MarbleRenderOptions = {
  zoom: number;
  outline: boolean;
  isMinimap: boolean;
  skin?: CanvasImageSource;
  viewPort: MarbleViewport;
  theme: ColorTheme;
  skillsEnabled: boolean;
};

function marbleColor(hue: number): string {
  return `hsl(${hue} 100% 70%)`;
}

function drawMarbleBody(
  ctx: CanvasRenderingContext2D,
  state: MarbleRenderState,
  isMinimap: boolean,
  position: Transform
) {
  ctx.beginPath();
  ctx.arc(position.x, position.y, isMinimap ? state.size : state.size / 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawName(ctx: CanvasRenderingContext2D, state: MarbleRenderState, zoom: number, position: Transform) {
  transformGuard(ctx, () => {
    ctx.font = '12pt sans-serif';
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 2;
    ctx.fillStyle = marbleColor(state.hue);
    ctx.shadowBlur = 0;
    ctx.translate(position.x, position.y + 0.25);
    ctx.scale(1 / zoom, 1 / zoom);
    ctx.strokeText(state.name, 0, 0);
    ctx.fillText(state.name, 0, 0);
  });
}

function drawOutline(ctx: CanvasRenderingContext2D, state: MarbleRenderState, lineWidth: number, position: Transform) {
  ctx.beginPath();
  ctx.lineWidth = lineWidth;
  ctx.arc(position.x, position.y, state.size / 2, 0, Math.PI * 2);
  ctx.stroke();
}

function renderCoolTime(
  ctx: CanvasRenderingContext2D,
  state: MarbleRenderState,
  zoom: number,
  theme: ColorTheme,
  position: Transform
) {
  ctx.strokeStyle = theme.coolTimeIndicator;
  ctx.lineWidth = 1 / zoom;
  ctx.beginPath();
  ctx.arc(
    position.x,
    position.y,
    state.size / 2 + 2 / zoom,
    rad(270),
    rad(270 + (360 * state.coolTime) / state.maxCoolTime)
  );
  ctx.stroke();
}

export function renderMarble(
  ctx: CanvasRenderingContext2D,
  state: MarbleRenderState,
  options: MarbleRenderOptions
): void {
  const { zoom, outline, isMinimap, skin, viewPort, theme, skillsEnabled } = options;
  const position = state.position;
  const viewPortHw = viewPort.w / viewPort.zoom / 2;
  const viewPortHh = viewPort.h / viewPort.zoom / 2;
  const viewPortLeft = viewPort.x - viewPortHw;
  const viewPortRight = viewPort.x + viewPortHw;
  const viewPortTop = viewPort.y - viewPortHh - state.size / 2;
  const viewPortBottom = viewPort.y + viewPortHh;
  if (
    !isMinimap &&
    (position.x < viewPortLeft || position.x > viewPortRight || position.y < viewPortTop || position.y > viewPortBottom)
  ) {
    return;
  }

  if (isMinimap) {
    ctx.fillStyle = marbleColor(state.hue);
    drawMarbleBody(ctx, state, true, position);
    return;
  }

  const transform = ctx.getTransform();
  const halfSize = state.size / 2;
  try {
    ctx.fillStyle = `hsl(${state.hue} 100% ${theme.marbleLightness + 25 * Math.min(1, state.impact / 500)}%)`;

    if (skin) {
      transformGuard(ctx, () => {
        ctx.translate(position.x, position.y);
        ctx.rotate(position.angle);
        ctx.drawImage(skin, -halfSize, -halfSize, state.size, state.size);
      });
    } else {
      drawMarbleBody(ctx, state, false, position);
    }

    ctx.shadowColor = '';
    ctx.shadowBlur = 0;
    drawName(ctx, state, zoom, position);

    if (outline) {
      ctx.strokeStyle = theme.marbleWinningBorder;
      drawOutline(ctx, state, 2 / zoom, position);
    }

    if (skillsEnabled) {
      renderCoolTime(ctx, state, zoom, theme, position);
    }
  } finally {
    ctx.setTransform(transform);
  }
}
