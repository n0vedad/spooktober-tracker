/**
 * Vite configuration for the SolidJS frontend.
 *
 * Highlights:
 * - Loads environment via Vite's `loadEnv` and validates required keys.
 * - Dev server host/port are configurable through `VITE_DEV_SERVER_HOST`/`VITE_DEV_SERVER_PORT`.
 * - Emits OAuth client metadata as `/client-metadata.json` during dev and build when configured.
 * - Adds Tailwind and Solid Vite plugins.
 */
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import solidPlugin from "vite-plugin-solid";

/**
 * Read a required environment variable from a Vite-provided env object.
 * Throws when the variable is missing or empty.
 *
 * @param env - The environment map returned by `loadEnv`.
 * @param key - The variable name to read.
 * @returns The trimmed variable value.
 */
const requireEnv = (env: Record<string, string>, key: string): string => {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Environment variable ${key} must be defined.`);
  }
  return value.trim();
};

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
 * Parse a comma-separated string into a non-empty, trimmed list.
 *
 * @param value - CSV string value.
 * @param key - Name of the related config/env key (for error messages).
 * @returns Array of non-empty entries.
 */
const parseCsv = (value: string, key: string): string[] => {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new Error(`${key} must contain at least one comma-separated value.`);
  }

  return entries;
};

/**
 * Build the Vite config based on the current `mode` and `command`.
 *
 * - In `serve`, configures the dev server host/port and allowedHosts.
 * - Validates OAuth-related envs and, when provided, emits client metadata.
 * - Configures preview to use `PORT` if provided (e.g., Render/Heroku).
 */
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), "");
  Object.assign(process.env, env);

  const isServe = command === "serve";
  const isDevelopment = mode === "development";

  let devServerPort: number | undefined;
  let serverConfig:
    | {
        host: string;
        port: number;
        strictPort: boolean;
        allowedHosts: string[];
      }
    | undefined;

  const devServerHostValue = optionalEnv(env, "VITE_DEV_SERVER_HOST");
  const devServerPortValue = optionalEnv(env, "VITE_DEV_SERVER_PORT");
  const publicHostValue = optionalEnv(env, "VITE_PUBLIC_HOST");

  if (isServe) {
    const devHost = devServerHostValue ?? "127.0.0.1";
    const devPortRaw = devServerPortValue ?? "5173";
    const publicHost = publicHostValue ?? devHost;

    devServerPort = parseNumber(devPortRaw, "VITE_DEV_SERVER_PORT");

    serverConfig = {
      host: devHost,
      port: devServerPort,
      strictPort: true,
      allowedHosts: [publicHost],
    };
  }

  const oauthScope = requireEnv(env, "VITE_OAUTH_SCOPE");
  const oauthClientId = requireEnv(env, "VITE_OAUTH_CLIENT_ID");
  const oauthRedirectUrl = requireEnv(env, "VITE_OAUTH_REDIRECT_URL");
  const clientUri = requireEnv(env, "VITE_CLIENT_URI");

  const metadataName = optionalEnv(env, "VITE_CLIENT_METADATA_NAME");

  const hasMetadataConfig = Boolean(metadataName);

  if (!hasMetadataConfig) {
    if (mode !== "development") {
      throw new Error(
        "For production builds you must provide VITE_CLIENT_METADATA_NAME.",
      );
    }

    if (!oauthClientId.startsWith("http://localhost")) {
      throw new Error(
        "In development mode VITE_OAUTH_CLIENT_ID must use the Bluesky localhost helper (e.g. http://localhost?redirect_uri=...).",
      );
    }
  }

  let clientMetadata:
    | {
        client_id: string;
        client_name?: string;
        client_uri: string;
        redirect_uris: string[];
        scope: string;
        grant_types: string[];
        response_types: string[];
        token_endpoint_auth_method: string;
        application_type: string;
        dpop_bound_access_tokens: boolean;
      }
    | null = null;

  if (hasMetadataConfig) {
    const redirectUris = [oauthRedirectUrl];

    clientMetadata = {
      client_id: oauthClientId,
      client_name: metadataName!,
      client_uri: clientUri,
      redirect_uris: redirectUris,
      scope: oauthScope,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
      dpop_bound_access_tokens: true,
    };
  }

  const plugins = [tailwindcss(), solidPlugin()];

  if (clientMetadata) {
    plugins.push({
      name: "client-metadata",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/client-metadata.json") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(clientMetadata, null, 2));
            return;
          }
          next();
        });
      },
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "client-metadata.json",
          source: JSON.stringify(clientMetadata, null, 2),
        });
      },
    });
  }

  const previewPortRaw =
    typeof process.env.PORT === "string" && process.env.PORT.trim() !== ""
      ? process.env.PORT
      : optionalEnv(env, "PORT");
  const previewPort = previewPortRaw
    ? parseNumber(previewPortRaw, "PORT")
    : devServerPort ?? 4173;

  const previewAllowedHosts = (() => {
    try {
      return [new URL(clientUri).hostname];
    } catch {
      return [];
    }
  })();

  const previewConfig: {
    host: string;
    port: number;
    strictPort: boolean;
    allowedHosts?: string[];
  } = {
    host: "0.0.0.0",
    port: previewPort,
    strictPort: true,
  };

  if (previewAllowedHosts.length > 0) {
    previewConfig.allowedHosts = previewAllowedHosts;
  }

  return {
    plugins,
    ...(serverConfig ? { server: serverConfig } : {}),
    preview: previewConfig,
    build: {
      target: "esnext",
    },
  };
});
