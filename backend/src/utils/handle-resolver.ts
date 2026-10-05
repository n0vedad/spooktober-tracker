/**
 * Helpers to resolve Bluesky handles for DIDs with simple in-memory caching.
 */

import { fetchWithTimeout } from "./fetch-with-timeout.js";

// LRU Cache with max 10,000 entries to prevent memory leaks
const MAX_CACHE_SIZE = 10000;
const handleCache = new Map<string, string | null>();

// Add entry to cache with LRU eviction if full.
function setCacheEntry(did: string, handle: string | null) {
  // If cache is at max size, delete oldest entry (first in Map)
  if (handleCache.size >= MAX_CACHE_SIZE) {
    const firstKey = handleCache.keys().next().value;
    if (firstKey !== undefined) {
      handleCache.delete(firstKey);
    }
  }
  handleCache.set(did, handle);
}

// PLC audit log entry (`/<did>/log/audit`, ordered oldest first)
interface PLCAuditLogEntry {
  createdAt: string;
  nullified?: boolean;
  operation: {
    // Current operation format
    alsoKnownAs?: string[];
    // Legacy `create` operation format
    handle?: string;
  };
}

// A handle switch in the PLC log must be this close to the identity event
const PLC_MATCH_WINDOW_MS = 15 * 60 * 1000;

// Extract the handle an audit log operation assigns (null if none).
function handleOf(entry: PLCAuditLogEntry): string | null {
  const alias = entry.operation.alsoKnownAs?.find((a) => a.startsWith("at://"));
  if (alias) return alias.slice("at://".length);
  return entry.operation.handle ?? null;
}

/**
 * Find the handle a did:plc account used right before switching to
 * `newHandle`, based on the PLC audit log.
 *
 * Only answers when the log's latest handle switch is to `newHandle` and
 * happened close to `eventTime`; otherwise the identity event is not a fresh
 * rename (e.g. a resync or key rotation) and null is returned.
 *
 * @param did Account DID.
 * @param newHandle Handle announced by the identity event.
 * @param eventTime Time of the identity event.
 * @param fetchFn Fetch implementation (injectable for tests).
 * @returns Previous handle, or null when unknown.
 */
export async function findPreviousHandle(
  did: string,
  newHandle: string,
  eventTime: Date,
  fetchFn: typeof fetchWithTimeout = fetchWithTimeout,
): Promise<string | null> {
  if (!did.startsWith("did:plc:")) return null;

  try {
    const response = await fetchFn(`https://plc.directory/${did}/log/audit`);
    if (!response.ok) return null;
    const log = ((await response.json()) as PLCAuditLogEntry[]).filter(
      (entry) => !entry.nullified,
    );

    // The log must already end on the new handle
    const latest = log.at(-1);
    if (!latest || handleOf(latest) !== newHandle) return null;

    // Walk back to the operation that introduced the new handle
    let i = log.length - 1;
    while (i > 0 && handleOf(log[i - 1]) === newHandle) i--;
    if (i === 0) return null;

    const switchedAt = new Date(log[i].createdAt).getTime();
    if (Math.abs(switchedAt - eventTime.getTime()) > PLC_MATCH_WINDOW_MS) {
      return null;
    }
    return handleOf(log[i - 1]);
  } catch (error) {
    console.warn(`Failed to get audit log for ${did}:`, error);
    return null;
  }
}

/**
 * Read the handle currently claimed in a DID document, bypassing the cache.
 *
 * @param did DID to resolve (did:plc or did:web).
 * @param fetchFn Fetch implementation (injectable for tests).
 * @returns Handle string, or null when the lookup fails or none is set.
 * @throws On network errors, so callers can retry.
 */
export async function fetchCurrentHandle(
  did: string,
  fetchFn: typeof fetchWithTimeout = fetchWithTimeout,
): Promise<string | null> {
  const url = did.startsWith("did:web:")
    ? `https://${did.slice("did:web:".length)}/.well-known/did.json`
    : `https://plc.directory/${did}`;
  const response = await fetchFn(url);
  if (!response.ok) return null;

  const doc = (await response.json()) as { alsoKnownAs?: string[] };
  const alias = doc.alsoKnownAs?.find((entry) => entry.startsWith("at://"));
  return alias ? alias.slice("at://".length) : null;
}

/**
 * Resolve a DID to its known handle via PLC or did:web documents (cached).
 *
 * @param did DID to resolve.
 * @returns Handle string or null when lookup fails.
 */
export async function resolveHandle(did: string): Promise<string | null> {
  if (handleCache.has(did)) {
    return handleCache.get(did) ?? null;
  }

  // Cache negative lookups too, so failing DIDs aren't refetched immediately
  try {
    const handle = await fetchCurrentHandle(did);
    setCacheEntry(did, handle);
    return handle;
  } catch (error) {
    console.warn(`Failed to resolve handle for ${did}:`, error);
    setCacheEntry(did, null);
    return null;
  }
}

/**
 * Resolve multiple DIDs to handles, preserving order and using cache.
 *
 * @param dids Iterable of DIDs to resolve.
 * @returns Array mapping each DID to its handle (or null).
 */
export async function resolveHandles(
  dids: readonly string[],
): Promise<Array<{ did: string; handle: string | null }>> {
  const unique = Array.from(new Set(dids));
  await Promise.all(unique.map((did) => resolveHandle(did)));
  return dids.map((did) => ({ did, handle: handleCache.get(did) ?? null }));
}
