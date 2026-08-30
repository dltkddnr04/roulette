import './localization';
import options, { type RenderScale } from './options';
import { Roulette } from './roulette';

function readRenderScale(): RenderScale {
  try {
    switch (window.localStorage.getItem('mbr_render_scale')) {
      case '0.5':
        return 0.5;
      case '1':
        return 1;
      default:
        return 0.5;
    }
  } catch {
    return 0.5;
  }
}

options.renderScale = readRenderScale();

const roulette = new Roulette();

(window as any).roulette = roulette;
(window as any).options = options;
