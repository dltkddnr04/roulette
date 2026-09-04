import type { Camera } from './camera';
import { canvasHeight, canvasWidth, initialZoom, Themes, winnerAreaHeight } from './data/constants';
import type { StageDef } from './data/maps';
import { renderMarble } from './marbleRenderer';
import { MINIMAP_INSET, MINIMAP_WIDTH } from './minimap';
import { isRenderScale, type RenderScale, type WinnerRange } from './options';
import type { PresentationEffectsRenderState } from './presentationEffects';
import type { SkillEffectRenderState } from './skillEffect';
import type { ColorTheme } from './types/ColorTheme';
import type { MapEntityRenderState } from './types/MapEntity.type';
import type { MarblePresentationState, MarbleRenderState } from './types/MarbleRenderState.type';
import type { Rect } from './types/rect.type';
import type { VectorLike } from './types/VectorLike';
import type { UIObject } from './UIObject';

export type RenderParameters = {
  camera: Camera;
  stage: StageDef;
  sponsorImage: HTMLImageElement | null;
  entities: MapEntityRenderState[];
  marbles: MarbleRenderState[];
  winners: readonly MarblePresentationState[];
  effects: PresentationEffectsRenderState;
  winnerRange: WinnerRange;
  /** 진행 중에는 null, 당첨자가 모두 확정되면 당첨자 배열 */
  result: readonly MarblePresentationState[] | null;
  size: VectorLike;
  theme: ColorTheme;
  alpha: number;
  skillsEnabled: boolean;
};

const WINNER_TEXT_OFFSET = 30;
const RESULT_PANEL_MAX_WIDTH_RATIO = 0.9;
const RESULT_PANEL_MAX_HEIGHT_RATIO = 0.8;
const RESULT_COLUMN_MAX_WIDTH = 280;
const PROGRESS_MAX_WIDTH_RATIO = 0.3;
const PROGRESS_ACCENT = 'rgba(255, 215, 0, 0.8)';
const CLOSE_HIT_PADDING = 8;
const DEFAULT_SPONSOR_BOARD_WIDTH = 4;
const DEFAULT_SPONSOR_BOARD_HEIGHT = 1;

function inRect(rect: Rect | undefined, x: number, y: number): boolean {
  return !!rect && x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function resultCloseButtonSize(height: number): number {
  return Math.min(34, Math.max(20, height * 0.045));
}

function drawResultCloseCircle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  fill: string
): Rect {
  const arm = size * 0.22;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = Math.max(1.5, size * 0.07);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - arm, cy - arm);
  ctx.lineTo(cx + arm, cy + arm);
  ctx.moveTo(cx + arm, cy - arm);
  ctx.lineTo(cx - arm, cy + arm);
  ctx.stroke();
  ctx.restore();

  return {
    x: cx - size / 2 - CLOSE_HIT_PADDING,
    y: cy - size / 2 - CLOSE_HIT_PADDING,
    w: size + CLOSE_HIT_PADDING * 2,
    h: size + CLOSE_HIT_PADDING * 2,
  };
}

export class RouletteRenderer {
  protected _canvas!: HTMLCanvasElement;
  protected ctx!: CanvasRenderingContext2D;
  private _logicalWidth = canvasWidth;
  private _logicalHeight = canvasHeight;
  private _renderScale: RenderScale = 0.5;
  private _logicalToPhysicalScale = 1;
  private _dprMediaQueryList: MediaQueryList | null = null;
  private _resizeHandler = () => {
    this.resize();
    this.watchDevicePixelRatio();
  };
  public sizeFactor = 1;

  protected _images: { [key: string]: HTMLImageElement } = {};
  protected _theme: ColorTheme = Themes.dark;
  private _resultCloseRect: Rect | null = null;
  private _resultPopupClosed = false;
  private _lastResult: readonly MarblePresentationState[] | null = null;

  get width() {
    return this._logicalWidth;
  }

  get height() {
    return this._logicalHeight;
  }

  get canvas() {
    return this._canvas;
  }

  set theme(value: ColorTheme) {
    this._theme = value;
  }

