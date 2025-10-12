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

// Minimal PLC audit log entry shape (fields used by resolver)
interface PLCAuditLogEntry {
  alsoKnownAs?: string[];
  createdAt?: string;
}

/**
 * Get previous handle from PLC audit log.
 *
 * @param did DID to check.
 * @returns Previous handle or null if not found.
 */
export async function getPreviousHandleFromAuditLog(
  did: string,
): Promise<string | null> {
  if (!did.startsWith("did:plc:")) {
    return null;
  }

  // Fetch PLC audit log for the DID to inspect prior handles
  try {
    const url = `https://plc.directory/${did}/log`;
    const response = await fetchWithTimeout(url);

    // Parse JSON payload as PLC audit log entries
    if (!response.ok) {
      return null;
    }
    const log = (await response.json()) as PLCAuditLogEntry[];

    // Log is sorted newest first, so check the second entry for previous handle
    if (log.length >= 2) {
      const previousEntry = log[1];
      const alias = previousEntry.alsoKnownAs?.find((entry) =>
        entry.includes("at://"),
      );
      return alias ? alias.split("//")[1] : null;
    }

    return null;

    // Error handling
  } catch (error) {
    console.warn(`Failed to get audit log for ${did}:`, error);
    return null;
  }
}

/**
 * Resolve a DID to its known handle via PLC or did:web documents.
 *
 * @param did DID to resolve.
 * @returns Handle string or null when lookup fails.
 */
export async function resolveHandle(did: string): Promise<string | null> {
  if (handleCache.has(did)) {
    return handleCache.get(did) ?? null;
  }

  // Resolve handles
  try {
    const url = did.startsWith("did:web")
      ? `https://${did.split(":")[2]}/.well-known/did.json`
      : `https://plc.directory/${did}`;
    const response = await fetchWithTimeout(url);

    // Cache negative lookups to avoid repeated failed fetches.
    if (!response.ok) {
      setCacheEntry(did, null);
      return null;
    }

    // Parse DID document to inspect alsoKnownAs entries
    const doc = (await response.json()) as {
      alsoKnownAs?: string[];
    };

    // Extract at-proto handle (at://...) from alsoKnownAs
    const alias = doc.alsoKnownAs?.find((entry) => entry.includes("at://"));
    const handle = alias ? alias.split("//")[1] : null;

    // Store the resolved handle (or null) for faster subsequent lookups.
    setCacheEntry(did, handle ?? null);
    return handle ?? null;

    // Cache failure state so repeated errors aren't triggered immediately again.
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
