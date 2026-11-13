/**
 * GitHub tokens (decision 35): `sessionStorage` only, so a token dies with
 * the tab and never reaches `localStorage`, a log or the URL. Every read is
 * validated, because storage is just another input.
 */
import * as v from "valibot";
import { TOKEN_STORAGE_KEY } from "./types";

/** The part of `Storage` this module uses; tests pass a fake. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** OAuth refresh state, beside the access token and with the same lifetime. */
export const REFRESH_STORAGE_KEY = "docwalk.github-refresh";

/** GitHub tokens (`github_pat_…`, `ghu_…`, `ghp_…`) are `[A-Za-z0-9_]`; anything else is a bad paste. */
const TokenSchema = v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9_]{20,255}$/));

const RefreshSchema = v.object({
  refreshToken: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_]{20,512}$/)),
  /** Epoch milliseconds when the access token expires. */
  expiresAt: v.pipe(v.number(), v.finite()),
  /** Epoch milliseconds when the refresh token expires. */
  refreshExpiresAt: v.pipe(v.number(), v.finite()),
});

type RefreshRecord = v.InferOutput<typeof RefreshSchema>;

/** `sessionStorage`, or null where it is missing or throws (privacy modes, sandboxed frames). */
export function sessionStore(): StorageLike | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** The trimmed token when the paste looks like a GitHub token, else null. */
export function parseToken(raw: string): string | null {
  const result = v.safeParse(TokenSchema, raw);
  return result.success ? result.output : null;
}

/** Saves a token for this tab; false when it is malformed or storage is unavailable. */
export function storeToken(raw: string, storage: StorageLike | null = sessionStore()): boolean {
  const token = parseToken(raw);
  if (token === null || storage === null) return false;
  try {
    storage.setItem(TOKEN_STORAGE_KEY, token);
    return true;
  } catch {
    return false;
  }
}

/**
 * Saves a token the user pasted and drops any OAuth refresh state: otherwise
 * the next scheduled refresh would swap the pasted token for the OAuth one,
 * or delete it when the refresh is rejected.
 */
export function storePastedToken(raw: string, storage: StorageLike | null = sessionStore()) {
  if (!storeToken(raw, storage)) return false;
  try {
    storage?.removeItem(REFRESH_STORAGE_KEY);
  } catch {
    // The token is saved; a refresh record that cannot be removed cannot be read either.
  }
  return true;
}

export function readToken(storage: StorageLike | null = sessionStore()): string | null {
  try {
    const raw = storage?.getItem(TOKEN_STORAGE_KEY);
    return raw == null ? null : parseToken(raw);
  } catch {
    return null;
  }
}

/** Forgets the token and any OAuth refresh state. */
export function clearToken(storage: StorageLike | null = sessionStore()): void {
  try {
    storage?.removeItem(TOKEN_STORAGE_KEY);
    storage?.removeItem(REFRESH_STORAGE_KEY);
  } catch {
    // Storage that cannot be written holds nothing to forget.
  }
}

export function storeRefresh(record: RefreshRecord, storage: StorageLike | null = sessionStore()) {
  if (!v.safeParse(RefreshSchema, record).success) return false;
  try {
    storage?.setItem(REFRESH_STORAGE_KEY, JSON.stringify(record));
    return storage != null;
  } catch {
    return false;
  }
}

export function readRefresh(storage: StorageLike | null = sessionStore()): RefreshRecord | null {
  try {
    const raw = storage?.getItem(REFRESH_STORAGE_KEY);
    if (raw == null) return null;
    const result = v.safeParse(RefreshSchema, JSON.parse(raw));
    return result.success ? result.output : null;
  } catch {
    return null;
  }
}
