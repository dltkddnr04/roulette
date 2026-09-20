import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ParticipantStartPage } from './components/ParticipantStartPage';
import { initializeLocale } from './localization';
import { isRenderScale, type RenderScale } from './options';
import {
  createRoomJoinUrl,
  createRoomPlaybackUrl,
  getRoomCodeFromLocation,
  getStoredGuestSession,
} from './sharedRoomClient';
import { readLocalStorage } from './utils/storage';
import type { Roulette } from './roulette';

const RENDER_SCALE_STORAGE_KEY = 'mbr_render_scale';

declare global {
  interface Window {
    /** Public console/manual-control compatibility for the application instance. */
    roulette?: Roulette;
  }
}

function readRenderScale(): RenderScale {
  const value = Number(readLocalStorage(RENDER_SCALE_STORAGE_KEY));
  return isRenderScale(value) ? value : 0.5;
}

function isParticipantJoinRoute(): boolean {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  return pathname === '/join';
}

async function bootstrapRoulette(root: HTMLElement): Promise<void> {
  const [{ App }, { Roulette }] = await Promise.all([import('./app'), import('./roulette')]);
  const roulette = new Roulette(readRenderScale());
  window.roulette = roulette;
  createRoot(root).render(createElement(App, { roulette }));
}

document.addEventListener('DOMContentLoaded', () => {
  initializeLocale();
  const root = document.getElementById('root');
  if (!root) throw new Error('Application root not found');

  const roomCode = getRoomCodeFromLocation();
  if (isParticipantJoinRoute()) {
    if (roomCode && getStoredGuestSession(roomCode)) {
      window.location.replace(createRoomPlaybackUrl(roomCode));
      return;
    }
    createRoot(root).render(createElement(ParticipantStartPage));
    return;
  }

  if (roomCode && !getStoredGuestSession(roomCode)) {
    window.location.replace(createRoomJoinUrl(roomCode));
    return;
  }

  void bootstrapRoulette(root);
});
