export function readLocalStorage(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocalStorage(key: string, value: string): boolean {
  try {
    if (typeof window === 'undefined') return false;
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function readSessionStorage(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSessionStorage(key: string, value: string): boolean {
  try {
    if (typeof window === 'undefined') return false;
    window.sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
