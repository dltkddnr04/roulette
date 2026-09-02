import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { initializeLocale } from './localization';
import options, { isRenderScale, type RenderScale } from './options';
import { Roulette } from './roulette';
import { readLocalStorage } from './utils/storage';

const RENDER_SCALE_STORAGE_KEY = 'mbr_render_scale';

declare global {
  interface Window {
    /** Public console/manual-control compatibility for the application instance. */
    roulette: Roulette;
  }
}

function readRenderScale(): RenderScale {
  const value = Number(readLocalStorage(RENDER_SCALE_STORAGE_KEY));
  return isRenderScale(value) ? value : 0.5;
}

options.renderScale = readRenderScale();
const roulette = new Roulette();
window.roulette = roulette;

document.addEventListener('DOMContentLoaded', () => {
  initializeLocale();
  const root = document.getElementById('root');
  if (!root) throw new Error('Application root not found');
  createRoot(root).render(createElement(App, { roulette }));
});