  public setRenderScale(value: RenderScale): void {
    if (!isRenderScale(value)) return;

    this._renderScale = value;
    this.resize();
  }

  public resize(entries?: ResizeObserverEntry[]): void {
    if (!this._canvas) return;

    const realSize = entries?.[0]?.contentRect ?? this._canvas.getBoundingClientRect();
    if (realSize.width <= 0 || realSize.height <= 0) return;

    // Keep the logical viewport's minimum for framing, but derive the physical
    // backing resolution solely from the display size and selected quality.
    const logicalWidth = Math.max(realSize.width / 2, 640);
    const logicalHeight = (logicalWidth / realSize.width) * realSize.height;
    const devicePixelRatio =
      typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1;
    const physicalWidth = Math.max(1, Math.round(realSize.width * devicePixelRatio * this._renderScale));
    const physicalHeight = Math.max(1, Math.round((physicalWidth / realSize.width) * realSize.height));

    this._logicalWidth = logicalWidth;
    this._logicalHeight = logicalHeight;
    this._logicalToPhysicalScale = physicalWidth / logicalWidth;
    this.sizeFactor = logicalWidth / realSize.width;

    this._canvas.width = physicalWidth;
    this._canvas.height = physicalHeight;
  }

  private watchDevicePixelRatio(): void {
    if (this._dprMediaQueryList) {
      if (typeof this._dprMediaQueryList.removeEventListener === 'function') {
        this._dprMediaQueryList.removeEventListener('change', this._resizeHandler);
      }
      if (typeof this._dprMediaQueryList.removeListener === 'function') {
        this._dprMediaQueryList.removeListener(this._resizeHandler);
      }
    }
    this._dprMediaQueryList = null;

    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const devicePixelRatio =
      Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    this._dprMediaQueryList = window.matchMedia(`(resolution: ${devicePixelRatio}dppx)`);

    if (typeof this._dprMediaQueryList.addEventListener === 'function') {
      this._dprMediaQueryList.addEventListener('change', this._resizeHandler);
    } else if (typeof this._dprMediaQueryList.addListener === 'function') {
      this._dprMediaQueryList.addListener(this._resizeHandler);
    }
  }

  async init() {
    await this._load();

    this._canvas = document.createElement('canvas');
    this.ctx = this._canvas.getContext('2d', {
      alpha: false,
    }) as CanvasRenderingContext2D;

    document.body.appendChild(this._canvas);

    const resizeObserver = new ResizeObserver((entries) => this.resize(entries));

    resizeObserver.observe(this._canvas);
    window.addEventListener('resize', this._resizeHandler);
    this.watchDevicePixelRatio();
    this.resize();
  }

