/**
 * Railway infrastructure of the Spooktober Tracker.
 *
 * Preview with `railway config plan`, apply with `railway config apply`.
 * Secrets are never written here: they are read from the local environment
 * when applying and otherwise left unchanged on Railway (`preserve()`).
 */

import {
  database,
  defineRailway,
  github,
  preserve,
  project,
  service,
  volume,
} from "railway/iac";

const REGION = "europe-west4-drams3a";
const PUBLIC_URL = "https://spooktober.katerstrophal.world";

export default defineRailway(() => {
  // Pinned to the major version of the data directory. Major upgrades must go
  // through Railway's pg_upgrade flow (Database -> Config -> Major Version
  // Upgrade); changing this tag alone would not migrate the data
  const Postgres = database("Postgres", "postgres", {
    image: "ghcr.io/railwayapp-templates/postgres-ssl:18",
    defaultMountPath: "/var/lib/postgresql/data",
    region: REGION,
  });
  Postgres.networking = {
    privateNetworkEndpoint: "postgres",
    tcpProxies: { "5432": {} },
  };
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: REGION,
    sizeMB: 5000,
  });

  // Backend + built frontend; a single replica, because Jetstream ingestion
  // and the bubble jobs must not run twice
  const app = service("spooktober", {
    source: github("n0vedad/spooktober-tracker", { branch: "main" }),
    build: "pnpm build",
    start: "pnpm start",
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    replicas: { [REGION]: 1 },
    // Custom domain spooktober.katerstrophal.world is registered in Railway
    // directly (not supported here); `railway config pull` imports it
    env: {
      NODE_ENV: "production",
      DATABASE_URL: Postgres.env.DATABASE_URL,
      PUBLIC_URL,
      CORS_ALLOWED_ORIGINS: PUBLIC_URL,
      ADMIN_DID: "did:plc:ciul6zkjqvao5uv4cpyoijdp",
      // Confidential OAuth client key (`pnpm --filter backend gen-key`)
      OAUTH_PRIVATE_KEY_JWK: process.env.OAUTH_PRIVATE_KEY_JWK ?? preserve(),
    },
  });

  return project("spooktober-tracker", {
    resources: [Postgres, postgresVolume, app],
  });
});
