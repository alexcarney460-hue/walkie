// The phone's pairing, in IndexedDB (WALKIE-PWA-1): the device id, its room, the relay, and the device key as
// a non-extractable CryptoKey (IndexedDB stores CryptoKey objects as they are, so the raw key never reaches script
// again after pairing). Without IndexedDB (a private window) the pairing lasts only until the page closes.
export interface StoredDevice {
  readonly id: string;
  readonly name: string;
  readonly room: string;
  readonly relay: string;
  readonly key: CryptoKey;
  readonly expires_at: number;
  /** Who this pairing is with (shown before a new pairing replaces it). */
  readonly team?: { id: string; name: string };
  readonly handle?: string;
  readonly host?: string;
}

const DB = "walkie-mobile";
const STORE = "device";
const SLOT = "current";

let memory: StoredDevice | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB unavailable"));
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result as T);
      t.onerror = () => reject(t.error ?? new Error("indexedDB error"));
      t.onabort = () => reject(t.error ?? new Error("indexedDB aborted"));
    });
  } finally {
    db.close();
  }
}

export async function loadDevice(): Promise<StoredDevice | null> {
  try {
    const d = await tx<StoredDevice | undefined>("readonly", (s) => s.get(SLOT));
    return d && d.key instanceof CryptoKey ? d : memory;
  } catch {
    return memory;
  }
}

export async function saveDevice(d: StoredDevice): Promise<boolean> {
  memory = d;
  try {
    await tx("readwrite", (s) => s.put(d, SLOT));
    return true;
  } catch {
    return false; // kept in memory for this visit only
  }
}

export async function forgetDevice(): Promise<void> {
  memory = null;
  try { await tx("readwrite", (s) => s.delete(SLOT)); } catch { /* nothing stored */ }
}
