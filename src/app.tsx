import type { ChangeEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ParticipantInput } from './components/settings/ParticipantInput';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { SharedRoomPanel } from './components/SharedRoomPanel';
import type { EditedRange, WinnerType } from './components/settings/WinnerSettings';
import type { FairnessState } from './fairness';
import { translateElement, translateTree } from './localization';
import type { WinnerRange } from './options';
import type { Roulette } from './roulette';
import {
  getRoomCodeFromLocation,
  SharedRoomClient,
  type SharedRoomClientEvent,
  type SharedRoomConnectionStatus,
} from './sharedRoomClient';
import type { RoomSnapshot, ScheduledRound } from './sharedRoomProtocol';
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
  const initialRoomCode = getRoomCodeFromLocation();
  const [roomRouteActive, setRoomRouteActive] = useState(initialRoomCode !== null);
  const [sharedClient, setSharedClient] = useState<SharedRoomClient | null>(() =>
    initialRoomCode ? SharedRoomClient.forGuest(initialRoomCode) : SharedRoomClient.restoreHost()
  );
  const [sharedSnapshot, setSharedSnapshot] = useState<RoomSnapshot | null>(() =>
    sharedClient?.currentSnapshot ?? null
  );
  const [sharedConnectionStatus, setSharedConnectionStatus] = useState<SharedRoomConnectionStatus>(
    sharedClient?.status ?? 'idle'
  );
  const [sharedError, setSharedError] = useState<string | null>(null);
  const [sharedRound, setSharedRound] = useState<ScheduledRound | null>(null);
  const [sharedPreparedToken, setSharedPreparedToken] = useState<string | null>(null);
  const [sharedPreparing, setSharedPreparing] = useState(false);
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
  const localNamesBeforeSharedRoom = useRef<string[] | null>(null);
  const reportedSharedRounds = useRef(new Set<string>());
  const sharedPreparedTokenRef = useRef<string | null>(null);
  const sharedStartInFlightRef = useRef(false);
  const guestResultRef = useRef<{ roundId: string; winners: string[] } | null>(null);
  const guestMode = sharedClient?.role === 'guest' || roomRouteActive;
  const sharedControlsLocked =
    sharedPreparing || sharedRound?.status === 'scheduled' || sharedRound?.status === 'running';

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
    if (guestMode) return;
    try {
      setFairnessState(await roulette.getFairnessState());
    } catch (error) {
      console.warn('Fairness controls unavailable', error);
    }
  }, [guestMode, roulette]);

  const applySharedRoster = useCallback(
    (snapshot: RoomSnapshot, force = false) => {
      if (!sharedClient || sharedClient.role !== 'host') return;
      // A finished round still owns its visible physics/effects. Apply the
      // latest room roster only while the local session is actually ready;
      // handleSharedStart applies the pending roster immediately before the
      // next preparation.
      if (roulette.roundState !== 'ready' && !force) return;
      const participantNames = snapshot.participants.map((participant) => participant.displayName);
      setNames(participantNames.join('\n'));
      roulette.setMarbles(participantNames);
      writeLocalStorage(NAMES_STORAGE_KEY, participantNames.join(','));
    },
    [roulette, sharedClient]
  );

  useEffect(() => {
    if (!sharedClient) return;
    const cancelLocalPreparation = (reason: string) => {
      const token = sharedPreparedTokenRef.current;
      if (!token) return;
      sharedPreparedTokenRef.current = null;
      void roulette.cancelPreparedRound(token, reason);
      setSharedPreparedToken(null);
    };
    const onRoom = (event: Event) => {
      const detail = (event as CustomEvent<SharedRoomClientEvent>).detail;
      switch (detail.type) {
        case 'connection':
          setSharedConnectionStatus(detail.status);
          break;
        case 'snapshot':
          setSharedSnapshot(detail.snapshot);
          setSharedRound((current) => {
            const next = detail.snapshot.scheduledRound ?? null;
            if (
              current &&
              next &&
              current.roundId === next.roundId &&
              current.status === 'scheduled' &&
              next.status === 'running'
            ) {
              return current;
            }
            return next;
          });
          if (sharedClient.role === 'host') applySharedRoster(detail.snapshot);
          if (sharedClient.role === 'guest' && detail.snapshot.scheduledRound?.status === 'running') {
            setSharedError('Round in progress — the next round will sync.');
          }
          if (detail.snapshot.status !== 'open' || detail.snapshot.scheduledRound?.status === 'cancelled') {
            cancelLocalPreparation('The shared round is no longer active');
            setSharedRound(null);
            sharedStartInFlightRef.current = false;
            setSharedPreparing(false);
            setSettingsHidden(false);
          }
          break;
        case 'joined':
          setSharedSnapshot(detail.snapshot);
          setSharedRound(detail.snapshot.scheduledRound ?? null);
          if (sharedClient.role === 'guest' && detail.snapshot.scheduledRound?.status === 'running') {
            setSharedError('Round in progress — the next round will sync.');
          }
          if (detail.snapshot.status !== 'open' || detail.snapshot.scheduledRound?.status === 'cancelled') {
            cancelLocalPreparation('The shared round is no longer active');
            setSharedRound(null);
            sharedStartInFlightRef.current = false;
            setSharedPreparing(false);
            setSettingsHidden(false);
          }
          break;
        case 'scheduled':
          setSharedRound(detail.round);
          setSharedError(null);
          break;
        case 'started':
          setSharedRound((current) =>
            current && current.roundId === detail.round.roundId && current.status === 'scheduled' ? current : detail.round,
          );
          break;
        case 'result':
          setSharedSnapshot(detail.snapshot);
          setSharedRound(detail.snapshot.scheduledRound ?? null);
          if (sharedClient.role === 'guest' && detail.result) {
            const localResult = guestResultRef.current;
            if (
              localResult &&
              localResult.roundId === detail.result.roundId &&
              (localResult.winners.length !== detail.result.winners.length ||
                localResult.winners.some((winner, index) => winner !== detail.result?.winners[index]))
            ) {
              showToast('Playback diverged; the host result is authoritative.');
            }
          }
          break;
        case 'cancelled':
          cancelLocalPreparation(`Shared round cancelled: ${detail.reason}`);
          setSharedSnapshot(detail.snapshot);
          setSharedRound(null);
          setSharedPreparedToken(null);
          sharedStartInFlightRef.current = false;
          setSharedPreparing(false);
          setSharedError(detail.reason);
          setSettingsHidden(false);
          break;
        case 'closed':
          cancelLocalPreparation(`Shared room closed: ${detail.reason}`);
          setSharedSnapshot(detail.snapshot);
          setSharedRound(null);
          setSharedPreparedToken(null);
          sharedStartInFlightRef.current = false;
          setSharedPreparing(false);
          setSharedError(detail.reason);
          setSettingsHidden(false);
          break;
        case 'error':
          cancelLocalPreparation(detail.message);
          sharedStartInFlightRef.current = false;
          setSharedError(detail.message);
          setSharedPreparing(false);
          setSettingsHidden(false);
          break;
      }
    };
    sharedClient.addEventListener('room', onRoom);
    setSharedConnectionStatus(sharedClient.status);
    if (sharedClient.currentSnapshot) {
      setSharedSnapshot(sharedClient.currentSnapshot);
      setSharedRound(sharedClient.currentSnapshot.scheduledRound ?? null);
      if (sharedClient.role === 'host') applySharedRoster(sharedClient.currentSnapshot);
    }
    if (sharedClient.role === 'host' && sharedClient.status === 'idle') {
      void sharedClient
        .connect()
        .then(() => {
          const restoredRound = sharedClient.currentSnapshot?.scheduledRound;
          if (restoredRound?.status === 'running' && sharedPreparedTokenRef.current) {
            const token = sharedPreparedTokenRef.current;
            if (roulette.activatePreparedRound(token)) {
              sharedPreparedTokenRef.current = null;
              setSharedPreparedToken(null);
              sharedStartInFlightRef.current = false;
              setSharedPreparing(false);
            } else {
              sharedClient.cancelRound(restoredRound.roundId);
              setSharedError('The previous shared round was cancelled after reconnect.');
            }
          } else if (
            restoredRound &&
            (restoredRound.status === 'scheduled' || restoredRound.status === 'running') &&
            !sharedPreparedTokenRef.current
          ) {
            sharedClient.cancelRound(restoredRound.roundId);
            setSharedError('The previous shared round was cancelled after reconnect.');
          }
        })
        .catch((error) => {
          setSharedError(error instanceof Error ? error.message : 'Shared room could not reconnect');
        });
    }
    return () => sharedClient.removeEventListener('room', onRoom);
  }, [applySharedRoster, roulette, sharedClient, showToast]);

  const applyWinnerSetting = useCallback(
    (nextType: WinnerType = winnerType, edited?: EditedRange, fairnessPrecomputeDelay?: number) => {
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

      if (!roulette.setWinnerRange(start - 1, end - 1, fairnessPrecomputeDelay)) {
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
    (value: string, fairnessPrecomputeDelay = 150) => {
      const participantNames = getParticipantNames(value);
      roulette.batchFairnessUpdates(() => {
        roulette.setMarbles(participantNames, fairnessPrecomputeDelay);
        writeLocalStorage(NAMES_STORAGE_KEY, participantNames.join(','));
        applyWinnerSetting(undefined, undefined, fairnessPrecomputeDelay);
      });
      void refreshFairness();
    },
    [applyWinnerSetting, refreshFairness, roulette]
  );

  useEffect(() => {
    if (!ready || guestMode || initializedRef.current) return;
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
  }, [guestMode, ready, refreshFairness, refreshSponsors, roulette]);

  useEffect(() => {
    if (!ready || sharedClient?.role !== 'host' || !sharedClient.currentSnapshot) return;
    applySharedRoster(sharedClient.currentSnapshot);
  }, [applySharedRoster, ready, sharedClient]);

  useEffect(() => {
    const onGoal = (event: Event) => {
      const round = sharedRound;
      const winners = (event as CustomEvent<{ winners?: unknown }>).detail?.winners;
      if (
        sharedClient?.role === 'guest' &&
        round &&
        Array.isArray(winners) &&
        winners.every((winner): winner is string => typeof winner === 'string')
      ) {
        guestResultRef.current = { roundId: round.roundId, winners: winners.slice() };
      }
      if (sharedClient?.role === 'host' && round && !reportedSharedRounds.current.has(round.roundId)) {
        reportedSharedRounds.current.add(round.roundId);
        if (Array.isArray(winners) && winners.every((winner): winner is string => typeof winner === 'string')) {
          sharedClient.reportResult(round.roundId, winners);
        }
      }
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
    const onStartCancelled = () => {
      if (roulette.roundState !== 'running') setSettingsHidden(false);
    };
    roulette.addEventListener('goal', onGoal);
    roulette.addEventListener('message', onMessage);
    roulette.addEventListener('startcancelled', onStartCancelled);
    roulette.addEventListener('fairness', refreshFairness);
    return () => {
      roulette.removeEventListener('goal', onGoal);
      roulette.removeEventListener('message', onMessage);
      roulette.removeEventListener('startcancelled', onStartCancelled);
      roulette.removeEventListener('fairness', refreshFairness);
      if (settingsTimer.current !== null) {
        window.clearTimeout(settingsTimer.current);
        settingsTimer.current = null;
      }
    };
  }, [refreshFairness, roulette, sharedClient, sharedRound, showToast]);

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

  const handleFairnessProfileSelect = async (profileId: string) => {
    try {
      await roulette.selectFairnessProfile(profileId);
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Fairness profile could not be selected');
      await refreshFairness();
    }
  };

  const handleFairnessProfileCreate = async () => {
    const name = window.prompt('New fairness profile name', 'New profile');
    if (name === null) return;
    try {
      const profile = await roulette.createFairnessProfile(name);
      await roulette.selectFairnessProfile(profile.id);
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Fairness profile could not be created');
    }
  };

  const handleFairnessProfileRename = async () => {
    const profile = fairnessState?.profiles.find((candidate) => candidate.id === fairnessState.activeProfileId);
    if (!profile) return;
    const name = window.prompt('Rename fairness profile', profile.name);
    if (name === null) return;
    try {
      await roulette.renameFairnessProfile(profile.id, name);
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Fairness profile could not be renamed');
    }
  };

  const handleFairnessProfileDuplicate = async () => {
    const profile = fairnessState?.profiles.find((candidate) => candidate.id === fairnessState.activeProfileId);
    if (!profile) return;
    const name = window.prompt('Duplicate fairness profile', `${profile.name} copy`);
    if (name === null) return;
    try {
      const duplicate = await roulette.duplicateFairnessProfile(profile.id, name);
      await roulette.selectFairnessProfile(duplicate.id);
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Fairness profile could not be duplicated');
    }
  };

  const handleFairnessAddParticipant = async (name: string) => {
    try {
      await roulette.addFairnessParticipant(name);
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Participant could not be added');
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

  const handleFairnessActive = async (participantId: string, active: boolean) => {
    try {
      await roulette.setFairnessParticipantActive(participantId, active);
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Participant activity could not be changed');
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
    if (!window.confirm('Import this fairness data as a new profile?')) return;
    try {
      await roulette.importFairnessData(value);
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Fairness data could not be imported');
    }
  };

  const handleFairnessDelete = async () => {
    if (!window.confirm('Delete fairness history for this profile?')) return;
    try {
      await roulette.deleteFairnessData();
      await refreshFairness();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Fairness history could not be deleted');
    }
  };

  const handleCreateSharedRoom = async () => {
    try {
      localNamesBeforeSharedRoom.current = getParticipantNames(names);
      const client = await SharedRoomClient.createHost();
      setSharedClient(client);
      setSharedSnapshot(client.currentSnapshot);
      setSharedConnectionStatus(client.status);
      setSharedError(null);
    } catch (error) {
      setSharedError(error instanceof Error ? error.message : 'Shared room could not be created');
    }
  };

  const handleJoinSharedRoom = async (name: string) => {
    if (!sharedClient || sharedClient.role !== 'guest') return;
    try {
      setSharedError(null);
      await sharedClient.join(name);
    } catch (error) {
      setSharedError(error instanceof Error ? error.message : 'Could not join the shared room');
    }
  };

  const handleStopSharedRoom = () => {
    if (!sharedClient) return;
    if (sharedPreparedTokenRef.current) {
      const token = sharedPreparedTokenRef.current;
      sharedPreparedTokenRef.current = null;
      void roulette.cancelPreparedRound(token, 'Shared room stopped');
    }
    if (sharedRound?.status === 'scheduled') sharedClient.cancelRound(sharedRound.roundId);
    if (sharedClient.role === 'host') sharedClient.closeRoom();
    sharedClient.disconnect();
    setSharedClient(null);
    setRoomRouteActive(false);
    setSharedSnapshot(null);
    setSharedRound(null);
    setSharedPreparedToken(null);
    sharedStartInFlightRef.current = false;
    setSharedPreparing(false);
    setSharedError(null);
    const restore = localNamesBeforeSharedRoom.current;
    localNamesBeforeSharedRoom.current = null;
    if (restore) {
      setNames(restore.join('\n'));
      roulette.setMarbles(restore);
      writeLocalStorage(NAMES_STORAGE_KEY, restore.join(','));
    }
  };

  const handleLeaveSharedRoom = () => {
    sharedClient?.leave();
    sharedClient?.disconnect();
    setSharedClient(null);
    setRoomRouteActive(false);
    setSharedSnapshot(null);
    setSharedRound(null);
    setSharedError(null);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
  };

  const handleSharedStart = async () => {
    if (!sharedClient || sharedClient.role !== 'host' || sharedPreparing || sharedStartInFlightRef.current) return;
    sharedStartInFlightRef.current = true;
    if (sharedSnapshot) applySharedRoster(sharedSnapshot, true);
    setSharedPreparing(true);
    setSettingsHidden(true);
    let preparedToken: string | null = null;
    try {
      const prepared = await roulette.prepareRoundForSharedStart();
      if (!prepared) throw new Error('The shared round could not be prepared');
      preparedToken = prepared.token;
      sharedPreparedTokenRef.current = prepared.token;
      setSharedPreparedToken(prepared.token);
      const round = await sharedClient.scheduleRound(prepared.replay);
      setSharedRound(round);
      setSharedError(null);
    } catch (error) {
      if (preparedToken) await roulette.cancelPreparedRound(preparedToken, 'Shared round scheduling failed');
      sharedPreparedTokenRef.current = null;
      setSharedPreparedToken(null);
      sharedStartInFlightRef.current = false;
      setSharedPreparing(false);
      setSettingsHidden(false);
      setSharedError(error instanceof Error ? error.message : 'Shared round could not be scheduled');
    }
  };

  useEffect(() => {
    if (!ready || !sharedClient || !sharedRound || sharedRound.status !== 'scheduled') return;
    if (sharedClient.role === 'guest' && sharedClient.getLocalStartTime(sharedRound.startAt) < Date.now() - 1000) {
      setSharedError('Round in progress — the next round will sync.');
      return;
    }
    if (sharedClient.role === 'guest') {
      try {
        roulette.loadReplay(sharedRound.replay);
      } catch (error) {
        setSharedError(error instanceof Error ? error.message : 'Shared replay could not be loaded');
        return;
      }
    }
    const cancel = sharedClient.scheduleAt(sharedRound.startAt, () => {
      if (sharedClient.role === 'host') {
        const token = sharedPreparedTokenRef.current;
        if (token) {
          if (!roulette.activatePreparedRound(token)) {
            setSharedError('The shared round could not be activated');
            void roulette.cancelPreparedRound(token, 'Shared round activation failed');
          }
          sharedPreparedTokenRef.current = null;
          setSharedPreparedToken(null);
        }
        sharedStartInFlightRef.current = false;
        setSharedPreparing(false);
      } else {
        void Promise.resolve(roulette.start()).catch((error) => {
          setSharedError(error instanceof Error ? error.message : 'Shared round could not start');
        });
      }
    });
    return cancel;
  }, [ready, roulette, sharedClient, sharedRound]);

  const maps = roulette.getMaps();
  const onStart = () => {
    if (!ready || (roulette.roundState !== 'ready' && roulette.roundState !== 'finished') || roulette.getCount() === 0)
      return;
    if (sharedClient?.role === 'host') {
      void handleSharedStart();
      return;
    }
    setSettingsHidden(true);
    void Promise.resolve(roulette.start()).catch((error) => {
      showToast(error instanceof Error ? error.message : 'The roulette could not start');
    });
  };

  return (
    <div ref={rootRef}>
      <h1 className="sr-only">Marble Roulette - 랜덤 추첨기</h1>
      {!guestMode ? <div id="settings" className={`settings${settingsHidden ? ' hide' : ''}`}>
        <SettingsPanel
          collapsed={collapsed}
          onToggle={() => setCollapsed((value) => !value)}
          generalSettings={{
            disabled: sharedControlsLocked,
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
            disabled: sharedControlsLocked,
            state: fairnessState,
            onEnabled: (value) => void handleFairnessEnabled(value),
            onModeChange: (value) => void handleFairnessMode(value),
            onProfileSelect: (profileId) => void handleFairnessProfileSelect(profileId),
            onProfileCreate: () => void handleFairnessProfileCreate(),
            onProfileRename: () => void handleFairnessProfileRename(),
            onProfileDuplicate: () => void handleFairnessProfileDuplicate(),
            onAddParticipant: (name) => void handleFairnessAddParticipant(name),
            onRename: (participantId, currentName) => void handleFairnessRename(participantId, currentName),
            onActive: (participantId, active) => void handleFairnessActive(participantId, active),
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
          readOnly={sharedClient?.role === 'host'}
          startDisabled={sharedControlsLocked}
          onChange={(value) => {
            if (sharedClient?.role === 'host') return;
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
            if (sharedClient?.role === 'host') return;
            if (ready) getReady(names, 0);
          }}
          onStart={onStart}
        />
      </div> : null}
      <SharedRoomPanel
        client={sharedClient}
        snapshot={sharedSnapshot}
        connectionStatus={sharedConnectionStatus}
        roomCode={roomRouteActive ? initialRoomCode : null}
        error={sharedError}
        onCreate={() => void handleCreateSharedRoom()}
        onJoin={(name) => void handleJoinSharedRoom(name)}
        onStop={handleStopSharedRoom}
        onLeave={handleLeaveSharedRoom}
      />
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
