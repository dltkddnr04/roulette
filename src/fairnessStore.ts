import {
  FAIRNESS_DATA_VERSION,
  type FairnessProfile,
  type FairnessEvent,
  type FairnessDrawCancelledEvent,
  type FairnessDrawConfirmedEvent,
  type FairnessDrawFailedEvent,
  type FairnessDrawPreparedEvent,
  validateFairnessEvent,
  validateFairnessExport,
} from './fairness';
import type { Seed } from './utils/random';

/**
 * Durable, private preparation material for a future fairness draw.
 *
 * Reservations deliberately live outside the event log. They make the
 * physical draw information durable before Start without making an unused
 * speculative preparation visible in Fairness history.
 */
export type FairnessReservationRecord = Readonly<{
  profileId: string;
  reservationId: string;
  drawId: string;
  key: string;
  seed: Seed;
  winnerMarbleIds: readonly number[];
  winnerEntryIds: readonly string[];
  /** 0 is the normalized value for reservations written before versioning. */
  rulesetVersion: number;
  state: 'ready' | 'claimed';
  claimedAt?: number;
  draft: unknown;
}>;

export type FairnessReservationIdentity = Readonly<{
  /** Optional for callers written before profile-scoped reservations. */
  profileId?: string;
  reservationId: string;
  drawId: string;
  key: string;
  seed: Seed;
  rulesetVersion: number;
}>;

export type FairnessReservationClaimResult = 'claimed' | 'already-claimed' | 'missing' | 'mismatch';

export type FairnessReservationDiscardResult = 'discarded' | 'claimed' | 'missing' | 'mismatch';

export type FairnessInvalidReservationDiscardResult = 'discarded' | 'claimed' | 'valid' | 'missing';

export type FairnessHistoryStamp = Readonly<{
  revision: number;
  eventCount: number;
  tailEventId: string | null;
}>;

export type FairnessReservationTerminalEvent =
  | FairnessDrawConfirmedEvent
  | FairnessDrawFailedEvent
  | FairnessDrawCancelledEvent;

export interface FairnessEventStore {
  load(profileId?: string): Promise<FairnessEvent[]>;
  loadHistoryStamp?(profileId?: string): Promise<FairnessHistoryStamp>;
  loadProfiles?(): Promise<FairnessProfile[]>;
  saveProfile?(profile: FairnessProfile): Promise<void>;
  append(event: FairnessEvent, profileId?: string): Promise<void>;
  replace(events: readonly FairnessEvent[], profileId?: string): Promise<void>;
  clear(profileId?: string): Promise<void>;
  loadReservations?(profileId?: string): Promise<FairnessReservationRecord[]>;
  hasQuarantinedClaimedReservations?(): Promise<boolean>;
  reserve?(reservation: FairnessReservationRecord): Promise<void>;
  removeReservation?(reservationId: string): Promise<void>;
  claimReservation?(
    reservationId: string,
    expected: FairnessReservationIdentity
  ): Promise<FairnessReservationClaimResult>;
  discardReadyReservation?(
    reservationId: string,
    expected: FairnessReservationIdentity
  ): Promise<FairnessReservationDiscardResult>;
  discardInvalidReadyReservation?(
    reservationId: string
  ): Promise<FairnessInvalidReservationDiscardResult>;
  finalizeReservation?(
    reservationId: string,
    preparedEvent: FairnessDrawPreparedEvent,
    terminalEvent: FairnessReservationTerminalEvent,
    expected?: FairnessReservationIdentity
  ): Promise<void>;
  recoverClaimedReservation?(
    reservationId: string,
    preparedEvent: FairnessDrawPreparedEvent | null,
    terminalEvent: FairnessDrawCancelledEvent,
    expected?: FairnessReservationIdentity
  ): Promise<void>;
}

type StoredFairnessEvent = {
  sequence?: number;
  profileId?: string;
  event: FairnessEvent;
};

const DATABASE_NAME = 'marble-roulette-fairness-v1';
const DATABASE_VERSION = 3;
const EVENT_STORE_NAME = 'events';
const RESERVATION_STORE_NAME = 'reservations';
const PROFILE_STORE_NAME = 'profiles';
export const DEFAULT_FAIRNESS_PROFILE_ID = 'default';
export const DEFAULT_FAIRNESS_PROFILE_NAME = 'Default';
// Keep the per-profile history revision in the existing event store instead
// of adding another metadata store. The reserved negative key is never
// produced by the event store's auto-increment key generator and is filtered
// from the public log.
const HISTORY_METADATA_SEQUENCE = -1;

type StoredHistoryMetadata = {
  sequence: typeof HISTORY_METADATA_SEQUENCE;
  kind: 'history-metadata';
  /** Legacy v2 global revision, retained for the default profile migration. */
  revision?: number;
  revisions?: Record<string, number>;
};

function isHistoryMetadata(value: unknown): value is StoredHistoryMetadata {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { sequence?: unknown }).sequence === HISTORY_METADATA_SEQUENCE &&
    (value as { kind?: unknown }).kind === 'history-metadata'
  );
}

function profileIdOrDefault(profileId: string | undefined): string {
  return profileId && profileId.trim() ? profileId : DEFAULT_FAIRNESS_PROFILE_ID;
}

