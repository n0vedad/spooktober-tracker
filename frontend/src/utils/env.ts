/**
 * Typed access to Vite-provided environment variables.
 * Throws a descriptive error when required values are missing.
 *
 * Usage: import values from `ENV` rather than referencing `import.meta.env`
 * directly to ensure presence and avoid typos.
 */

// Known Vite env keys used by the frontend.
type KnownEnvKeys =
  | "VITE_ADMIN_DID"
  | "VITE_API_BASE_URL"
  | "VITE_OAUTH_CLIENT_ID"
  | "VITE_OAUTH_REDIRECT_URL"
  | "VITE_OAUTH_SCOPE"
  | "VITE_WS_URL";

/**
 * Read and validate a required env variable from `import.meta.env`.
 *
 * @param key Env key to read.
 * @returns Trimmed value.
 * @throws When the key is missing or blank.
 */
const requireEnv = (key: KnownEnvKeys): string => {
  const value = import.meta.env[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Environment variable ${key} must be defined.`);
  }
  return value.trim();
};

/**
 * Frontend environment (validated).
 * - `ADMIN_DID`: DID that unlocks admin features in the UI.
 * - `API_BASE_URL`: Base URL for REST endpoints (same-origin or absolute).
 * - `OAUTH_CLIENT_ID`: OAuth client identifier (per Vite config rules).
 * - `OAUTH_REDIRECT_URL`: Redirect URL registered for the client.
 * - `OAUTH_SCOPE`: Space-separated scope string for Bluesky OAuth.
 * - `WS_URL`: WebSocket endpoint (wss:// in production).
 */
export const ENV = {
  ADMIN_DID: requireEnv("VITE_ADMIN_DID"),
  API_BASE_URL: requireEnv("VITE_API_BASE_URL"),
  OAUTH_CLIENT_ID: requireEnv("VITE_OAUTH_CLIENT_ID"),
  OAUTH_REDIRECT_URL: requireEnv("VITE_OAUTH_REDIRECT_URL"),
  OAUTH_SCOPE: requireEnv("VITE_OAUTH_SCOPE"),
  WS_URL: requireEnv("VITE_WS_URL"),
} as const;
