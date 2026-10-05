/**
 * Vite configuration for the SolidJS frontend.
 *
 * Highlights:
 * - Dev server host/port are configurable through `VITE_DEV_SERVER_HOST`/`VITE_DEV_SERVER_PORT`.
 * - In development, `/api`, `/oauth` and `/ws` are proxied to the backend
 *   (`VITE_BACKEND_URL`), so the session cookie works same-origin.
 * - In production, the backend serves the built frontend itself.
 * - Adds Tailwind and Solid Vite plugins.
 */
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import solidPlugin from "vite-plugin-solid";

/**
 * Read an optional environment variable from a Vite-provided env object.
 * Returns `undefined` when not present or blank.
 *
 * @param env - The environment map returned by `loadEnv`.
 * @param key - The variable name to read.
 * @returns The trimmed value or undefined.
 */
const optionalEnv = (env: Record<string, string>, key: string): string | undefined => {
  const value = env[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

/**
 * Parse a positive integer number (e.g. port) from a string.
 *
 * @param value - Raw string value to parse.
 * @param key - Name of the related config/env key (for error messages).
 * @returns Parsed integer.
 */
const parseNumber = (value: string, key: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Environment variable ${key} must be a valid port number.`);
  }
  return parsed;
};

/**
 * Build the Vite config based on the current `mode`.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  const devHost = optionalEnv(env, "VITE_DEV_SERVER_HOST") ?? "127.0.0.1";
  const devPort = parseNumber(
    optionalEnv(env, "VITE_DEV_SERVER_PORT") ?? "13214",
    "VITE_DEV_SERVER_PORT",
  );
  const publicHost = optionalEnv(env, "VITE_PUBLIC_HOST") ?? devHost;
  const backendUrl = optionalEnv(env, "VITE_BACKEND_URL") ?? "http://127.0.0.1:3000";

  return {
    plugins: [tailwindcss(), solidPlugin()],
    server: {
      host: devHost,
      port: devPort,
      strictPort: true,
      allowedHosts: [publicHost],
      proxy: {
        "/api": backendUrl,
        "/oauth": backendUrl,
        "/ws": { target: backendUrl, ws: true },
      },
    },
    build: {
      target: "esnext",
    },
  };
});
