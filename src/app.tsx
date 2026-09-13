import type { ChangeEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ParticipantInput } from './components/settings/ParticipantInput';
import { SettingsPanel } from './components/settings/SettingsPanel';
import type { EditedRange, WinnerType } from './components/settings/WinnerSettings';
import type { FairnessState } from './fairness';
import { translateElement, translateTree } from './localization';
import type { WinnerRange } from './options';
import type { Roulette } from './roulette';
import type { SponsorState } from './sponsorStore';
import { getParticipantNames, normalizeParticipantNames } from './utils/participants';
import { readLocalStorage, writeLocalStorage } from './utils/storage';

const NAMES_STORAGE_KEY = 'mbr_names';
const RENDER_SCALE_STORAGE_KEY = 'mbr_render_scale';
const DEFAULT_NAMES = '수박*2,키위*2,귤*2';

function useRouletteReady(roulette: Roulette): boolean {
  const [ready, setReady] = useState(roulette.isReady);

  useEffect(() => {
    if (roulette.isReady) {
      setReady(true);
      return;
    }

    let timer: number | undefined;
    const check = () => {
      if (roulette.isReady) {
        setReady(true);
        return;
      }
      timer = window.setTimeout(check, 100);
    };
    check();

    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [roulette]);

  return ready;
}

function initialNames(): string {
  const namesFromUrl = new URLSearchParams(window.location.search).get('names');
  const savedNames = readLocalStorage(NAMES_STORAGE_KEY);
  if (namesFromUrl) return namesFromUrl.replace(/,/g, '\n');
  return savedNames ?? DEFAULT_NAMES;
}

function Toast({ message }: { message: string }) {
  const toastRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (toastRef.current) translateElement(toastRef.current);
  }, []);
  return (
    <div ref={toastRef} className="toast">
      {message}
    </div>
  );
}

