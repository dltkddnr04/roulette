import { initializeLocale, translateElement } from './localization';
import options, { isRenderScale, type RenderScale } from './options';
import { Roulette } from './roulette';
import { getParticipantNames, normalizeParticipantNames } from './utils/participants';
import { readLocalStorage, writeLocalStorage } from './utils/storage';

const NAMES_STORAGE_KEY = 'mbr_names';
const RENDER_SCALE_STORAGE_KEY = 'mbr_render_scale';

type WinnerType = 'first' | 'last' | 'multi' | 'custom';
type EditedRange = 'start' | 'end';

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

// Keep the documented manual-control API while keeping application code module-scoped.
window.roulette = roulette;

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Required element not found: ${selector}`);
  return element;
}

function simpleToast(message: string): void {
  const toast = document.createElement('div');
  toast.classList.add('toast');
  toast.textContent = message;
  translateElement(toast);
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 1200);
}

function waitForRouletteInitialization(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (roulette.isReady) {
        resolve();
        return;
      }
      window.setTimeout(check, 100);
    };
    check();
  });
}

function applyTheme(darkMode: boolean): void {
  roulette.setTheme(darkMode ? 'dark' : 'light');
  document.documentElement.classList.toggle('light', !darkMode);
}

async function initializeApplication(): Promise<void> {
  await waitForRouletteInitialization();

  const namesInput = query<HTMLTextAreaElement>('#in_names');
  const settings = query<HTMLDivElement>('#settings');
  const startButton = query<HTMLButtonElement>('#btnStart');
  const shuffleButton = query<HTMLButtonElement>('#btnShuffle');
  const renderScaleSelector = query<HTMLSelectElement>('#sltRenderScale');
  const autoRecordingToggle = query<HTMLInputElement>('#chkAutoRecording');
  const skillToggle = query<HTMLInputElement>('#chkSkill');
  const darkModeToggle = query<HTMLInputElement>('#chkDarkMode');
  const rankInput = query<HTMLInputElement>('#in_winningRank');
  const rangeStartInput = query<HTMLInputElement>('#in_rangeStart');
  const rangeEndInput = query<HTMLInputElement>('#in_rangeEnd');
  const firstWinnerButton = query<HTMLButtonElement>('.btn-first-winner');
  const lastWinnerButton = query<HTMLButtonElement>('.btn-last-winner');
  const multiWinnerButton = query<HTMLButtonElement>('.btn-multi-winner');
  const rangeRow = query<HTMLDivElement>('.row-range');
  const toggleButton = query<HTMLButtonElement>('#btnToggleSettings');
  const collapsibleRows = query<HTMLDivElement>('.collapsible-rows');
  const mapSelector = query<HTMLSelectElement>('#sltMap');
  const sponsorUpload = query<HTMLInputElement>('#inSponsorFiles');
  const sponsorSelector = query<HTMLSelectElement>('#sltSponsor');
  const sponsorEnabled = query<HTMLInputElement>('#chkSponsorsEnabled');
  const sponsorDelete = query<HTMLButtonElement>('#btnDeleteSponsor');

  let winnerType: WinnerType = 'first';

  function applyWinnerSetting(edited?: EditedRange): void {
    let start: number;
    let end: number;
    switch (winnerType) {
      case 'first':
        start = end = 1;
        break;
      case 'last':
        start = end = roulette.getCount();
        break;
      case 'multi':
        start = Number.parseInt(rangeStartInput.value, 10) || 1;
        end = Number.parseInt(rangeEndInput.value, 10) || 1;
        if (end < start) {
          if (edited === 'end') start = end;
          else end = start;
        }
        break;
      case 'custom':
        start = end = Number.parseInt(rankInput.value, 10) || 1;
        break;
    }

    roulette.setWinnerRange(start - 1, end - 1);
    const clipped = roulette.getWinnerRange();
    if (winnerType === 'multi') {
      rangeStartInput.value = String(clipped.start + 1);
      rangeEndInput.value = String(clipped.end + 1);
    } else {
      rankInput.value = String(clipped.start + 1);
    }

    firstWinnerButton.classList.toggle('active', winnerType === 'first');
    lastWinnerButton.classList.toggle('active', winnerType === 'last');
    multiWinnerButton.classList.toggle('active', winnerType === 'multi');
    rankInput.classList.toggle('active', winnerType === 'custom');
    rangeRow.classList.toggle('active', winnerType === 'multi');
  }

  function getReady(): void {
    const names = getParticipantNames(namesInput.value);
    roulette.setMarbles(names);
    writeLocalStorage(NAMES_STORAGE_KEY, names.join(','));
    applyWinnerSetting();
  }

  function selectWinnerType(type: WinnerType, edited?: EditedRange): void {
    winnerType = type;
    applyWinnerSetting(edited);
  }

  async function refreshSponsorControls(): Promise<void> {
    try {
      const state = await roulette.getSponsorState();
      sponsorSelector.replaceChildren();

      const noSponsor = document.createElement('option');
      noSponsor.value = '';
      noSponsor.textContent = 'No sponsor selected';
      sponsorSelector.append(noSponsor);

      state.assets.forEach((asset) => {
        const option = document.createElement('option');
        option.value = asset.id;
        option.textContent = asset.name;
        sponsorSelector.append(option);
      });

      sponsorSelector.value = state.selectedAssetId ?? '';
      sponsorEnabled.checked = state.enabled;
      sponsorDelete.disabled = !state.selectedAssetId;
    } catch (error) {
      console.warn('Sponsor controls unavailable', error);
    }
  }

  renderScaleSelector.value = String(options.renderScale);
  autoRecordingToggle.checked = false;
  skillToggle.checked = options.useSkills;
  applyTheme(darkModeToggle.checked);
  roulette.setAutoRecording(autoRecordingToggle.checked);

  const namesFromUrl = new URLSearchParams(window.location.search).get('names');
  const savedNames = readLocalStorage(NAMES_STORAGE_KEY);
  if (namesFromUrl) namesInput.value = namesFromUrl.replace(/,/g, '\n');
  else if (savedNames) namesInput.value = savedNames;

  namesInput.addEventListener('input', getReady);
  namesInput.addEventListener('blur', () => {
    const normalized = normalizeParticipantNames(getParticipantNames(namesInput.value));
    if (namesInput.value !== normalized.join(',')) {
      namesInput.value = normalized.join(',');
      getReady();
    }
  });

  shuffleButton.addEventListener('click', getReady);
  startButton.addEventListener('click', () => {
    if (roulette.roundState !== 'ready' || roulette.getCount() === 0) return;
    settings.classList.add('hide');
    roulette.start();
  });

  autoRecordingToggle.addEventListener('change', () => {
    roulette.setAutoRecording(autoRecordingToggle.checked);
  });
  skillToggle.addEventListener('change', () => {
    options.useSkills = skillToggle.checked;
  });
  darkModeToggle.addEventListener('change', () => applyTheme(darkModeToggle.checked));
  renderScaleSelector.addEventListener('change', () => {
    const value = Number(renderScaleSelector.value);
    if (!isRenderScale(value)) return;
    writeLocalStorage(RENDER_SCALE_STORAGE_KEY, String(value));
    roulette.setRenderScale(value);
  });

  sponsorUpload.addEventListener('change', async () => {
    const files = sponsorUpload.files ? Array.from(sponsorUpload.files) : [];
    sponsorUpload.value = '';
    for (const file of files) {
      try {
        await roulette.addSponsorAsset(file);
      } catch (error) {
        console.warn('Sponsor upload failed', error);
        simpleToast('Unable to save sponsor image');
      }
    }
    await refreshSponsorControls();
  });
  sponsorSelector.addEventListener('change', async () => {
    try {
      await roulette.selectSponsorAsset(sponsorSelector.value || null);
      await refreshSponsorControls();
    } catch (error) {
      console.warn('Sponsor selection failed', error);
    }
  });
  sponsorEnabled.addEventListener('change', async () => {
    try {
      await roulette.setSponsorsEnabled(sponsorEnabled.checked);
    } catch (error) {
      console.warn('Sponsor setting failed', error);
      await refreshSponsorControls();
    }
  });
  sponsorDelete.addEventListener('click', async () => {
    const assetId = sponsorSelector.value;
    if (!assetId) return;
    try {
      await roulette.deleteSponsorAsset(assetId);
      await refreshSponsorControls();
    } catch (error) {
      console.warn('Sponsor deletion failed', error);
    }
  });

  rankInput.addEventListener('change', () => selectWinnerType('custom'));
  lastWinnerButton.addEventListener('click', () => selectWinnerType('last'));
  firstWinnerButton.addEventListener('click', () => selectWinnerType('first'));
  multiWinnerButton.addEventListener('click', () => selectWinnerType('multi'));
  rangeStartInput.addEventListener('change', () => selectWinnerType('multi', 'start'));
  rangeEndInput.addEventListener('change', () => selectWinnerType('multi', 'end'));

  roulette.addEventListener('goal', () => {
    window.setTimeout(() => settings.classList.remove('hide'), 3000);
  });
  roulette.addEventListener('message', (event) => {
    simpleToast((event as CustomEvent<string>).detail);
  });

  toggleButton.addEventListener('click', () => {
    collapsibleRows.classList.toggle('collapsed');
    query<HTMLElement>('.toggle-arrow').textContent = collapsibleRows.classList.contains('collapsed') ? '▲' : '▼';
  });

  roulette.getMaps().forEach((map) => {
    const option = document.createElement('option');
    option.value = String(map.index);
    option.textContent = map.title;
    option.setAttribute('data-trans', '');
    translateElement(option);
    mapSelector.append(option);
  });
  mapSelector.addEventListener('change', () => {
    const index = Number(mapSelector.value);
    if (Number.isSafeInteger(index)) roulette.setMap(index);
  });

  await refreshSponsorControls();
  shuffleButton.click();
}

document.addEventListener('DOMContentLoaded', () => {
  initializeLocale();
  void initializeApplication();
});
