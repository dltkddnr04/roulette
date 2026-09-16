import { FAIRNESS_DATA_VERSION, type FairnessEvent, validateFairnessEvent, validateFairnessExport } from './fairness';
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
  draft: unknown;
}>;

export interface FairnessEventStore {
  load(): Promise<FairnessEvent[]>;
  append(event: FairnessEvent): Promise<void>;
  replace(events: readonly FairnessEvent[]): Promise<void>;
  clear(): Promise<void>;
  loadReservations?(): Promise<FairnessReservationRecord[]>;
  reserve?(reservation: FairnessReservationRecord): Promise<void>;
  removeReservation?(reservationId: string): Promise<void>;
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
  return {
    reservationId: candidate.reservationId,
    drawId: candidate.drawId,
    key: candidate.key,
    seed: candidate.seed,
    winnerMarbleIds: [...candidate.winnerMarbleIds],
    winnerEntryIds: [...candidate.winnerEntryIds],
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
