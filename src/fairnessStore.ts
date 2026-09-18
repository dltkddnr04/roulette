import {
  FAIRNESS_DATA_VERSION,
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
  load(): Promise<FairnessEvent[]>;
  loadHistoryStamp?(): Promise<FairnessHistoryStamp>;
  append(event: FairnessEvent): Promise<void>;
  replace(events: readonly FairnessEvent[]): Promise<void>;
  clear(): Promise<void>;
  loadReservations?(): Promise<FairnessReservationRecord[]>;
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
  event: FairnessEvent;
};

const DATABASE_NAME = 'marble-roulette-fairness-v1';
const DATABASE_VERSION = 2;
const EVENT_STORE_NAME = 'events';
const RESERVATION_STORE_NAME = 'reservations';
// Keep the history revision in the existing event store so the freshness
// protocol does not require a version-3 upgrade that can be blocked by a live
// version-2 tab. The reserved negative key is never produced by the event
// store's auto-increment key generator and is filtered from the public log.
const HISTORY_METADATA_SEQUENCE = -1;

type StoredHistoryMetadata = {
  sequence: typeof HISTORY_METADATA_SEQUENCE;
  kind: 'history-metadata';
  revision: number;
};

function isHistoryMetadata(value: unknown): value is StoredHistoryMetadata {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { sequence?: unknown }).sequence === HISTORY_METADATA_SEQUENCE &&
    (value as { kind?: unknown }).kind === 'history-metadata'
  );
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

function withNextHistoryRevision(store: IDBObjectStore, callback: (revision: number) => void): void {
  const request = store.get(HISTORY_METADATA_SEQUENCE);
  request.onsuccess = () => {
    const revision = readHistoryRevision(request.result) + 1;
    callback(revision);
  };
}

