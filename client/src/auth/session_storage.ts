// Session-storage shim for the OIDC PKCE verifier + state.
//
// The verifier and state must survive the redirect to the OP and back, but
// must NOT outlive a tab close — that's exactly the contract of
// window.sessionStorage. In tests we fall back to an in-memory Map shimmed
// onto globalThis.sessionStorage, so the same module works under jsdom or
// plain Node.

const KEY_VERIFIER = 'kitp_oidc_verifier';
const KEY_STATE = 'kitp_oidc_state';

interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function inMemoryStorage(): MinimalStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

function defaultStorage(): MinimalStorage {
  const g = globalThis as unknown as { sessionStorage?: MinimalStorage };
  if (g.sessionStorage) return g.sessionStorage;
  const fallback = inMemoryStorage();
  g.sessionStorage = fallback;
  return fallback;
}

/// Persist the verifier keyed by its associated state value. The state is
/// what the OP echoes back in the redirect query string; we use it to look
/// the verifier back up on callback. We also store the state separately so
/// `handleCallback` can detect mismatches before doing any token exchange.
export function setVerifier(
  state: string,
  verifier: string,
  storage: MinimalStorage = defaultStorage(),
): void {
  storage.setItem(KEY_VERIFIER, verifier);
  storage.setItem(KEY_STATE, state);
}

/// Look up the persisted verifier; returns null when the state does not
/// match the persisted state, or when nothing was persisted.
export function getVerifier(
  state: string,
  storage: MinimalStorage = defaultStorage(),
): string | null {
  const stored = storage.getItem(KEY_STATE);
  if (stored === null || stored !== state) return null;
  return storage.getItem(KEY_VERIFIER);
}

/// Wipe both verifier + state. Called after a successful exchange and on
/// signOut.
export function clear(storage: MinimalStorage = defaultStorage()): void {
  storage.removeItem(KEY_VERIFIER);
  storage.removeItem(KEY_STATE);
}

export type { MinimalStorage };
