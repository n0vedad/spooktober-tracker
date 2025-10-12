/**
 * Fetch with timeout support to prevent hanging requests.
 */

const DEFAULT_TIMEOUT_MS = 10000; // 10 seconds

/**
 * Fetch with automatic timeout.
 *
 * @param url - URL to fetch.
 * @param options - Standard fetch options.
 * @param timeoutMs - Timeout in milliseconds (default: 10s).
 * @returns Promise resolving with the Response.
 */
export async function fetchWithTimeout(
  url: string,
  options?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Perform fetch with an abort signal; always clear the timeout and
  // convert AbortError into a clearer timeout message for callers.
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  }
}
