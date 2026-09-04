import type { ChangeEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { translateElement, translateTree } from './localization';
import { isRenderScale, type RenderScale, type WinnerRange } from './options';
import type { Roulette } from './roulette';
import type { SponsorState } from './sponsorStore';
import { getParticipantNames, normalizeParticipantNames } from './utils/participants';
import { readLocalStorage, writeLocalStorage } from './utils/storage';

const NAMES_STORAGE_KEY = 'mbr_names';
const RENDER_SCALE_STORAGE_KEY = 'mbr_render_scale';
const DEFAULT_NAMES = '수박*2,키위*2,귤*2';

type WinnerType = 'first' | 'last' | 'multi' | 'custom';
type EditedRange = 'start' | 'end';

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

type ParticipantInputProps = {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  onShuffle: () => void;
  onStart: () => void;
};

function ParticipantInput({ value, onChange, onBlur, onShuffle, onStart }: ParticipantInputProps) {
  return (
    <div className="left">
      <h3 data-trans>Enter names below</h3>
      <textarea
        id="in_names"
        placeholder="Input names separated by commas or line feed here"
        data-trans="placeholder"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={onBlur}
      />
      <div className="actions">
        <div className="sep"></div>
        <button id="btnShuffle" type="button" onClick={onShuffle}>
          <i className="icon shuffle"></i>
          <span data-trans>Shuffle</span>
        </button>
        <button id="btnStart" type="button" onClick={onStart}>
          <i className="icon play"></i>
          <span data-trans>Start</span>
        </button>
      </div>
    </div>
  );
}

type WinnerSettingsProps = {
  winnerType: WinnerType;
  rank: string;
  rangeStart: string;
  rangeEnd: string;
  onSelect: (type: WinnerType) => void;
  onRankChange: (value: string) => void;
  onRangeChange: (field: EditedRange, value: string) => void;
  onRangeBlur: (field: EditedRange) => void;
};

function WinnerSettings({
  winnerType,
  rank,
  rangeStart,
  rangeEnd,
  onSelect,
  onRankChange,
  onRangeChange,
  onRangeBlur,
}: WinnerSettingsProps) {
  return (
    <>
      <div className="row">
        <label htmlFor="in_winningRank">
          <i className="icon trophy"></i>
          <span data-trans>The winner is</span>
        </label>
        <div className="btn-group">
          <button
            type="button"
            className={`btn-winner btn-first-winner${winnerType === 'first' ? ' active' : ''}`}
            data-trans
            onClick={() => onSelect('first')}
          >
            First
          </button>
          <button
            type="button"
            className={`btn-winner btn-last-winner${winnerType === 'last' ? ' active' : ''}`}
            data-trans
            onClick={() => onSelect('last')}
          >
            Last
          </button>
          <input
            type="number"
            id="in_winningRank"
            className={winnerType === 'custom' ? 'active' : ''}
            value={rank}
            min="1"
            onChange={(event) => onRankChange(event.currentTarget.value)}
            onBlur={() => onSelect('custom')}
          />
          <button
            type="button"
            className={`btn-winner btn-multi-winner${winnerType === 'multi' ? ' active' : ''}`}
            data-trans
            onClick={() => onSelect('multi')}
          >
            Multiple
          </button>
        </div>
      </div>
      <div className={`row row-range${winnerType === 'multi' ? ' active' : ''}`}>
        <label htmlFor="in_rangeStart">
          <span className="sr-only">Range start</span>
        </label>
        <div className="btn-group range-group">
          <input
            type="number"
            id="in_rangeStart"
            value={rangeStart}
            min="1"
            onChange={(event) => onRangeChange('start', event.currentTarget.value)}
            onBlur={() => onRangeBlur('start')}
          />
          <span className="range-sep">~</span>
          <input
            type="number"
            id="in_rangeEnd"
            value={rangeEnd}
            min="1"
            onChange={(event) => onRangeChange('end', event.currentTarget.value)}
            onBlur={() => onRangeBlur('end')}
          />
        </div>
      </div>
    </>
  );
}

type SponsorSettingsProps = {
  state: SponsorState | null;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onSelect: (assetId: string | null) => void;
  onEnabled: (enabled: boolean) => void;
  onDelete: () => void;
};

function SponsorSettings({ state, onUpload, onSelect, onEnabled, onDelete }: SponsorSettingsProps) {
  return (
    <div className="row row-sponsors">
      <label htmlFor="inSponsorFiles">
        <span>Branding &amp; Sponsors</span>
      </label>
      <div className="sponsor-controls">
        <input type="file" id="inSponsorFiles" accept="image/*" multiple onChange={onUpload} />
        <select
          id="sltSponsor"
          value={state?.selectedAssetId ?? ''}
          onChange={(event) => onSelect(event.currentTarget.value || null)}
        >
          <option value="">No sponsor selected</option>
          {state?.assets.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.name}
            </option>
          ))}
        </select>
        <div className="sponsor-actions">
          <label className="sponsor-enabled" htmlFor="chkSponsorsEnabled">
            <span>Enabled</span>
            <input
              type="checkbox"
              id="chkSponsorsEnabled"
              checked={state?.enabled ?? false}
              onChange={(event) => onEnabled(event.currentTarget.checked)}
            />
          </label>
          <button type="button" id="btnDeleteSponsor" disabled={!state?.selectedAssetId} onClick={onDelete}>
            Delete selected
          </button>
        </div>
      </div>
    </div>
  );
}

