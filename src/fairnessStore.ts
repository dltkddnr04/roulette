import { FAIRNESS_DATA_VERSION, type FairnessEvent, validateFairnessEvent, validateFairnessExport } from './fairness';

export interface FairnessEventStore {
  load(): Promise<FairnessEvent[]>;
  append(event: FairnessEvent): Promise<void>;
  replace(events: readonly FairnessEvent[]): Promise<void>;
  clear(): Promise<void>;
}

type StoredFairnessEvent = {
  sequence?: number;
  event: FairnessEvent;
};

const DATABASE_NAME = 'marble-roulette-fairness-v1';
const DATABASE_VERSION = 1;
const EVENT_STORE_NAME = 'events';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function storageUnavailable(): Error {
  return new Error('Fairness storage is unavailable');
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

  private request<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return this.open().then(
      (database) =>
        new Promise<T>((resolve, reject) => {
          let transaction: IDBTransaction;
          let request: IDBRequest<T>;
          try {
            transaction = database.transaction(EVENT_STORE_NAME, mode);
            request = operation(transaction.objectStore(EVENT_STORE_NAME));
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

  async append(event: FairnessEvent): Promise<void> {
    const checked = validateFairnessEvent(event);
    await this.request<IDBValidKey>('readwrite', (store) =>
      store.add({ event: checked } satisfies StoredFairnessEvent)
    );
  }

  async replace(events: readonly FairnessEvent[]): Promise<void> {
    const checked = events.map((event) => validateFairnessEvent(event));
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(EVENT_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(EVENT_STORE_NAME);
        store.clear();
        checked.forEach((event) => store.add({ event } satisfies StoredFairnessEvent));
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
    await this.request<undefined>('readwrite', (store) => store.clear());
  }
}

/** Small deterministic store useful for pure orchestration tests and host integrations. */
export class InMemoryFairnessStore implements FairnessEventStore {
  private events: FairnessEvent[];

  constructor(initialEvents: readonly FairnessEvent[] = []) {
    this.events = initialEvents.map((event) => validateFairnessEvent(event));
  }

  async load(): Promise<FairnessEvent[]> {
    return clone(this.events);
  }

  async append(event: FairnessEvent): Promise<void> {
    this.events.push(validateFairnessEvent(event));
  }

  async replace(events: readonly FairnessEvent[]): Promise<void> {
    this.events = events.map((event) => validateFairnessEvent(event));
  }

  async clear(): Promise<void> {
    this.events = [];
  }
}

export class FairnessStore extends IndexedDbFairnessStore {}
