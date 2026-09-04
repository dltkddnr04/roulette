export type SponsorAsset = {
  id: string;
  name: string;
  blob: Blob;
  createdAt: number;
};

export type SponsorAssetInfo = Pick<SponsorAsset, 'id' | 'name' | 'createdAt'>;

export type SponsorSettings = {
  enabled: boolean;
  selectedAssetId: string | null;
};

export type SponsorState = SponsorSettings & {
  assets: SponsorAssetInfo[];
};

import { readLocalStorage, writeLocalStorage } from './utils/storage';

const DATABASE_NAME = 'marble-roulette-sponsors';
const DATABASE_VERSION = 1;
const ASSET_STORE_NAME = 'assets';
const SETTINGS_STORAGE_KEY = 'mbr_sponsor_settings';

class SponsorStorage {
  private databasePromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;

    const databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not supported'));
        return;
      }

      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(ASSET_STORE_NAME)) {
          request.result.createObjectStore(ASSET_STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Failed to open sponsor storage'));
    }).catch((error) => {
      this.databasePromise = null;
      throw error;
    });

    this.databasePromise = databasePromise;
    return databasePromise;
  }

  private async request<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await this.open();

    return new Promise((resolve, reject) => {
      try {
        const transaction = database.transaction(ASSET_STORE_NAME, mode);
        const request = operation(transaction.objectStore(ASSET_STORE_NAME));
        let result!: T;
        let requestCompleted = false;
        request.onsuccess = () => {
          result = request.result;
          requestCompleted = true;
        };
        request.onerror = () => reject(request.error ?? new Error('Sponsor storage request failed'));
        transaction.oncomplete = () => {
          if (requestCompleted) resolve(result);
        };
        transaction.onerror = () => reject(transaction.error ?? new Error('Sponsor storage transaction failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Sponsor storage transaction aborted'));
      } catch (error) {
        reject(error);
      }
    });
  }

  listAssets(): Promise<SponsorAsset[]> {
    return this.request('readonly', (store) => store.getAll());
  }

  putAsset(asset: SponsorAsset): Promise<IDBValidKey> {
    return this.request('readwrite', (store) => store.put(asset));
  }

  deleteAsset(id: string): Promise<undefined> {
    return this.request('readwrite', (store) => store.delete(id));
  }
}

export class SponsorManager {
  private readonly storage = new SponsorStorage();
  private readonly readyPromise: Promise<void>;
  private settings: SponsorSettings = { enabled: false, selectedAssetId: null };
  private assets: SponsorAsset[] = [];
  private image: HTMLImageElement | null = null;
  private imageObjectUrl: string | null = null;
  private imageLoadVersion = 0;

  constructor() {
    this.readyPromise = this.initialize();
  }

  get renderImage(): HTMLImageElement | null {
    return this.settings.enabled ? this.image : null;
  }

  async getState(): Promise<SponsorState> {
    await this.readyPromise;
    return {
      ...this.settings,
      assets: this.assets.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
    };
  }

  async addAsset(file: File): Promise<SponsorAssetInfo> {
    await this.readyPromise;
    if (!file || file.size <= 0) throw new Error('Sponsor image is empty');

    const asset: SponsorAsset = {
      id: this.createId(),
      name: file.name || 'Sponsor',
      blob: file,
      createdAt: Date.now(),
    };
    await this.storage.putAsset(asset);
    this.assets.push(asset);
    this.sortAssets();

    if (!this.settings.selectedAssetId) {
      this.settings.selectedAssetId = asset.id;
      this.saveSettings();
      await this.loadSelectedImage();
    }

    return { id: asset.id, name: asset.name, createdAt: asset.createdAt };
  }

  async selectAsset(assetId: string | null): Promise<void> {
    await this.readyPromise;
    const asset = assetId ? this.assets.find((candidate) => candidate.id === assetId) : undefined;
    this.settings.selectedAssetId = asset?.id ?? null;
    this.saveSettings();
    await this.loadSelectedImage();
  }

  async deleteAsset(assetId: string): Promise<void> {
    await this.readyPromise;
    const asset = this.assets.find((candidate) => candidate.id === assetId);
    if (!asset) return;

    await this.storage.deleteAsset(assetId);
    this.assets = this.assets.filter((candidate) => candidate.id !== assetId);
    if (this.settings.selectedAssetId === assetId) {
      this.settings.selectedAssetId = null;
      this.saveSettings();
      await this.loadSelectedImage();
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.readyPromise;
    this.settings.enabled = enabled === true;
    this.saveSettings();
  }

  private async initialize(): Promise<void> {
    this.settings = this.loadSettings();

    try {
      this.assets = await this.storage.listAssets();
      this.sortAssets();
    } catch (error) {
      console.warn('Sponsor storage unavailable', error);
      this.assets = [];
    }

    if (this.settings.selectedAssetId && !this.assets.some((asset) => asset.id === this.settings.selectedAssetId)) {
      this.settings.selectedAssetId = null;
      this.saveSettings();
    }

    await this.loadSelectedImage();
  }

  private async loadSelectedImage(): Promise<void> {
    const loadVersion = ++this.imageLoadVersion;
    this.clearImage();

    const selectedAsset = this.assets.find((asset) => asset.id === this.settings.selectedAssetId);
    if (!selectedAsset) return;

    let objectUrl: string | null = null;
    try {
      objectUrl = URL.createObjectURL(selectedAsset.blob);
      const image = await this.loadImage(objectUrl);
      if (loadVersion !== this.imageLoadVersion) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      this.image = image;
      this.imageObjectUrl = objectUrl;
    } catch (error) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      console.warn(`Sponsor image unavailable: ${selectedAsset.name}`, error);
    }
  }

  private loadImage(objectUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.addEventListener('load', () => resolve(image));
      image.addEventListener('error', () => reject(new Error('Failed to load sponsor image')));
      image.src = objectUrl;
    });
  }

  private clearImage(): void {
    if (this.imageObjectUrl) URL.revokeObjectURL(this.imageObjectUrl);
    this.imageObjectUrl = null;
    this.image = null;
  }

  private sortAssets(): void {
    this.assets.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  private createId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  private loadSettings(): SponsorSettings {
    try {
      const value = readLocalStorage(SETTINGS_STORAGE_KEY);
      if (!value) return { enabled: false, selectedAssetId: null };
      const parsed = JSON.parse(value) as { enabled?: unknown; selectedAssetId?: unknown };
      return {
        enabled: parsed.enabled === true,
        selectedAssetId: typeof parsed.selectedAssetId === 'string' ? parsed.selectedAssetId : null,
      };
    } catch {
      return { enabled: false, selectedAssetId: null };
    }
  }

  private saveSettings(): void {
    writeLocalStorage(SETTINGS_STORAGE_KEY, JSON.stringify(this.settings));
  }
}
