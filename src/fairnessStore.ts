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

export type FairnessReservationTerminalEvent =
  | FairnessDrawConfirmedEvent
  | FairnessDrawFailedEvent
  | FairnessDrawCancelledEvent;

export interface FairnessEventStore {
  load(): Promise<FairnessEvent[]>;
  append(event: FairnessEvent): Promise<void>;
  replace(events: readonly FairnessEvent[]): Promise<void>;
  clear(): Promise<void>;
  loadReservations?(): Promise<FairnessReservationRecord[]>;
  reserve?(reservation: FairnessReservationRecord): Promise<void>;
  removeReservation?(reservationId: string): Promise<void>;
  claimReservation?(
    reservationId: string,
    expected: FairnessReservationIdentity
  ): Promise<FairnessReservationClaimResult>;
  finalizeReservation?(
    reservationId: string,
    preparedEvent: FairnessDrawPreparedEvent,
    terminalEvent: FairnessReservationTerminalEvent
  ): Promise<void>;
  recoverClaimedReservation?(
    reservationId: string,
    preparedEvent: FairnessDrawPreparedEvent | null,
    terminalEvent: FairnessDrawCancelledEvent
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
      request.onsuccess = () => resolve(request.result);
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
      if (!record || typeof record !== 'object' || !record.event) throw new Error('Fairness storage is corrupt');
      const event = validateFairnessEvent(record.event);
      if (event.version !== FAIRNESS_DATA_VERSION) throw new Error('Fairness storage version is unsupported');
      return event;
    });
    return [...validateFairnessExport({ version: FAIRNESS_DATA_VERSION, mode: 'simple', events }).events];
  }

  async loadReservations(): Promise<FairnessReservationRecord[]> {
    const records = await this.request<unknown[]>('readonly', (store) => store.getAll(), RESERVATION_STORE_NAME);
    return records.map((record) => validateReservation(record));
  }

  async append(event: FairnessEvent): Promise<void> {
    const checked = validateFairnessEvent(event);
    await this.request<IDBValidKey>('readwrite', (store) =>
      store.add({ event: checked } satisfies StoredFairnessEvent)
    );
  }

  async reserve(reservation: FairnessReservationRecord): Promise<void> {
    const checked = validateReservation(reservation);
    await this.request<IDBValidKey>('readwrite', (store) => store.put(checked), RESERVATION_STORE_NAME);
  }

  async removeReservation(reservationId: string): Promise<void> {
    await this.request<undefined>('readwrite', (store) => store.delete(reservationId), RESERVATION_STORE_NAME);
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
    terminalEvent: FairnessReservationTerminalEvent
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
              reservation.drawId !== checked.preparedEvent.drawId ||
              reservation.seed !== checked.preparedEvent.seed
            ) {
              throw new Error('Fairness reservation claim identity is invalid');
            }
            eventStore.add({ event: checked.preparedEvent } satisfies StoredFairnessEvent);
            eventStore.add({ event: checked.terminalEvent } satisfies StoredFairnessEvent);
            reservationStore.delete(reservationId);
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
    terminalEvent: FairnessDrawCancelledEvent
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
              reservation.drawId !== checkedTerminal.drawId ||
              (checkedPrepared && reservation.state !== 'claimed')
            ) {
              throw new Error('Fairness reservation recovery identity is invalid');
            }
            if (checkedPrepared) eventStore.add({ event: checkedPrepared } satisfies StoredFairnessEvent);
            eventStore.add({ event: checkedTerminal } satisfies StoredFairnessEvent);
            reservationStore.delete(reservationId);
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
        eventStore.clear();
        checked.forEach((event) => eventStore.add({ event } satisfies StoredFairnessEvent));
        transaction.objectStore(RESERVATION_STORE_NAME).clear();
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
        transaction.objectStore(EVENT_STORE_NAME).clear();
        transaction.objectStore(RESERVATION_STORE_NAME).clear();
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

  constructor(initialEvents: readonly FairnessEvent[] = []) {
    this.events = initialEvents.map((event) => validateFairnessEvent(event));
  }

  async load(): Promise<FairnessEvent[]> {
    return clone(this.events);
  }

  async loadReservations(): Promise<FairnessReservationRecord[]> {
    return clone([...this.reservations.values()]);
  }

  async append(event: FairnessEvent): Promise<void> {
    this.events.push(validateFairnessEvent(event));
  }

  async reserve(reservation: FairnessReservationRecord): Promise<void> {
    const checked = validateReservation(reservation);
    this.reservations.set(checked.reservationId, clone(checked));
  }

  async removeReservation(reservationId: string): Promise<void> {
    this.reservations.delete(reservationId);
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
    terminalEvent: FairnessReservationTerminalEvent
  ): Promise<void> {
    const checked = validateReservationEvents(preparedEvent, terminalEvent);
    const reservation = this.reservations.get(reservationId);
    if (
      !reservation ||
      reservation.state !== 'claimed' ||
      reservation.drawId !== checked.preparedEvent.drawId ||
      reservation.seed !== checked.preparedEvent.seed
    ) {
      throw new Error('Fairness reservation claim identity is invalid');
    }
    const nextEvents = [...this.events, checked.preparedEvent, checked.terminalEvent];
    this.events = nextEvents;
    this.reservations.delete(reservationId);
  }

  async recoverClaimedReservation(
    reservationId: string,
    preparedEvent: FairnessDrawPreparedEvent | null,
    terminalEvent: FairnessDrawCancelledEvent
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
    if (!reservation || reservation.drawId !== checkedTerminal.drawId) {
      throw new Error('Fairness reservation recovery identity is invalid');
    }
    if (checkedPrepared && reservation.state !== 'claimed') {
      throw new Error('Fairness reservation recovery state is invalid');
    }
    this.events = [...this.events, ...(checkedPrepared ? [checkedPrepared] : []), checkedTerminal];
    this.reservations.delete(reservationId);
  }

  async replace(events: readonly FairnessEvent[]): Promise<void> {
    this.events = events.map((event) => validateFairnessEvent(event));
    this.reservations.clear();
  }

  async clear(): Promise<void> {
    this.events = [];
    this.reservations.clear();
  }
}

export class FairnessStore extends IndexedDbFairnessStore {}
