/**
 * Centralised environment variable access for the backend.
 * Throws explicit errors when required variables are missing or malformed.
 *
 * Use these helpers instead of reading `process.env` directly so we can
 * validate input early and provide clear error messages.
 */

/**
 * Read a required environment variable.
 *
 * @param name Variable name.
 * @returns Trimmed value.
 * @throws When the variable is missing or blank.
 */
const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Environment variable ${name} must be set.`);
  }
  return value.trim();
};

/**
 * Read an optional environment variable.
 * Returns undefined when not present or blank.
 *
 * @param name Variable name.
 * @returns Trimmed value or undefined.
 */
const optionalEnv = (name: string): string | undefined => {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

/**
 * Parse a valid TCP port number from string input.
 *
 * @param value Raw string.
 * @param name Related variable name for error messages.
 * @returns Parsed port number.
 */
const parsePort = (value: string, name: string): number => {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Environment variable ${name} must be a valid port number.`,
    );
  }
  return port;
};

/**
 * Parse a CORS origin list, allowing `*`/`__ALL__` for permissive mode.
 *
 * @param raw Raw env string (comma-separated or `*`).
 * @param name Env variable name for clearer errors.
 * @returns Struct with `allowAll` and `origins` array.
 */
const parseCorsList = (
  raw: string,
  name: string,
): { allowAll: boolean; origins: string[] } => {
  const value = raw.trim();
  const allowAll = value === "*" || value.toLowerCase() === "__all__";
  if (allowAll) {
    return { allowAll: true, origins: [] };
  }

  // Split CSV and normalize entries (trim, drop blanks)
  const origins = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // Reject empty origin lists; require explicit entries or wildcard markers
  if (origins.length === 0) {
    throw new Error(
      `${name} must contain a comma-separated list of origins or "*"/"__ALL__" to allow all.`,
    );
  }

  // Explicit whitelist mode: allow only the provided origins
  return { allowAll: false, origins };
};

// Database connection string.
export const DATABASE_URL = requireEnv("DATABASE_URL");
// HTTP listen port.
export const PORT = parsePort(requireEnv("PORT"), "PORT");
// Admin DID with elevated privileges.
export const ADMIN_DID = requireEnv("ADMIN_DID");

// CORS Values
const DEV_CORS_VALUE = optionalEnv("DEV_CORS_ORIGINS");
const PROD_CORS_VALUE = optionalEnv("CORS_ALLOWED_ORIGINS");

// Parse CORS origin lists for development/production at startup
const DEV_CORS = DEV_CORS_VALUE
  ? parseCorsList(DEV_CORS_VALUE, "DEV_CORS_ORIGINS")
  : null;
const PROD_CORS = PROD_CORS_VALUE
  ? parseCorsList(PROD_CORS_VALUE, "CORS_ALLOWED_ORIGINS")
  : null;

/**
 * Resolve the active CORS configuration depending on NODE_ENV.
 *
 * @returns Object with `allowAll` and `origins` fields.
 */
export const getCorsConfig = (): { allowAll: boolean; origins: string[] } => {
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction) {
    if (!PROD_CORS) {
      throw new Error("CORS_ALLOWED_ORIGINS must be set in production");
    }
    return PROD_CORS;
  }

  // Error handling
  if (!DEV_CORS) {
    throw new Error(
      "DEV_CORS_ORIGINS must be set when NODE_ENV is not production",
    );
  }
  return DEV_CORS;
};

// Jetstream v2 instance to consume (live tail needs no API key).
export const JETSTREAM_URL =
  optionalEnv("JETSTREAM_URL") ?? "https://jetstream.us-east.bsky.network";

// Public origin of this backend (OAuth client_id/redirect_uri are derived from it).
// Defaults to the loopback address, which makes the OAuth client a public
// "localhost" client that needs no key or hosted metadata (development only).
export const PUBLIC_URL = (
  optionalEnv("PUBLIC_URL") ?? `http://127.0.0.1:${PORT}`
).replace(/\/+$/, "");

// Where to send the browser after login/logout (the Vite dev server in development).
export const FRONTEND_URL = (optionalEnv("FRONTEND_URL") ?? PUBLIC_URL).replace(
  /\/+$/,
  "",
);

// Loopback origins get a public OAuth client; everything else must be confidential.
export const IS_LOOPBACK = /^http:\/\/(127\.0\.0\.1|\[::1\])(:\d+)?$/.test(
  PUBLIC_URL,
);

// Private ES256 JWK for the confidential OAuth client (generate with `pnpm gen-key`).
export const OAUTH_PRIVATE_KEY_JWK = optionalEnv("OAUTH_PRIVATE_KEY_JWK");
if (!IS_LOOPBACK && !OAUTH_PRIVATE_KEY_JWK) {
  throw new Error(
    "OAUTH_PRIVATE_KEY_JWK must be set when PUBLIC_URL is not a loopback address.",
  );
}

// Labeler identity and signing key (secp256k1, 64 hex chars). The labeler
// is disabled unless both are set (`pnpm labeler-key` generates a key).
export const LABELER_DID = optionalEnv("LABELER_DID");
export const LABELER_SIGNING_KEY = optionalEnv("LABELER_SIGNING_KEY");