function validateReservation(value: unknown): FairnessReservationRecord {
  if (!value || typeof value !== 'object') throw new Error('Fairness reservation is corrupt');
  const candidate = value as Partial<FairnessReservationRecord>;
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

  async load(): Promise<FairnessEvent[]> {
    const records = await this.request<StoredFairnessEvent[]>('readonly', (store) => store.getAll());
    const events = records.map((record) => {
      if (isHistoryMetadata(record)) return null;
      if (!record || typeof record !== 'object' || !record.event) throw new Error('Fairness storage is corrupt');
      const event = validateFairnessEvent(record.event);
      if (event.version !== FAIRNESS_DATA_VERSION) throw new Error('Fairness storage version is unsupported');
      return event;
    }).filter((event): event is FairnessEvent => event !== null);
    return [...validateFairnessExport({ version: FAIRNESS_DATA_VERSION, mode: 'simple', events }).events];
  }

  async loadHistoryStamp(): Promise<FairnessHistoryStamp> {
    const database = await this.open();
    return new Promise<FairnessHistoryStamp>((resolve, reject) => {
      let transaction: IDBTransaction;
      let storedRecordCount = 0;
      let tailEventId: string | null = null;
      let revision = 0;
      let hasMetadata = false;
      try {
        transaction = database.transaction(EVENT_STORE_NAME, 'readonly');
        const eventStore = transaction.objectStore(EVENT_STORE_NAME);
        const countRequest = eventStore.count();
        const tailRequest = eventStore.openCursor(null, 'prev');
        const metadataRequest = eventStore.get(HISTORY_METADATA_SEQUENCE);
        countRequest.onsuccess = () => {
          storedRecordCount = countRequest.result;
        };
        tailRequest.onsuccess = () => {
          const record = tailRequest.result?.value as StoredFairnessEvent | undefined;
          if (isHistoryMetadata(record)) {
            tailRequest.result?.continue();
            return;
          }
          const eventId = record?.event && typeof record.event.eventId === 'string' ? record.event.eventId : null;
          tailEventId = eventId;
        };
        metadataRequest.onsuccess = () => {
          hasMetadata = isHistoryMetadata(metadataRequest.result);
          revision = readHistoryRevision(metadataRequest.result);
        };
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () =>
        resolve({ revision, eventCount: Math.max(0, storedRecordCount - (hasMetadata ? 1 : 0)), tailEventId });
      transaction.onerror = () => reject(transaction.error ?? new Error('Fairness history stamp failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Fairness history stamp aborted'));
    });
  }

  async loadReservations(): Promise<FairnessReservationRecord[]> {
    this.quarantinedClaimedReservationCount = 0;
    const records = await this.request<unknown[]>('readonly', (store) => store.getAll(), RESERVATION_STORE_NAME);
    const reservations: FairnessReservationRecord[] = [];
    const invalidReadyReservationIds: string[] = [];
    records.forEach((record) => {
      try {
        reservations.push(validateReservation(record));
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

  async hasQuarantinedClaimedReservations(): Promise<boolean> {
    return this.quarantinedClaimedReservationCount > 0;
  }

  async append(event: FairnessEvent): Promise<void> {
    const checked = validateFairnessEvent(event);
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(EVENT_STORE_NAME, 'readwrite');
        const eventStore = transaction.objectStore(EVENT_STORE_NAME);
        withNextHistoryRevision(eventStore, (revision) => {
          eventStore.put({
            sequence: HISTORY_METADATA_SEQUENCE,
            kind: 'history-metadata',
            revision,
          } satisfies StoredHistoryMetadata);
          eventStore.add({ event: checked } satisfies StoredFairnessEvent);
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
            eventStore.add({ event: checked.preparedEvent } satisfies StoredFairnessEvent);
            eventStore.add({ event: checked.terminalEvent } satisfies StoredFairnessEvent);
            reservationStore.delete(reservationId);
            withNextHistoryRevision(eventStore, (revision) => {
              eventStore.put({
                sequence: HISTORY_METADATA_SEQUENCE,
                kind: 'history-metadata',
                revision,
              } satisfies StoredHistoryMetadata);
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
            if (checkedPrepared) eventStore.add({ event: checkedPrepared } satisfies StoredFairnessEvent);
            eventStore.add({ event: checkedTerminal } satisfies StoredFairnessEvent);
            reservationStore.delete(reservationId);
            withNextHistoryRevision(eventStore, (revision) => {
              eventStore.put({
                sequence: HISTORY_METADATA_SEQUENCE,
                kind: 'history-metadata',
                revision,
              } satisfies StoredHistoryMetadata);
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

  async replace(events: readonly FairnessEvent[]): Promise<void> {
    const checked = events.map((event) => validateFairnessEvent(event));
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction([EVENT_STORE_NAME, RESERVATION_STORE_NAME], 'readwrite');
        const eventStore = transaction.objectStore(EVENT_STORE_NAME);
        transaction.objectStore(RESERVATION_STORE_NAME).clear();
        withNextHistoryRevision(eventStore, (revision) => {
          eventStore.clear();
          eventStore.put({
            sequence: HISTORY_METADATA_SEQUENCE,
            kind: 'history-metadata',
            revision,
          } satisfies StoredHistoryMetadata);
          checked.forEach((event) => eventStore.add({ event } satisfies StoredFairnessEvent));
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

  async clear(): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction([EVENT_STORE_NAME, RESERVATION_STORE_NAME], 'readwrite');
        const eventStore = transaction.objectStore(EVENT_STORE_NAME);
        transaction.objectStore(RESERVATION_STORE_NAME).clear();
        withNextHistoryRevision(eventStore, (revision) => {
          eventStore.clear();
          eventStore.put({
            sequence: HISTORY_METADATA_SEQUENCE,
            kind: 'history-metadata',
            revision,
          } satisfies StoredHistoryMetadata);
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
}

/** Small deterministic store useful for pure orchestration tests and host integrations. */
export class InMemoryFairnessStore implements FairnessEventStore {
  private events: FairnessEvent[];
  private reservations = new Map<string, FairnessReservationRecord>();
  private historyRevision = 0;

  constructor(initialEvents: readonly FairnessEvent[] = []) {
    this.events = initialEvents.map((event) => validateFairnessEvent(event));
  }

  async load(): Promise<FairnessEvent[]> {
    return clone(this.events);
  }

  async loadHistoryStamp(): Promise<FairnessHistoryStamp> {
    return {
      revision: this.historyRevision,
      eventCount: this.events.length,
      tailEventId: this.events[this.events.length - 1]?.eventId ?? null,
    };
  }

  async loadReservations(): Promise<FairnessReservationRecord[]> {
    return clone([...this.reservations.values()]);
  }

  async hasQuarantinedClaimedReservations(): Promise<boolean> {
    return false;
  }

  async append(event: FairnessEvent): Promise<void> {
    this.events.push(validateFairnessEvent(event));
    this.historyRevision += 1;
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
    const nextEvents = [...this.events, checked.preparedEvent, checked.terminalEvent];
    this.events = nextEvents;
    this.historyRevision += 1;
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
    this.events = [...this.events, ...(checkedPrepared ? [checkedPrepared] : []), checkedTerminal];
    this.historyRevision += 1;
    this.reservations.delete(reservationId);
  }

  async replace(events: readonly FairnessEvent[]): Promise<void> {
    this.events = events.map((event) => validateFairnessEvent(event));
    this.historyRevision += 1;
    this.reservations.clear();
  }

  async clear(): Promise<void> {
    this.events = [];
    this.historyRevision += 1;
    this.reservations.clear();
  }
}

export class FairnessStore extends IndexedDbFairnessStore {}
