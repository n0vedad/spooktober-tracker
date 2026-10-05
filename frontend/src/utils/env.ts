/**
 * Backend endpoints used by the frontend.
 *
 * The frontend is always served from the same origin as the backend (via the
 * Vite proxy in development, by the backend itself in production), so
 * relative paths are enough and the session cookie is sent automatically.
 */

const wsProtocol =
  typeof location !== "undefined" && location.protocol === "https:"
    ? "wss:"
    : "ws:";

/**
 * Frontend environment.
 * - `API_BASE_URL`: Base path for REST endpoints.
 * - `LOGIN_URL`: Backend route starting the OAuth login.
 * - `WS_URL`: WebSocket endpoint for live admin updates.
 */
export const ENV = {
  API_BASE_URL: "/api",
  LOGIN_URL: "/oauth/login",
  WS_URL:
    typeof location !== "undefined"
      ? `${wsProtocol}//${location.host}/ws`
      : "/ws",
} as const;