export function App({ roulette }: { roulette: Roulette }) {
  const ready = useRouletteReady(roulette);
  const rootRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const [names, setNames] = useState(initialNames);
  const [settingsHidden, setSettingsHidden] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [winnerType, setWinnerType] = useState<WinnerType>('first');
  const [rank, setRank] = useState('1');
  const [rangeStart, setRangeStart] = useState('1');
  const [rangeEnd, setRangeEnd] = useState('3');
  const [mapIndex, setMapIndex] = useState(0);
  const [renderScale, setRenderScale] = useState(roulette.getRenderScale());
  const [autoRecording, setAutoRecording] = useState(roulette.getAutoRecording());
  const [useSkills, setUseSkills] = useState(roulette.getSkillsEnabled());
  const [darkMode, setDarkMode] = useState(roulette.getTheme() === 'dark');
  const [sponsorState, setSponsorState] = useState<SponsorState | null>(null);
  const [fairnessState, setFairnessState] = useState<FairnessState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [toastId, setToastId] = useState(0);
  const toastTimer = useRef<number | null>(null);
  const settingsTimer = useRef<number | null>(null);

  useEffect(() => {
    if (rootRef.current) translateTree(rootRef.current);
  });

  const showToast = useCallback((message: string) => {
    setToast(message);
    setToastId((id) => id + 1);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      toastTimer.current = null;
      setToast(null);
    }, 1200);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  const refreshSponsors = useCallback(async () => {
    try {
      setSponsorState(await roulette.getSponsorState());
    } catch (error) {
      console.warn('Sponsor controls unavailable', error);
    }
  }, [roulette]);

  const refreshFairness = useCallback(async () => {
    try {
      setFairnessState(await roulette.getFairnessState());
    } catch (error) {
      console.warn('Fairness controls unavailable', error);
    }
  }, [roulette]);

  const applyWinnerSetting = useCallback(
    (nextType: WinnerType = winnerType, edited?: EditedRange) => {
      let start: number;
      let end: number;
      switch (nextType) {
        case 'first':
          start = end = 1;
          break;
        case 'last':
          start = end = roulette.getCount();
          break;
        case 'multi':
          start = Number.parseInt(rangeStart, 10) || 1;
          end = Number.parseInt(rangeEnd, 10) || 1;
          if (end < start) {
            if (edited === 'end') start = end;
            else end = start;
          }
          break;
        case 'custom':
          start = end = Number.parseInt(rank, 10) || 1;
          break;
      }

      if (!roulette.setWinnerRange(start - 1, end - 1)) {
        const currentRange = roulette.getWinnerRange();
        setWinnerType('custom');
        setRank(String(currentRange.start + 1));
        return;
      }
      const clipped: WinnerRange = roulette.getWinnerRange();
      if (nextType === 'multi') {
        setRangeStart(String(clipped.start + 1));
        setRangeEnd(String(clipped.end + 1));
      } else {
        setRank(String(clipped.start + 1));
      }
    },
    [rangeEnd, rangeStart, rank, roulette, winnerType]
  );

  const getReady = useCallback(
    (value: string) => {
      const participantNames = getParticipantNames(value);
      roulette.setMarbles(participantNames);
      writeLocalStorage(NAMES_STORAGE_KEY, participantNames.join(','));
      applyWinnerSetting();
      void refreshFairness();
    },
    [applyWinnerSetting, refreshFairness, roulette]
  );

  useEffect(() => {
    if (!ready || initializedRef.current) return;
    initializedRef.current = true;

    const value = initialNames();
    setNames(value);
    roulette.setAutoRecording(false);
    roulette.setTheme('dark');
    const participantNames = getParticipantNames(value);
    roulette.setMarbles(participantNames);
    writeLocalStorage(NAMES_STORAGE_KEY, participantNames.join(','));
    roulette.setWinnerRange(0, 0);
    void refreshSponsors();
    void refreshFairness();
  }, [ready, refreshFairness, refreshSponsors, roulette]);

  useEffect(() => {
    const onGoal = () => {
      if (settingsTimer.current !== null) window.clearTimeout(settingsTimer.current);
      settingsTimer.current = window.setTimeout(() => {
        settingsTimer.current = null;
        setSettingsHidden(false);
      }, 3000);
      void refreshFairness();
    };
    const onMessage = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      if (typeof message === 'string') showToast(message);
      if (roulette.roundState === 'ready') setSettingsHidden(false);
    };
    roulette.addEventListener('goal', onGoal);
    roulette.addEventListener('message', onMessage);
    roulette.addEventListener('fairness', refreshFairness);
    return () => {
      roulette.removeEventListener('goal', onGoal);
      roulette.removeEventListener('message', onMessage);
      roulette.removeEventListener('fairness', refreshFairness);
      if (settingsTimer.current !== null) {
        window.clearTimeout(settingsTimer.current);
        settingsTimer.current = null;
      }
    };
  }, [refreshFairness, roulette, showToast]);

  const handleWinnerType = (type: WinnerType) => {
    setWinnerType(type);
    applyWinnerSetting(type);
  };

  const handleRangeChange = (field: EditedRange, value: string) => {
    if (field === 'start') setRangeStart(value);
    else setRangeEnd(value);
  };

  const handleRangeBlur = (field: EditedRange) => {
    if (winnerType === 'multi') applyWinnerSetting('multi', field);
  };

  const handleSponsorUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
    event.currentTarget.value = '';
    for (const file of files) {
      try {
        await roulette.addSponsorAsset(file);
      } catch (error) {
        console.warn('Sponsor upload failed', error);
        showToast('Unable to save sponsor image');
      }
    }
    await refreshSponsors();
  };

  const handleSponsorSelect = async (assetId: string | null) => {
    try {
      await roulette.selectSponsorAsset(assetId);
      await refreshSponsors();
    } catch (error) {
      console.warn('Sponsor selection failed', error);
    }
  };

  const handleSponsorEnabled = async (enabled: boolean) => {
    try {
      await roulette.setSponsorsEnabled(enabled);
      await refreshSponsors();
    } catch (error) {
      console.warn('Sponsor setting failed', error);
      await refreshSponsors();
    }
  };

  const handleSponsorDelete = async () => {
    const assetId = sponsorState?.selectedAssetId;
    if (!assetId) return;
    try {
      await roulette.deleteSponsorAsset(assetId);
      await refreshSponsors();
    } catch (error) {
      console.warn('Sponsor deletion failed', error);
    }
  };

  const handleFairnessEnabled = async (enabled: boolean) => {
    try {
      await roulette.setFairnessEnabled(enabled);
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Fairness is unavailable');
      await refreshFairness();
    }
  };

  const handleFairnessMode = async (mode: FairnessState['mode']) => {
    try {
      await roulette.setFairnessMode(mode);
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Fairness mode could not be changed');
    }
  };

  const handleFairnessRename = async (participantId: string, currentName: string) => {
    const nextName = window.prompt('Rename fairness participant', currentName);
    if (nextName === null) return;
    try {
      await roulette.renameFairParticipant(participantId, nextName);
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Participant could not be renamed');
    }
  };

  const handleFairnessExcluded = async (participantId: string, excluded: boolean) => {
    try {
      await roulette.setFairnessParticipantExcluded(participantId, excluded);
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Participant exclusion could not be changed');
      await refreshFairness();
    }
  };

  const handleFairnessNewEpoch = async () => {
    try {
      await roulette.startNewFairnessEpoch();
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Fairness epoch could not be started');
    }
  };

  const handleFairnessVoid = async (drawId: string) => {
    if (!window.confirm('Void this fairness draw?')) return;
    try {
      await roulette.voidFairnessDraw(drawId);
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Fairness draw could not be voided');
    }
  };

  const handleFairnessExport = async () => {
    try {
      const data = await roulette.exportFairnessData();
      const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = 'marble-roulette-fairness.json';
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Fairness data could not be exported');
    }
  };

  const handleFairnessImport = async (value: string) => {
    if (!window.confirm('Replace fairness history with this import?')) return;
    try {
      await roulette.importFairnessData(value);
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Fairness data could not be imported');
    }
  };

  const handleFairnessDelete = async () => {
    if (!window.confirm('Delete all fairness history?')) return;
    try {
      await roulette.deleteFairnessData();
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Fairness history could not be deleted');
    }
  };

  const maps = roulette.getMaps();
  const onStart = () => {
    if (!ready || roulette.roundState !== 'ready' || roulette.getCount() === 0) return;
    setSettingsHidden(true);
    void Promise.resolve(roulette.start()).catch((error) => {
      showToast(error instanceof Error ? error.message : 'The roulette could not start');
    });
  };

  return (
    <div ref={rootRef}>
      <h1 className="sr-only">Marble Roulette - 랜덤 추첨기</h1>
      <div id="settings" className={`settings${settingsHidden ? ' hide' : ''}`}>
        <SettingsPanel
          collapsed={collapsed}
          onToggle={() => setCollapsed((value) => !value)}
          generalSettings={{
            maps,
            mapIndex,
            onMapChange: (index) => {
              if (!ready || !Number.isSafeInteger(index)) return;
              roulette.setMap(index);
              setMapIndex(index);
            },
            renderScale,
            onRenderScaleChange: (value) => {
              writeLocalStorage(RENDER_SCALE_STORAGE_KEY, String(value));
              roulette.setRenderScale(value);
              setRenderScale(value);
            },
            autoRecording,
            onAutoRecordingChange: (value) => {
              roulette.setAutoRecording(value);
              setAutoRecording(value);
            },
            useSkills,
            onSkillsChange: (value) => {
              roulette.setSkillsEnabled(value);
              setUseSkills(value);
            },
            darkMode,
            onDarkModeChange: (value) => {
              roulette.setTheme(value ? 'dark' : 'light');
              document.documentElement.classList.toggle('light', !value);
              setDarkMode(value);
            },
            winnerSettings: {
              winnerType,
              rank,
              rangeStart,
              rangeEnd,
              onSelect: handleWinnerType,
              onRankChange: (value) => {
                setRank(value);
                setWinnerType('custom');
              },
              onRangeChange: handleRangeChange,
              onRangeBlur: handleRangeBlur,
            },
          }}
          brandingSettings={{
            state: sponsorState,
            onUpload: handleSponsorUpload,
            onSelect: handleSponsorSelect,
            onEnabled: handleSponsorEnabled,
            onDelete: handleSponsorDelete,
          }}
          fairnessSettings={{
            state: fairnessState,
            onEnabled: (value) => void handleFairnessEnabled(value),
            onModeChange: (value) => void handleFairnessMode(value),
            onRename: (participantId, currentName) => void handleFairnessRename(participantId, currentName),
            onExcluded: (participantId, excluded) => void handleFairnessExcluded(participantId, excluded),
            onNewEpoch: () => void handleFairnessNewEpoch(),
            onVoid: (drawId) => void handleFairnessVoid(drawId),
            onExport: () => void handleFairnessExport(),
            onImport: (value) => void handleFairnessImport(value),
            onDelete: () => void handleFairnessDelete(),
          }}
        />
        <ParticipantInput
          value={names}
          onChange={(value) => {
            setNames(value);
            if (ready && !roulette.getFairnessEnabled()) getReady(value);
          }}
          onBlur={() => {
            const normalized = normalizeParticipantNames(getParticipantNames(names));
            if (names !== normalized.join(',')) {
              setNames(normalized.join(','));
              if (ready) getReady(normalized.join(','));
            } else if (ready && roulette.getFairnessEnabled()) {
              getReady(names);
            }
          }}
          onShuffle={() => {
            if (ready) getReady(names);
          }}
          onStart={onStart}
        />
      </div>
      <div className="copyright">
        <span className="copyright-owner">
          &copy; 2026 <a href="https://github.com/dltkddnr04">dltkddnr04</a>
        </span>
        <span className="copyright-attribution">
          {' / Based on '}
          <a href="https://lazygyu.github.io/roulette">Marble Roulette</a> by{' '}
          <a href="https://github.com/lazygyu">LazyGyu</a>
        </span>
      </div>
      {toast ? <Toast key={`${toastId}-${toast}`} message={toast} /> : null}
    </div>
  );
}