function profileMatches(value: unknown, profileId: string): boolean {
  if (!value || typeof value !== 'object') return true;
  const recordProfileId = (value as { profileId?: unknown }).profileId;
  return profileIdOrDefault(typeof recordProfileId === 'string' ? recordProfileId : undefined) === profileIdOrDefault(profileId);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function storageUnavailable(): Error {
  return new Error('Fairness storage is unavailable');
}

function sameReservationIdentity(
  reservation: FairnessReservationRecord,
  expected: FairnessReservationIdentity
): boolean {
  return (
    profileIdOrDefault(reservation.profileId) === profileIdOrDefault(expected.profileId) &&
    reservation.reservationId === expected.reservationId &&
    reservation.drawId === expected.drawId &&
    reservation.key === expected.key &&
    reservation.seed === expected.seed &&
    reservation.rulesetVersion === expected.rulesetVersion
  );
}

function validateReservationEvents(
  preparedEvent: FairnessDrawPreparedEvent,
  terminalEvent: FairnessReservationTerminalEvent
): { preparedEvent: FairnessDrawPreparedEvent; terminalEvent: FairnessReservationTerminalEvent } {
  const prepared = validateFairnessEvent(preparedEvent);
  const terminal = validateFairnessEvent(terminalEvent);
  if (prepared.type !== 'drawPrepared') throw new Error('Fairness prepared event is invalid');
  if (
    terminal.type !== 'drawConfirmed' &&
    terminal.type !== 'drawFailed' &&
    terminal.type !== 'drawCancelled'
  ) {
    throw new Error('Fairness terminal event is invalid');
  }
  if (prepared.drawId !== terminal.drawId) throw new Error('Fairness reservation event identity is invalid');
  return { preparedEvent: prepared, terminalEvent: terminal };
}

function readHistoryRevision(value: unknown): number {
  if (
    value &&
    typeof value === 'object' &&
    Number.isSafeInteger((value as { revision?: unknown }).revision) &&
    (value as { revision: number }).revision >= 0
  ) {
    return (value as { revision: number }).revision;
  }
  return 0;
}

function withNextHistoryRevision(
  store: IDBObjectStore,
  profileId: string,
  callback: (revision: number, metadata: StoredHistoryMetadata) => void
): void {
  const request = store.get(HISTORY_METADATA_SEQUENCE);
  request.onsuccess = () => {
    const existing = request.result as StoredHistoryMetadata | undefined;
    const revisions = { ...(existing?.revisions ?? {}) };
    const previous =
      revisions[profileId] ??
      (profileId === DEFAULT_FAIRNESS_PROFILE_ID ? readHistoryRevision(existing) : 0);
    const revision = previous + 1;
    revisions[profileId] = revision;
    callback(revision, {
      sequence: HISTORY_METADATA_SEQUENCE,
      kind: 'history-metadata',
      revision: revisions[DEFAULT_FAIRNESS_PROFILE_ID] ?? 0,
      revisions,
    });
  };
}

function validateReservation(value: unknown): FairnessReservationRecord {
  if (!value || typeof value !== 'object') throw new Error('Fairness reservation is corrupt');
  const candidate = value as Partial<FairnessReservationRecord>;
  const rawProfileId = (value as { profileId?: unknown }).profileId;
  if (
    rawProfileId !== undefined &&
    (typeof rawProfileId !== 'string' || rawProfileId.trim().length === 0 || rawProfileId.length > 256)
  ) {
    throw new Error('Fairness reservation is corrupt');
  }
  if (
    typeof candidate.reservationId !== 'string' ||
    typeof candidate.drawId !== 'string' ||
    typeof candidate.key !== 'string' ||
    (typeof candidate.seed !== 'string' && (typeof candidate.seed !== 'number' || !Number.isFinite(candidate.seed))) ||
    !Array.isArray(candidate.winnerMarbleIds) ||
    !candidate.winnerMarbleIds.every((id) => Number.isSafeInteger(id) && id >= 0) ||
    !Array.isArray(candidate.winnerEntryIds) ||
    !candidate.winnerEntryIds.every((id) => typeof id === 'string') ||
    candidate.draft === undefined
  ) {
    throw new Error('Fairness reservation is corrupt');
  }
  const rulesetVersion = candidate.rulesetVersion === undefined ? 0 : candidate.rulesetVersion;
  if (!Number.isSafeInteger(rulesetVersion) || rulesetVersion < 0) {
    throw new Error('Fairness reservation is corrupt');
  }
  const state = candidate.state === undefined ? 'ready' : candidate.state;
  if (state !== 'ready' && state !== 'claimed') {
    throw new Error('Fairness reservation is corrupt');
  }
  const claimedAt = candidate.claimedAt;
  if (claimedAt !== undefined && (typeof claimedAt !== 'number' || !Number.isFinite(claimedAt) || claimedAt < 0)) {
    throw new Error('Fairness reservation is corrupt');
  }
  return {
    profileId: rawProfileId === undefined ? DEFAULT_FAIRNESS_PROFILE_ID : (rawProfileId as string),
    reservationId: candidate.reservationId,
    drawId: candidate.drawId,
    key: candidate.key,
    seed: candidate.seed,
    winnerMarbleIds: [...candidate.winnerMarbleIds],
    winnerEntryIds: [...candidate.winnerEntryIds],
    rulesetVersion,
    state,
    ...(claimedAt === undefined ? {} : { claimedAt }),
    draft: clone(candidate.draft),
  };
}

function validateProfile(value: unknown): FairnessProfile {
  if (!value || typeof value !== 'object') throw new Error('Fairness profile is corrupt');
  const candidate = value as Partial<FairnessProfile>;
  if (
    typeof candidate.id !== 'string' ||
    candidate.id.trim().length === 0 ||
    candidate.id.length > 256 ||
    typeof candidate.name !== 'string' ||
    candidate.name.trim().length === 0 ||
    candidate.name.length > 256 ||
    typeof candidate.createdAt !== 'number' ||
    !Number.isFinite(candidate.createdAt) ||
    typeof candidate.updatedAt !== 'number' ||
    !Number.isFinite(candidate.updatedAt)
  ) {
    throw new Error('Fairness profile is corrupt');
  }
  return {
    id: candidate.id,
    name: candidate.name.trim(),
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

function profileOrder(left: FairnessProfile, right: FairnessProfile): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

export class IndexedDbFairnessStore implements FairnessEventStore {
  private databasePromise: Promise<IDBDatabase> | null = null;
  private quarantinedClaimedReservationCount = 0;

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;

    const databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(storageUnavailable());
        return;
      }

      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(EVENT_STORE_NAME)) {
          request.result.createObjectStore(EVENT_STORE_NAME, { keyPath: 'sequence', autoIncrement: true });
        }
        if (!request.result.objectStoreNames.contains(RESERVATION_STORE_NAME)) {
          request.result.createObjectStore(RESERVATION_STORE_NAME, { keyPath: 'reservationId' });
        }
        if (!request.result.objectStoreNames.contains(PROFILE_STORE_NAME)) {
          request.result.createObjectStore(PROFILE_STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          this.databasePromise = null;
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? storageUnavailable());
      request.onblocked = () => reject(new Error('Fairness storage is blocked'));
    }).catch((error) => {
      this.databasePromise = null;
      throw error;
    });

    this.databasePromise = databasePromise;
    return databasePromise;
  }

  private request<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
    storeName = EVENT_STORE_NAME
  ): Promise<T> {
    return this.open().then(
      (database) =>
        new Promise<T>((resolve, reject) => {
          let transaction: IDBTransaction;
          let request: IDBRequest<T>;
          try {
            transaction = database.transaction(storeName, mode);
            request = operation(transaction.objectStore(storeName));
          } catch (error) {
            reject(error);
            return;
          }

          let result!: T;
          let requestCompleted = false;
          request.onsuccess = () => {
            result = request.result;
            requestCompleted = true;
          };
          request.onerror = () => reject(request.error ?? new Error('Fairness storage request failed'));
          transaction.oncomplete = () => {
            if (requestCompleted) resolve(result);
          };
          transaction.onerror = () => reject(transaction.error ?? new Error('Fairness storage transaction failed'));
          transaction.onabort = () => reject(transaction.error ?? new Error('Fairness storage transaction aborted'));
        })
    );
  }

  async load(profileId = DEFAULT_FAIRNESS_PROFILE_ID): Promise<FairnessEvent[]> {
    const scopedProfileId = profileIdOrDefault(profileId);
    const records = await this.request<StoredFairnessEvent[]>('readonly', (store) => store.getAll());
    const events = records.filter((record) => profileMatches(record, scopedProfileId)).map((record) => {
      if (isHistoryMetadata(record)) return null;
      if (!record || typeof record !== 'object' || !record.event) throw new Error('Fairness storage is corrupt');
      const event = validateFairnessEvent(record.event);
      if (event.version !== FAIRNESS_DATA_VERSION) throw new Error('Fairness storage version is unsupported');
      return event;
    }).filter((event): event is FairnessEvent => event !== null);
    return [...validateFairnessExport({ version: FAIRNESS_DATA_VERSION, mode: 'simple', events }).events];
  }

  async loadHistoryStamp(profileId = DEFAULT_FAIRNESS_PROFILE_ID): Promise<FairnessHistoryStamp> {
    const scopedProfileId = profileIdOrDefault(profileId);
    const database = await this.open();
    return new Promise<FairnessHistoryStamp>((resolve, reject) => {
      let transaction: IDBTransaction;
      let storedRecordCount = 0;
      let tailEventId: string | null = null;
      let revision = 0;
      try {
        transaction = database.transaction(EVENT_STORE_NAME, 'readonly');
        const eventStore = transaction.objectStore(EVENT_STORE_NAME);
        const recordsRequest = eventStore.getAll();
        const metadataRequest = eventStore.get(HISTORY_METADATA_SEQUENCE);
        recordsRequest.onsuccess = () => {
          const records = (recordsRequest.result ?? []) as StoredFairnessEvent[];
          const profileRecords = records.filter(
            (record) => !isHistoryMetadata(record) && profileMatches(record, scopedProfileId)
          );
          storedRecordCount = profileRecords.length;
          tailEventId = profileRecords[profileRecords.length - 1]?.event?.eventId ?? null;
        };
        metadataRequest.onsuccess = () => {
          const metadata = isHistoryMetadata(metadataRequest.result) ? metadataRequest.result : undefined;
          const revisions = metadata?.revisions ?? {};
          revision =
            revisions[scopedProfileId] ??
            (scopedProfileId === DEFAULT_FAIRNESS_PROFILE_ID ? readHistoryRevision(metadata) : 0);
        };
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve({ revision, eventCount: storedRecordCount, tailEventId });
      transaction.onerror = () => reject(transaction.error ?? new Error('Fairness history stamp failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Fairness history stamp aborted'));
    });
  }

  async loadReservations(profileId = DEFAULT_FAIRNESS_PROFILE_ID): Promise<FairnessReservationRecord[]> {
    const scopedProfileId = profileIdOrDefault(profileId);
    this.quarantinedClaimedReservationCount = 0;
    const records = await this.request<unknown[]>('readonly', (store) => store.getAll(), RESERVATION_STORE_NAME);
    const reservations: FairnessReservationRecord[] = [];
    const invalidReadyReservationIds: string[] = [];
    records.forEach((record) => {
      const rawProfileId =
        record && typeof record === 'object' ? (record as { profileId?: unknown }).profileId : undefined;
      if (
        (rawProfileId !== undefined && typeof rawProfileId !== 'string') ||
        (typeof rawProfileId === 'string' && profileIdOrDefault(rawProfileId) !== scopedProfileId) ||
        (rawProfileId === undefined && scopedProfileId !== DEFAULT_FAIRNESS_PROFILE_ID)
      ) {
        return;
      }
      try {
        const reservation = validateReservation(record);
        if (reservation.profileId === scopedProfileId) reservations.push(reservation);
      } catch {
        if (record && typeof record === 'object' && (record as { state?: unknown }).state === 'claimed') {
          // A malformed claimed record cannot be safely attributed to this
          // document. Keep it quarantined and let the coordinator fail closed
          // until the owning document finalizes or the record is repaired.
          this.quarantinedClaimedReservationCount += 1;
        } else if (
          record &&
          typeof record === 'object' &&
          typeof (record as { reservationId?: unknown }).reservationId === 'string' &&
          (record as { state?: unknown }).state !== 'claimed'
        ) {
          invalidReadyReservationIds.push((record as { reservationId: string }).reservationId);
        }
      }
    });
    // A single malformed speculative record must not make the Fairness control
    // plane unavailable. A malformed record that claims to be active is
    // quarantined rather than deleted: another live document may own it, and
    // the store cannot safely prove otherwise without a valid identity.
    await Promise.all(
      invalidReadyReservationIds.map((reservationId) =>
        this.discardInvalidReadyReservation(reservationId).catch(() => 'missing' as const)
      )
    );
    return reservations;
  }

  async loadProfiles(): Promise<FairnessProfile[]> {
    const records = await this.request<unknown[]>('readonly', (store) => store.getAll(), PROFILE_STORE_NAME);
    const profiles: FairnessProfile[] = [];
    records.forEach((record) => {
      try {
        profiles.push(validateProfile(record));
      } catch {
        // Ignore malformed metadata. The event log remains recoverable and a
        // fresh default profile is created below when no valid profile exists.
      }
    });
    if (!profiles.some((profile) => profile.id === DEFAULT_FAIRNESS_PROFILE_ID)) {
      const now = Date.now();
      const profile: FairnessProfile = {
        id: DEFAULT_FAIRNESS_PROFILE_ID,
        name: DEFAULT_FAIRNESS_PROFILE_NAME,
        createdAt: now,
        updatedAt: now,
      };
      await this.saveProfile(profile);
      profiles.push(profile);
    }
    return profiles.sort(profileOrder);
  }

  async saveProfile(profile: FairnessProfile): Promise<void> {
    const checked = validateProfile(profile);
    await this.request<IDBValidKey>('readwrite', (store) => store.put(checked), PROFILE_STORE_NAME);
  }

  async hasQuarantinedClaimedReservations(): Promise<boolean> {
    return this.quarantinedClaimedReservationCount > 0;
  }

  async append(event: FairnessEvent, profileId = DEFAULT_FAIRNESS_PROFILE_ID): Promise<void> {
    const checked = validateFairnessEvent(event);
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(EVENT_STORE_NAME, 'readwrite');
        const eventStore = transaction.objectStore(EVENT_STORE_NAME);
        withNextHistoryRevision(eventStore, profileIdOrDefault(profileId), (_revision, metadata) => {
          eventStore.put(metadata);
          eventStore.add({ event: checked, profileId: profileIdOrDefault(profileId) } satisfies StoredFairnessEvent);
        });
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Fairness storage transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Fairness storage transaction aborted'));
    });
  }

  async reserve(reservation: FairnessReservationRecord): Promise<void> {
    const checked = validateReservation(reservation);
    await this.request<IDBValidKey>('readwrite', (store) => store.put(checked), RESERVATION_STORE_NAME);
  }

  async removeReservation(reservationId: string): Promise<void> {
    await this.request<undefined>('readwrite', (store) => store.delete(reservationId), RESERVATION_STORE_NAME);
  }

  async discardInvalidReadyReservation(
    reservationId: string
  ): Promise<FairnessInvalidReservationDiscardResult> {
    const database = await this.open();
    return new Promise<FairnessInvalidReservationDiscardResult>((resolve, reject) => {
      let transaction: IDBTransaction;
      let result: FairnessInvalidReservationDiscardResult = 'missing';
      let settled = false;
      const resolveOnce = (value: FairnessInvalidReservationDiscardResult): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      try {
        transaction = database.transaction(RESERVATION_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(RESERVATION_STORE_NAME);
        const request = store.get(reservationId);
        request.onsuccess = () => {
          try {
            if (!request.result) {
              result = 'missing';
              return;
            }
            try {
              validateReservation(request.result);
              result = 'valid';
              return;
            } catch {
              if (
                request.result &&
                typeof request.result === 'object' &&
                (request.result as { state?: unknown }).state === 'claimed'
              ) {
                result = 'claimed';
                return;
              }
              store.delete(reservationId);
              result = 'discarded';
            }
          } catch (error) {
            rejectOnce(error);
            try {
              transaction.abort();
            } catch {
              // The transaction may already be aborting.
            }
          }
        };
        request.onerror = () =>
          rejectOnce(request.error ?? new Error('Fairness invalid reservation discard failed'));
        transaction.oncomplete = () => resolveOnce(result);
        transaction.onerror = () =>
          rejectOnce(transaction.error ?? new Error('Fairness invalid reservation discard transaction failed'));
        transaction.onabort = () =>
          rejectOnce(transaction.error ?? new Error('Fairness invalid reservation discard transaction aborted'));
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  async discardReadyReservation(
    reservationId: string,
    expected: FairnessReservationIdentity
  ): Promise<FairnessReservationDiscardResult> {
    const database = await this.open();
    return new Promise<FairnessReservationDiscardResult>((resolve, reject) => {
      let transaction: IDBTransaction;
      let result: FairnessReservationDiscardResult = 'missing';
      let settled = false;
      const resolveOnce = (value: FairnessReservationDiscardResult): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      try {
        transaction = database.transaction(RESERVATION_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(RESERVATION_STORE_NAME);
        const request = store.get(reservationId);
        request.onsuccess = () => {
          try {
            if (!request.result) {
              result = 'missing';
              return;
            }
            const reservation = validateReservation(request.result);
            if (!sameReservationIdentity(reservation, expected)) {
              result = 'mismatch';
              return;
            }
            if (reservation.state === 'claimed') {
              result = 'claimed';
              return;
            }
            store.delete(reservationId);
            result = 'discarded';
          } catch (error) {
            rejectOnce(error);
            try {
              transaction.abort();
            } catch {
              // The transaction may already be aborting.
            }
          }
        };
        request.onerror = () =>
          rejectOnce(request.error ?? new Error('Fairness reservation discard failed'));
        transaction.oncomplete = () => resolveOnce(result);
        transaction.onerror = () =>
          rejectOnce(transaction.error ?? new Error('Fairness reservation discard transaction failed'));
        transaction.onabort = () =>
          rejectOnce(transaction.error ?? new Error('Fairness reservation discard transaction aborted'));
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  async claimReservation(
    reservationId: string,
    expected: FairnessReservationIdentity
  ): Promise<FairnessReservationClaimResult> {
    const database = await this.open();
    return new Promise<FairnessReservationClaimResult>((resolve, reject) => {
      let transaction: IDBTransaction;
      let result: FairnessReservationClaimResult = 'missing';
      let settled = false;
      const resolveOnce = (value: FairnessReservationClaimResult): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      try {
        transaction = database.transaction(RESERVATION_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(RESERVATION_STORE_NAME);
        const request = store.get(reservationId);
        request.onsuccess = () => {
          try {
            if (!request.result) {
              result = 'missing';
              return;
            }
            const reservation = validateReservation(request.result);
            if (!sameReservationIdentity(reservation, expected)) {
              result = 'mismatch';
              return;
            }
            if (reservation.state === 'claimed') {
              result = 'already-claimed';
              return;
            }
            store.put({ ...reservation, state: 'claimed', claimedAt: Date.now() });
            result = 'claimed';
          } catch (error) {
            rejectOnce(error);
            try {
              transaction.abort();
            } catch {
              // The transaction may already be aborting.
            }
          }
        };
        request.onerror = () => rejectOnce(request.error ?? new Error('Fairness reservation claim failed'));
        transaction.oncomplete = () => resolveOnce(result);
        transaction.onerror = () =>
          rejectOnce(transaction.error ?? new Error('Fairness reservation claim transaction failed'));
        transaction.onabort = () =>
          rejectOnce(transaction.error ?? new Error('Fairness reservation claim transaction aborted'));
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  async finalizeReservation(
    reservationId: string,
    preparedEvent: FairnessDrawPreparedEvent,
    terminalEvent: FairnessReservationTerminalEvent,
    expected?: FairnessReservationIdentity
  ): Promise<void> {
    const checked = validateReservationEvents(preparedEvent, terminalEvent);
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      let settled = false;
      const resolveOnce = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      try {
        transaction = database.transaction([EVENT_STORE_NAME, RESERVATION_STORE_NAME], 'readwrite');
        const eventStore = transaction.objectStore(EVENT_STORE_NAME);
        const reservationStore = transaction.objectStore(RESERVATION_STORE_NAME);
        const request = reservationStore.get(reservationId);
        request.onsuccess = () => {
          try {
            if (!request.result) throw new Error('Fairness reservation is missing');
            const reservation = validateReservation(request.result);
            if (
              reservation.state !== 'claimed' ||
              (expected && !sameReservationIdentity(reservation, expected)) ||
              reservation.drawId !== checked.preparedEvent.drawId ||
              reservation.seed !== checked.preparedEvent.seed
            ) {
              throw new Error('Fairness reservation claim identity is invalid');
            }
            eventStore.add({ event: checked.preparedEvent, profileId: reservation.profileId } satisfies StoredFairnessEvent);
            eventStore.add({ event: checked.terminalEvent, profileId: reservation.profileId } satisfies StoredFairnessEvent);
            reservationStore.delete(reservationId);
            withNextHistoryRevision(eventStore, reservation.profileId, (_revision, metadata) => {
              eventStore.put(metadata);
            });
          } catch (error) {
            rejectOnce(error);
            try {
              transaction.abort();
            } catch {
              // The transaction may already be aborting.
            }
          }
        };
        request.onerror = () => rejectOnce(request.error ?? new Error('Fairness reservation finalization failed'));
        transaction.oncomplete = resolveOnce;
        transaction.onerror = () =>
          rejectOnce(transaction.error ?? new Error('Fairness reservation finalization transaction failed'));
        transaction.onabort = () =>
          rejectOnce(transaction.error ?? new Error('Fairness reservation finalization transaction aborted'));
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  async recoverClaimedReservation(
    reservationId: string,
    preparedEvent: FairnessDrawPreparedEvent | null,
    terminalEvent: FairnessDrawCancelledEvent,
    expected?: FairnessReservationIdentity
  ): Promise<void> {
    const checkedTerminal = validateFairnessEvent(terminalEvent);
    if (checkedTerminal.type !== 'drawCancelled') throw new Error('Fairness recovery event is invalid');
    const checkedPrepared = preparedEvent ? validateFairnessEvent(preparedEvent) : null;
    if (checkedPrepared && checkedPrepared.type !== 'drawPrepared') {
      throw new Error('Fairness recovery prepared event is invalid');
    }
    if (checkedPrepared && checkedPrepared.drawId !== checkedTerminal.drawId) {
      throw new Error('Fairness recovery identity is invalid');
    }
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      let settled = false;
      const resolveOnce = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      try {
        transaction = database.transaction([EVENT_STORE_NAME, RESERVATION_STORE_NAME], 'readwrite');
        const eventStore = transaction.objectStore(EVENT_STORE_NAME);
        const reservationStore = transaction.objectStore(RESERVATION_STORE_NAME);
        const request = reservationStore.get(reservationId);
        request.onsuccess = () => {
          try {
            if (!request.result) throw new Error('Fairness reservation is missing');
            const reservation = validateReservation(request.result);
            if (
              (expected && !sameReservationIdentity(reservation, expected)) ||
              reservation.drawId !== checkedTerminal.drawId ||
              (checkedPrepared && reservation.state !== 'claimed') ||
              (checkedPrepared && reservation.seed !== checkedPrepared.seed)
            ) {
              throw new Error('Fairness reservation recovery identity is invalid');
            }
            if (checkedPrepared) eventStore.add({ event: checkedPrepared, profileId: reservation.profileId } satisfies StoredFairnessEvent);
            eventStore.add({ event: checkedTerminal, profileId: reservation.profileId } satisfies StoredFairnessEvent);
            reservationStore.delete(reservationId);
            withNextHistoryRevision(eventStore, reservation.profileId, (_revision, metadata) => {
              eventStore.put(metadata);
            });
          } catch (error) {
            rejectOnce(error);
            try {
              transaction.abort();
            } catch {
              // The transaction may already be aborting.
            }
          }
        };
        request.onerror = () => rejectOnce(request.error ?? new Error('Fairness reservation recovery failed'));
        transaction.oncomplete = resolveOnce;
        transaction.onerror = () =>
          rejectOnce(transaction.error ?? new Error('Fairness reservation recovery transaction failed'));
        transaction.onabort = () =>
          rejectOnce(transaction.error ?? new Error('Fairness reservation recovery transaction aborted'));
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  async replace(events: readonly FairnessEvent[], profileId = DEFAULT_FAIRNESS_PROFILE_ID): Promise<void> {
    const checked = events.map((event) => validateFairnessEvent(event));
    const scopedProfileId = profileIdOrDefault(profileId);
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction([EVENT_STORE_NAME, RESERVATION_STORE_NAME], 'readwrite');
        const eventStore = transaction.objectStore(EVENT_STORE_NAME);
        const reservationStore = transaction.objectStore(RESERVATION_STORE_NAME);
        const eventRecordsRequest = eventStore.getAll();
        const reservationRecordsRequest = reservationStore.getAll();
        let eventRecords: StoredFairnessEvent[] | null = null;
        let reservationRecords: unknown[] | null = null;
        const commit = (): void => {
          if (!eventRecords || !reservationRecords) return;
          eventRecords.forEach((record) => {
            if (
              !isHistoryMetadata(record) &&
              record &&
              typeof record === 'object' &&
              profileMatches(record, scopedProfileId) &&
              record.sequence !== undefined
            ) {
              eventStore.delete(record.sequence);
            }
          });
          reservationRecords.forEach((record) => {
            if (profileMatches(record, scopedProfileId) && record && typeof record === 'object') {
              const reservationId = (record as { reservationId?: unknown }).reservationId;
              if (typeof reservationId === 'string') reservationStore.delete(reservationId);
            }
          });
          withNextHistoryRevision(eventStore, scopedProfileId, (_revision, metadata) => {
            eventStore.put(metadata);
            checked.forEach((event) =>
              eventStore.add({ event, profileId: scopedProfileId } satisfies StoredFairnessEvent)
            );
          });
        };
        eventRecordsRequest.onsuccess = () => {
          eventRecords = eventRecordsRequest.result as StoredFairnessEvent[];
          commit();
        };
        reservationRecordsRequest.onsuccess = () => {
          reservationRecords = reservationRecordsRequest.result as unknown[];
          commit();
        };
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Fairness storage transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Fairness storage transaction aborted'));
    });
  }

  async clear(profileId = DEFAULT_FAIRNESS_PROFILE_ID): Promise<void> {
    const scopedProfileId = profileIdOrDefault(profileId);
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction([EVENT_STORE_NAME, RESERVATION_STORE_NAME], 'readwrite');
        const eventStore = transaction.objectStore(EVENT_STORE_NAME);
        const reservationStore = transaction.objectStore(RESERVATION_STORE_NAME);
        const eventRecordsRequest = eventStore.getAll();
        const reservationRecordsRequest = reservationStore.getAll();
        let eventRecords: StoredFairnessEvent[] | null = null;
        let reservationRecords: unknown[] | null = null;
        const commit = (): void => {
          if (!eventRecords || !reservationRecords) return;
          eventRecords.forEach((record) => {
            if (
              !isHistoryMetadata(record) &&
              record &&
              typeof record === 'object' &&
              profileMatches(record, scopedProfileId) &&
              record.sequence !== undefined
            ) {
              eventStore.delete(record.sequence);
            }
          });
          reservationRecords.forEach((record) => {
            if (profileMatches(record, scopedProfileId) && record && typeof record === 'object') {
              const reservationId = (record as { reservationId?: unknown }).reservationId;
              if (typeof reservationId === 'string') reservationStore.delete(reservationId);
            }
          });
          withNextHistoryRevision(eventStore, scopedProfileId, (_revision, metadata) => {
            eventStore.put(metadata);
          });
        };
        eventRecordsRequest.onsuccess = () => {
          eventRecords = eventRecordsRequest.result as StoredFairnessEvent[];
          commit();
        };
        reservationRecordsRequest.onsuccess = () => {
          reservationRecords = reservationRecordsRequest.result as unknown[];
          commit();
        };
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Fairness storage transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Fairness storage transaction aborted'));
    });
  }
}

/** Small deterministic store useful for pure orchestration tests and host integrations. */
export class InMemoryFairnessStore implements FairnessEventStore {
  private events = new Map<string, FairnessEvent[]>();
  private reservations = new Map<string, FairnessReservationRecord>();
  private historyRevision = new Map<string, number>();
  private profiles = new Map<string, FairnessProfile>();

  constructor(initialEvents: readonly FairnessEvent[] = []) {
    this.profiles.set(DEFAULT_FAIRNESS_PROFILE_ID, {
      id: DEFAULT_FAIRNESS_PROFILE_ID,
      name: DEFAULT_FAIRNESS_PROFILE_NAME,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    this.events.set(DEFAULT_FAIRNESS_PROFILE_ID, initialEvents.map((event) => validateFairnessEvent(event)));
    this.historyRevision.set(DEFAULT_FAIRNESS_PROFILE_ID, 0);
  }

  async load(profileId = DEFAULT_FAIRNESS_PROFILE_ID): Promise<FairnessEvent[]> {
    return clone(this.events.get(profileIdOrDefault(profileId)) ?? []);
  }

  async loadHistoryStamp(profileId = DEFAULT_FAIRNESS_PROFILE_ID): Promise<FairnessHistoryStamp> {
    const events = this.events.get(profileIdOrDefault(profileId)) ?? [];
    return {
      revision: this.historyRevision.get(profileIdOrDefault(profileId)) ?? 0,
      eventCount: events.length,
      tailEventId: events[events.length - 1]?.eventId ?? null,
    };
  }

  async loadProfiles(): Promise<FairnessProfile[]> {
    return clone([...this.profiles.values()].sort(profileOrder));
  }

  async saveProfile(profile: FairnessProfile): Promise<void> {
    this.profiles.set(profile.id, clone(profile));
    if (!this.events.has(profile.id)) this.events.set(profile.id, []);
    if (!this.historyRevision.has(profile.id)) this.historyRevision.set(profile.id, 0);
  }

  async loadReservations(profileId = DEFAULT_FAIRNESS_PROFILE_ID): Promise<FairnessReservationRecord[]> {
    const scopedProfileId = profileIdOrDefault(profileId);
    return clone([...this.reservations.values()].filter((reservation) => reservation.profileId === scopedProfileId));
  }

  async hasQuarantinedClaimedReservations(): Promise<boolean> {
    return false;
  }

  async append(event: FairnessEvent, profileId = DEFAULT_FAIRNESS_PROFILE_ID): Promise<void> {
    const scopedProfileId = profileIdOrDefault(profileId);
    const events = this.events.get(scopedProfileId) ?? [];
    events.push(validateFairnessEvent(event));
    this.events.set(scopedProfileId, events);
    this.historyRevision.set(scopedProfileId, (this.historyRevision.get(scopedProfileId) ?? 0) + 1);
  }

  async reserve(reservation: FairnessReservationRecord): Promise<void> {
    const checked = validateReservation(reservation);
    this.reservations.set(checked.reservationId, clone(checked));
  }

  async removeReservation(reservationId: string): Promise<void> {
    this.reservations.delete(reservationId);
  }

  async discardInvalidReadyReservation(
    reservationId: string
  ): Promise<FairnessInvalidReservationDiscardResult> {
    const stored = this.reservations.get(reservationId);
    if (!stored) return 'missing';
    try {
      validateReservation(stored);
      return 'valid';
    } catch {
      if (stored && typeof stored === 'object' && stored.state === 'claimed') return 'claimed';
      this.reservations.delete(reservationId);
      return 'discarded';
    }
  }

  async discardReadyReservation(
    reservationId: string,
    expected: FairnessReservationIdentity
  ): Promise<FairnessReservationDiscardResult> {
    const stored = this.reservations.get(reservationId);
    if (!stored) return 'missing';
    const reservation = validateReservation(stored);
    if (!sameReservationIdentity(reservation, expected)) return 'mismatch';
    if (reservation.state === 'claimed') return 'claimed';
    this.reservations.delete(reservationId);
    return 'discarded';
  }

  async claimReservation(
    reservationId: string,
    expected: FairnessReservationIdentity
  ): Promise<FairnessReservationClaimResult> {
    const stored = this.reservations.get(reservationId);
    if (!stored) return 'missing';
    const reservation = validateReservation(stored);
    if (!sameReservationIdentity(reservation, expected)) return 'mismatch';
    if (reservation.state === 'claimed') return 'already-claimed';
    this.reservations.set(
      reservationId,
      clone({ ...reservation, state: 'claimed', claimedAt: Date.now() })
    );
    return 'claimed';
  }

  async finalizeReservation(
    reservationId: string,
    preparedEvent: FairnessDrawPreparedEvent,
    terminalEvent: FairnessReservationTerminalEvent,
    expected?: FairnessReservationIdentity
  ): Promise<void> {
    const checked = validateReservationEvents(preparedEvent, terminalEvent);
    const reservation = this.reservations.get(reservationId);
    if (
      !reservation ||
      reservation.state !== 'claimed' ||
      (expected && !sameReservationIdentity(reservation, expected)) ||
      reservation.drawId !== checked.preparedEvent.drawId ||
      reservation.seed !== checked.preparedEvent.seed
    ) {
      throw new Error('Fairness reservation claim identity is invalid');
    }
    const events = this.events.get(reservation.profileId) ?? [];
    this.events.set(reservation.profileId, [...events, checked.preparedEvent, checked.terminalEvent]);
    this.historyRevision.set(reservation.profileId, (this.historyRevision.get(reservation.profileId) ?? 0) + 1);
    this.reservations.delete(reservationId);
  }

  async recoverClaimedReservation(
    reservationId: string,
    preparedEvent: FairnessDrawPreparedEvent | null,
    terminalEvent: FairnessDrawCancelledEvent,
    expected?: FairnessReservationIdentity
  ): Promise<void> {
    const checkedTerminal = validateFairnessEvent(terminalEvent);
    if (checkedTerminal.type !== 'drawCancelled') throw new Error('Fairness recovery event is invalid');
    const checkedPrepared = preparedEvent ? validateFairnessEvent(preparedEvent) : null;
    if (checkedPrepared && checkedPrepared.type !== 'drawPrepared') {
      throw new Error('Fairness recovery prepared event is invalid');
    }
    if (checkedPrepared && checkedPrepared.drawId !== checkedTerminal.drawId) {
      throw new Error('Fairness recovery identity is invalid');
    }
    const reservation = this.reservations.get(reservationId);
    if (
      !reservation ||
      (expected && !sameReservationIdentity(reservation, expected)) ||
      reservation.drawId !== checkedTerminal.drawId ||
      (checkedPrepared && reservation.seed !== checkedPrepared.seed)
    ) {
      throw new Error('Fairness reservation recovery identity is invalid');
    }
    if (checkedPrepared && reservation.state !== 'claimed') {
      throw new Error('Fairness reservation recovery state is invalid');
    }
    const events = this.events.get(reservation.profileId) ?? [];
    this.events.set(
      reservation.profileId,
      [...events, ...(checkedPrepared ? [checkedPrepared] : []), checkedTerminal]
    );
    this.historyRevision.set(reservation.profileId, (this.historyRevision.get(reservation.profileId) ?? 0) + 1);
    this.reservations.delete(reservationId);
  }

  async replace(events: readonly FairnessEvent[], profileId = DEFAULT_FAIRNESS_PROFILE_ID): Promise<void> {
    const scopedProfileId = profileIdOrDefault(profileId);
    this.events.set(scopedProfileId, events.map((event) => validateFairnessEvent(event)));
    this.historyRevision.set(scopedProfileId, (this.historyRevision.get(scopedProfileId) ?? 0) + 1);
    [...this.reservations.values()]
      .filter((reservation) => reservation.profileId === scopedProfileId)
      .forEach((reservation) => this.reservations.delete(reservation.reservationId));
  }

  async clear(profileId = DEFAULT_FAIRNESS_PROFILE_ID): Promise<void> {
    const scopedProfileId = profileIdOrDefault(profileId);
    this.events.set(scopedProfileId, []);
    this.historyRevision.set(scopedProfileId, (this.historyRevision.get(scopedProfileId) ?? 0) + 1);
    [...this.reservations.values()]
      .filter((reservation) => reservation.profileId === scopedProfileId)
      .forEach((reservation) => this.reservations.delete(reservation.reservationId));
  }
}

export class FairnessStore extends IndexedDbFairnessStore {}