type SettingsPanelProps = {
  collapsed: boolean;
  onToggle: () => void;
  maps: ReturnType<Roulette['getMaps']>;
  mapIndex: number;
  onMapChange: (index: number) => void;
  renderScale: RenderScale;
  onRenderScaleChange: (value: RenderScale) => void;
  autoRecording: boolean;
  onAutoRecordingChange: (value: boolean) => void;
  useSkills: boolean;
  onSkillsChange: (value: boolean) => void;
  darkMode: boolean;
  onDarkModeChange: (value: boolean) => void;
  winnerSettings: WinnerSettingsProps;
  sponsorSettings: SponsorSettingsProps;
};

function SettingsPanel({
  collapsed,
  onToggle,
  maps,
  mapIndex,
  onMapChange,
  renderScale,
  onRenderScaleChange,
  autoRecording,
  onAutoRecordingChange,
  useSkills,
  onSkillsChange,
  darkMode,
  onDarkModeChange,
  winnerSettings,
  sponsorSettings,
}: SettingsPanelProps) {
  return (
    <div className="right">
      <button type="button" className="btn-toggle-settings" onClick={onToggle}>
        <span data-trans>Settings</span>
        <i className="toggle-arrow">{collapsed ? '▲' : '▼'}</i>
      </button>
      <div className={`collapsible-rows${collapsed ? ' collapsed' : ''}`}>
        <div className="row">
          <label htmlFor="sltMap">
            <i className="icon map"></i>
            <span data-trans>Map</span>
          </label>
          <select id="sltMap" value={mapIndex} onChange={(event) => onMapChange(Number(event.currentTarget.value))}>
            {maps.map((map) => (
              <option key={map.index} value={map.index} data-trans>
                {map.title}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label htmlFor="sltRenderScale">
            <span data-trans>Render quality</span>
          </label>
          <select
            id="sltRenderScale"
            value={renderScale}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (isRenderScale(value)) onRenderScaleChange(value);
            }}
          >
            <option value="0.5">Performance</option>
            <option value="1">Native</option>
          </select>
        </div>
        <SponsorSettings {...sponsorSettings} />
        <div className="row row-toggles">
          <div className="toggle-item">
            <label htmlFor="chkAutoRecording">
              <i className="icon record"></i>
              <span data-trans>Recording</span>
            </label>
            <input
              type="checkbox"
              id="chkAutoRecording"
              checked={autoRecording}
              onChange={(event) => onAutoRecordingChange(event.currentTarget.checked)}
            />
          </div>
          <div className="toggle-item">
            <label htmlFor="chkSkill">
              <i className="icon bomb"></i>
              <span data-trans>Using skills</span>
            </label>
            <input
              type="checkbox"
              id="chkSkill"
              checked={useSkills}
              onChange={(event) => onSkillsChange(event.currentTarget.checked)}
            />
          </div>
        </div>
        <WinnerSettings {...winnerSettings} />
        <div className="row row-theme">
          <div className="theme">
            <i className="icon sun"></i>
            <input
              type="checkbox"
              id="chkDarkMode"
              checked={darkMode}
              onChange={(event) => onDarkModeChange(event.currentTarget.checked)}
            />
            <i className="icon moon"></i>
          </div>
        </div>
      </div>
    </div>
  );
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

      roulette.setWinnerRange(start - 1, end - 1);
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
    },
    [applyWinnerSetting, roulette]
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
  }, [ready, refreshSponsors, roulette]);

  useEffect(() => {
    const onGoal = () => {
      if (settingsTimer.current !== null) window.clearTimeout(settingsTimer.current);
      settingsTimer.current = window.setTimeout(() => {
        settingsTimer.current = null;
        setSettingsHidden(false);
      }, 3000);
    };
    const onMessage = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      if (typeof message === 'string') showToast(message);
    };
    roulette.addEventListener('goal', onGoal);
    roulette.addEventListener('message', onMessage);
    return () => {
      roulette.removeEventListener('goal', onGoal);
      roulette.removeEventListener('message', onMessage);
      if (settingsTimer.current !== null) {
        window.clearTimeout(settingsTimer.current);
        settingsTimer.current = null;
      }
    };
  }, [roulette, showToast]);

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

  const maps = roulette.getMaps();
  const onStart = () => {
    if (!ready || roulette.roundState !== 'ready' || roulette.getCount() === 0) return;
    setSettingsHidden(true);
    roulette.start();
  };

  return (
    <div ref={rootRef}>
      <h1 className="sr-only">Marble Roulette - 랜덤 추첨기</h1>
      <div id="settings" className={`settings${settingsHidden ? ' hide' : ''}`}>
        <SettingsPanel
          collapsed={collapsed}
          onToggle={() => setCollapsed((value) => !value)}
          maps={maps}
          mapIndex={mapIndex}
          onMapChange={(index) => {
            if (!ready || !Number.isSafeInteger(index)) return;
            roulette.setMap(index);
            setMapIndex(index);
          }}
          renderScale={renderScale}
          onRenderScaleChange={(value) => {
            writeLocalStorage(RENDER_SCALE_STORAGE_KEY, String(value));
            roulette.setRenderScale(value);
            setRenderScale(value);
          }}
          autoRecording={autoRecording}
          onAutoRecordingChange={(value) => {
            roulette.setAutoRecording(value);
            setAutoRecording(value);
          }}
          useSkills={useSkills}
          onSkillsChange={(value) => {
            roulette.setSkillsEnabled(value);
            setUseSkills(value);
          }}
          darkMode={darkMode}
          onDarkModeChange={(value) => {
            roulette.setTheme(value ? 'dark' : 'light');
            document.documentElement.classList.toggle('light', !value);
            setDarkMode(value);
          }}
          winnerSettings={{
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
          }}
          sponsorSettings={{
            state: sponsorState,
            onUpload: handleSponsorUpload,
            onSelect: handleSponsorSelect,
            onEnabled: handleSponsorEnabled,
            onDelete: handleSponsorDelete,
          }}
        />
        <ParticipantInput
          value={names}
          onChange={(value) => {
            setNames(value);
            if (ready) getReady(value);
          }}
          onBlur={() => {
            const normalized = normalizeParticipantNames(getParticipantNames(names));
            if (names !== normalized.join(',')) {
              setNames(normalized.join(','));
              if (ready) getReady(normalized.join(','));
            }
          }}
          onShuffle={() => {
            if (ready) getReady(names);
          }}
          onStart={onStart}
        />
      </div>
      <div className="copyright">
        &copy; 2026 <a href="https://github.com/dltkddnr04">dltkddnr04</a> / Based on{' '}
        <a href="https://lazygyu.github.io/roulette">Marble Roulette</a> by{' '}
        <a href="https://github.com/lazygyu">LazyGyu</a>
      </div>
      {toast ? <Toast key={`${toastId}-${toast}`} message={toast} /> : null}
    </div>
  );
}