  private async _loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.addEventListener('load', () => {
        resolve(img);
      });
      img.addEventListener('error', () => {
        reject(new Error(`Failed to load image: ${url}`));
      });
      img.src = url;
    });
  }

  private async _load(): Promise<void> {
    const loadPromises = [
      { name: '챔루', imgUrl: new URL('../assets/images/chamru.png', import.meta.url) },
      { name: '쿠빈', imgUrl: new URL('../assets/images/kubin.png', import.meta.url) },
      { name: '꽉변', imgUrl: new URL('../assets/images/kkwak.png', import.meta.url) },
      { name: '꽉변호사', imgUrl: new URL('../assets/images/kkwak.png', import.meta.url) },
      { name: '꽉 변호사', imgUrl: new URL('../assets/images/kkwak.png', import.meta.url) },
      { name: '주누피', imgUrl: new URL('../assets/images/junyoop.png', import.meta.url) },
      { name: '왈도쿤', imgUrl: new URL('../assets/images/waldokun.png', import.meta.url) },
    ].map(({ name, imgUrl }) => {
      return (async () => {
        try {
          this._images[name] = await this._loadImage(imgUrl.toString());
        } catch (e) {
          console.warn(`Marble skin unavailable: ${name}`, e);
        }
      })();
    });

    await Promise.all(loadPromises);
  }

  private getMarbleImage(name: string): CanvasImageSource | undefined {
    return this._images[name] ?? undefined;
  }

  protected onBeforeEntities(): void {}
  protected onAfterScene(): void {}

  render(renderParameters: RenderParameters, uiObjects: UIObject[]) {
    this._theme = renderParameters.theme;
    const logicalWidth = this.width;
    const logicalHeight = this.height;

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(this._logicalToPhysicalScale, this._logicalToPhysicalScale);
    this.ctx.fillStyle = this._theme.background;
    this.ctx.fillRect(0, 0, logicalWidth, logicalHeight);

    this.ctx.save();
    this.ctx.scale(initialZoom, initialZoom);
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'top';
    this.ctx.font = '0.4pt sans-serif';
    this.ctx.lineWidth = 3 / (renderParameters.camera.zoom + initialZoom);
    renderParameters.camera.renderScene(
      this.ctx,
      () => {
        this.renderSponsorBoards(renderParameters.stage, renderParameters.sponsorImage);
        this.onBeforeEntities();
        this.renderEntities(renderParameters.entities);
        this.renderEffects(renderParameters);
        this.renderMarbles(renderParameters);
      },
      { x: logicalWidth, y: logicalHeight }
    );
    this.ctx.restore();
    this.onAfterScene();

    uiObjects.forEach((obj) => obj.render(this.ctx, renderParameters, logicalWidth, logicalHeight));
    this.renderParticles(renderParameters.effects);
    this.renderWinnerProgress(renderParameters);
    this.renderResult(renderParameters);
  }

  private renderSponsorBoards(stage: StageDef, image: HTMLImageElement | null): void {
    if (!image || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    if (!stage.branding?.length) return;

    const imageRatio = image.naturalWidth / image.naturalHeight;
    this.ctx.save();
    stage.branding.forEach((board) => {
      const width = board.w ?? DEFAULT_SPONSOR_BOARD_WIDTH;
      const height = board.h ?? DEFAULT_SPONSOR_BOARD_HEIGHT;
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return;

      const left = board.x - width / 2;
      const top = board.y - height / 2;
      this.ctx.fillStyle = '#fff';
      this.ctx.fillRect(left, top, width, height);

      const boardRatio = width / height;
      const drawWidth = imageRatio > boardRatio ? width : height * imageRatio;
      const drawHeight = imageRatio > boardRatio ? width / imageRatio : height;
      this.ctx.drawImage(image, left + (width - drawWidth) / 2, top + (height - drawHeight) / 2, drawWidth, drawHeight);
    });
    this.ctx.restore();
  }

  private renderEntities(entities: MapEntityRenderState[]) {
    this.ctx.save();
    try {
      entities.forEach((entity) => {
        const transform = this.ctx.getTransform();
        try {
          this.ctx.translate(entity.x, entity.y);
          this.ctx.rotate(entity.angle);
          this.ctx.fillStyle = entity.shape.color ?? this._theme.entity[entity.shape.type].fill;
          this.ctx.strokeStyle = entity.shape.color ?? this._theme.entity[entity.shape.type].outline;
          this.ctx.shadowBlur = this._theme.entity[entity.shape.type].bloomRadius;
          this.ctx.shadowColor =
            entity.shape.bloomColor ?? entity.shape.color ?? this._theme.entity[entity.shape.type].bloom;
          const shape = entity.shape;
          switch (shape.type) {
            case 'polyline':
              if (shape.points.length > 0) {
                this.ctx.beginPath();
                this.ctx.moveTo(shape.points[0][0], shape.points[0][1]);
                for (let i = 1; i < shape.points.length; i++) {
                  this.ctx.lineTo(shape.points[i][0], shape.points[i][1]);
                }
                this.ctx.stroke();
              }
              break;
            case 'box': {
              const w = shape.halfWidth * 2;
              const h = shape.halfHeight * 2;
              this.ctx.rotate(shape.rotation);
              this.ctx.fillRect(-w / 2, -h / 2, w, h);
              this.ctx.strokeRect(-w / 2, -h / 2, w, h);
              break;
            }
            case 'circle':
              this.ctx.beginPath();
              this.ctx.arc(0, 0, shape.radius, 0, Math.PI * 2, false);
              this.ctx.stroke();
              break;
          }
        } finally {
          this.ctx.setTransform(transform);
        }
      });
    } finally {
      this.ctx.restore();
    }
  }

  private renderEffects({ effects, camera }: RenderParameters) {
    effects.skillEffects.forEach((effect) => {
      this.renderSkillEffect(effect, camera.zoom * initialZoom);
    });
  }

  private renderSkillEffect(effect: SkillEffectRenderState, zoom: number) {
    this.ctx.save();
    this.ctx.globalAlpha = effect.alpha;
    this.ctx.strokeStyle = this._theme.skillColor;
    this.ctx.lineWidth = 1 / zoom;
    this.ctx.beginPath();
    this.ctx.arc(effect.x, effect.y, effect.size, 0, Math.PI * 2);
    this.ctx.stroke();
    this.ctx.restore();
  }

  private renderParticles({ particles }: PresentationEffectsRenderState) {
    particles.forEach((particle) => {
      this.ctx.save();
      this.ctx.globalAlpha = particle.alpha;
      this.ctx.fillStyle = particle.color;
      this.ctx.fillRect(particle.x, particle.y, 20, 20);
      this.ctx.restore();
    });
  }

  private renderMarbles({ marbles, camera, winnerRange, winners, size, skillsEnabled }: RenderParameters) {
    const firstIndex = winnerRange.start - winners.length;
    const lastIndex = winnerRange.end - winners.length;

    const viewPort = { x: camera.x, y: camera.y, w: size.x, h: size.y, zoom: camera.zoom * initialZoom };
    marbles.forEach((marble, i) => {
      renderMarble(this.ctx, marble, {
        zoom: camera.zoom * initialZoom,
        outline: i >= firstIndex && i <= lastIndex,
        isMinimap: false,
        skin: this.getMarbleImage(marble.name),
        viewPort,
        theme: this._theme,
        skillsEnabled,
      });
    });
  }

  private renderResult(params: RenderParameters) {
    const result = params.result;
    // 새 결과가 나오면(또는 리셋되면) 닫힘 상태를 푼다. _result는 확정될 때마다 새 배열이다
    if (result !== this._lastResult) {
      this._lastResult = result;
      this._resultPopupClosed = false;
    }
    this._resultCloseRect = null;
    if (!result) return;
    // 1명이면 기존 하단 Winner 표시, 여러명이면 화면 중앙 당첨자 목록 팝업
    if (result.length === 1) {
      this.renderWinner(result[0], params.theme);
    } else if (!this._resultPopupClosed) {
      this.renderWinnerList(result, params);
    }
  }

  /** 결과 팝업 닫기 버튼을 눌렀는지 */
  getResultCloseHitAt(x: number, y: number): boolean {
    return inRect(this._resultCloseRect ?? undefined, x, y);
  }

  closeResultPopup(): void {
    this._resultPopupClosed = true;
  }

  /**
   * 여러명 모드에서 확정된 당첨자를 좌측 상단에 상시 표시한다.
   * 우측은 랭킹 리스트가 구슬 수만큼 내려오므로 겹친다. 좌측은 미니맵이 세로로 긴
   * 스트립이라 그 오른쪽에 붙인다.
   */
  private renderWinnerProgress({ winners, winnerRange, result, theme }: RenderParameters) {
    const { start, end } = winnerRange;
    if (end <= start) return; // 1명 추첨은 기존 하단 Winner 표시를 쓴다

    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    const lineHeight = Math.min(24, Math.max(14, h * 0.042));
    const pad = lineHeight * 0.6;
    const rankWidth = lineHeight * 1.9;
    const headerFont = `bold ${lineHeight * 0.7}px sans-serif`;
    const rankFont = `${lineHeight * 0.6}px sans-serif`;
    const nameFont = `bold ${lineHeight * 0.72}px sans-serif`;

    // 확정 전에는 골인한 당첨자만, 확정 후에는 최종 명단(조기 확정분 포함)을 쓴다
    const confirmed = result ?? winners.slice(start, end + 1);
    const header = `Winners ${confirmed.length} / ${end - start + 1}`;

    // 화면을 넘기면 오래된 쪽을 접는다. 전체 명단은 어차피 중앙 팝업에서 보여준다
    const maxRows = Math.max(1, Math.floor((h * 0.55) / lineHeight) - 2);
    const hidden = Math.max(0, confirmed.length - maxRows);
    const shown = confirmed.slice(hidden);
    const foldLabel = `+${hidden} more`;

    ctx.save();

    ctx.font = headerFont;
    let contentW = ctx.measureText(header).width;
    ctx.font = nameFont;
    for (const marble of shown) {
      contentW = Math.max(contentW, rankWidth + ctx.measureText(marble.name).width);
    }
    if (hidden > 0) {
      ctx.font = rankFont;
      contentW = Math.max(contentW, ctx.measureText(foldLabel).width);
    }

    const panelW = Math.min(contentW + pad * 2, w * PROGRESS_MAX_WIDTH_RATIO);
    const rows = shown.length + (hidden > 0 ? 1 : 0);
    // 헤더와 목록 사이 간격은 목록이 있을 때만 준다. 항상 주면 당첨자가 없을 때
    // 아래쪽에만 빈 공간이 남아 위아래 여백이 어긋난다
    const headerGap = rows > 0 ? lineHeight * 0.35 : 0;
    const panelH = pad * 2 + lineHeight + headerGap + rows * lineHeight;
    const panelX = MINIMAP_INSET + MINIMAP_WIDTH + pad;
    const panelY = MINIMAP_INSET; // 미니맵 상단과 맞춘다

    ctx.fillStyle = theme.winnerBackground;
    ctx.fillRect(panelX, panelY, panelW, panelH);
    ctx.strokeStyle = PROGRESS_ACCENT;
    ctx.lineWidth = 2;
    ctx.strokeRect(panelX, panelY, panelW, panelH);

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = headerFont;
    ctx.fillStyle = theme.winnerText;
    ctx.fillText(header, panelX + pad, panelY + pad + lineHeight / 2);

    let y = panelY + pad + lineHeight + headerGap + lineHeight / 2;
    if (hidden > 0) {
      ctx.font = rankFont;
      ctx.fillStyle = theme.winnerText;
      ctx.fillText(foldLabel, panelX + pad, y);
      y += lineHeight;
    }

    shown.forEach((marble, i) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(panelX, y - lineHeight / 2, panelW, lineHeight);
      ctx.clip();

      ctx.font = rankFont;
      ctx.fillStyle = theme.winnerText;
      ctx.fillText(`#${start + hidden + i + 1}`, panelX + pad, y);

      ctx.font = nameFont;
      ctx.fillStyle = `hsl(${marble.hue} 100% ${theme.marbleLightness}%)`;
      ctx.fillText(marble.name, panelX + pad + rankWidth, y);
      ctx.restore();
      y += lineHeight;
    });

    ctx.restore();
  }

  /** 당첨자가 여러명일 때 화면 중앙에 목록 팝업을 그린다 */
  private renderWinnerList(winners: readonly MarblePresentationState[], { theme, winnerRange }: RenderParameters) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    const lineHeight = Math.min(32, Math.max(16, h * 0.05));
    const padding = lineHeight;
    const titleHeight = lineHeight * 2;

    // 세로로 다 안 들어가면 열을 늘린다
    const maxRows = Math.max(
      1,
      Math.floor((h * RESULT_PANEL_MAX_HEIGHT_RATIO - titleHeight - padding * 2) / lineHeight)
    );
    const cols = Math.max(1, Math.ceil(winners.length / maxRows));
    const rows = Math.ceil(winners.length / cols);

    const colWidth = Math.min(RESULT_COLUMN_MAX_WIDTH, (w * RESULT_PANEL_MAX_WIDTH_RATIO - padding * 2) / cols);
    const panelW = colWidth * cols + padding * 2;
    const panelH = titleHeight + rows * lineHeight + padding;
    const panelX = (w - panelW) / 2;
    const panelY = (h - panelH) / 2;

    ctx.save();

    ctx.fillStyle = theme.winnerBackground;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = theme.background;
    ctx.fillRect(panelX, panelY, panelW, panelH);
    ctx.strokeStyle = theme.winnerText;
    ctx.lineWidth = 2;
    ctx.strokeRect(panelX, panelY, panelW, panelH);

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = theme.winnerText;
    ctx.font = `bold ${lineHeight * 1.1}px sans-serif`;
    ctx.fillText(`Winners (${winners.length})`, w / 2, panelY + titleHeight / 2);

    // 버튼 중심을 팝업 우상단 꼭지점에 맞춰 걸쳐놓는다. 뒤가 비치지 않게 불투명하게 채우되,
    // 검정으로 채우면 다크 테마에서 배경과 같아져 버튼으로 안 보이므로 대비되는 색을 쓴다
    this._resultCloseRect = drawResultCloseCircle(ctx, panelX + panelW, panelY, resultCloseButtonSize(h), '#222');

    const rankWidth = lineHeight * 1.8;
    winners.forEach((marble, i) => {
      const col = Math.floor(i / rows);
      const row = i % rows;
      const x = panelX + padding + col * colWidth;
      const y = panelY + titleHeight + row * lineHeight + lineHeight / 2;

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y - lineHeight / 2, colWidth, lineHeight);
      ctx.clip();

      ctx.textAlign = 'right';
      ctx.fillStyle = theme.winnerText;
      ctx.font = `${lineHeight * 0.6}px sans-serif`;
      ctx.fillText(`#${winnerRange.start + i + 1}`, x + rankWidth * 0.8, y);

      ctx.textAlign = 'left';
      ctx.fillStyle = `hsl(${marble.hue} 100% ${theme.marbleLightness}%)`;
      ctx.font = `bold ${lineHeight * 0.75}px sans-serif`;
      ctx.fillText(marble.name, x + rankWidth, y);
      ctx.restore();
    });

    ctx.restore();
  }

  private renderWinner(winner: MarblePresentationState, theme: ColorTheme) {
    const w = this.width;
    const h = this.height;

    this.ctx.save();
    this.ctx.fillStyle = theme.winnerBackground;
    this.ctx.fillRect(w / 2, h - winnerAreaHeight, w / 2, winnerAreaHeight);

    // Draw marble image or colored circle
    const marbleSize = 100;
    const marbleCenterX = w - marbleSize / 2 - 20;
    const marbleCenterY = h - winnerAreaHeight / 2;
    const marbleImage = this.getMarbleImage(winner.name);

    if (marbleImage) {
      this.ctx.drawImage(
        marbleImage,
        marbleCenterX - marbleSize / 2,
        marbleCenterY - marbleSize / 2,
        marbleSize,
        marbleSize
      );
    } else {
      this.ctx.beginPath();
      this.ctx.arc(marbleCenterX, marbleCenterY, marbleSize / 2, 0, Math.PI * 2);
      this.ctx.fillStyle = `hsl(${winner.hue} 100% ${theme.marbleLightness}%)`;
      this.ctx.fill();
    }

    this.ctx.fillStyle = theme.winnerText;
    this.ctx.strokeStyle = theme.winnerOutline;

    this.ctx.font = 'bold 48px sans-serif';
    this.ctx.textAlign = 'right';
    this.ctx.lineWidth = 4;
    const textRightX = marbleCenterX - marbleSize / 2 - 20;
    if (theme.winnerOutline) {
      this.ctx.strokeText('Winner', textRightX, h - 120 + WINNER_TEXT_OFFSET);
    }

    this.ctx.fillText('Winner', textRightX, h - 120 + WINNER_TEXT_OFFSET);
    this.ctx.font = 'bold 72px sans-serif';
    this.ctx.fillStyle = `hsl(${winner.hue} 100% ${theme.marbleLightness}%)`;
    if (theme.winnerOutline) {
      this.ctx.strokeText(winner.name, textRightX, h - 55 + WINNER_TEXT_OFFSET);
    }
    this.ctx.fillText(winner.name, textRightX, h - 55 + WINNER_TEXT_OFFSET);
    this.ctx.restore();
  }
}
