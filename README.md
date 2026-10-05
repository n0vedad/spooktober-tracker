# Spooktober Tracker

Tracks Bluesky profile changes (handle, display name, avatar) across the whole network via a SolidJS frontend and an Express/Postgres backend that consumes Bluesky Jetstream v2.

## Features

- Bluesky OAuth login handled by the backend (identity only, `atproto` scope; tokens are revoked right after login)
- HttpOnly session cookie, cross-site request protection
- Network-wide ingestion of profile records and identity events (Jetstream v2)
- Last known profile state per account stored in Postgres, so changes survive restarts
- Per-user view: changes among the accounts you follow
- Ignored users: skipped during ingestion; their changes are deleted
- Admin panel (stats, start/stop with cursor, ignore list)

## Stack

- Frontend: SolidJS, Vite, Tailwind v4
- Backend: Express, ws, pg, Jetstream
- Tooling: TypeScript, pnpm workspaces, tsx (dev), tsc (build)

## Repository Layout

```
spooktober-tracker/
├─ frontend/        # SolidJS app
├─ backend/         # Express server + Jetstream
├─ shared/          # Shared TypeScript types
└─ README.md
```

## Requirements

- Node.js 23 (see `.nvmrc`)
- pnpm 9+
- PostgreSQL

## Setup

1) Install dependencies
```
pnpm install
```

2) Configure Postgres
- Create a user and database
- Set `DATABASE_URL` in `backend/.env`

3) Environment files
```
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

4) OAuth
- Development needs no setup: with `PUBLIC_URL` unset the backend acts as a public loopback client on `http://127.0.0.1:3000`
- Production: run `pnpm --filter backend gen-key`, set the output as `OAUTH_PRIVATE_KEY_JWK` and set `PUBLIC_URL`; the backend serves `/oauth-client-metadata.json` and `/jwks.json`

## Run

Dev
```
pnpm dev
```
- Frontend dev server: `VITE_DEV_SERVER_HOST:VITE_DEV_SERVER_PORT` (default `127.0.0.1:13214`); it proxies `/api`, `/oauth` and `/ws` to the backend
- Backend: `PORT` (default `3000`); set `FRONTEND_URL=http://127.0.0.1:13214` so the login returns to the dev server
- Open the app via `http://127.0.0.1:13214` (not `localhost`), so the session cookie matches the OAuth callback host

Build + start
```
pnpm build
pnpm start
```
`pnpm start` runs `node dist/backend/src/server.js`.

## Workspace Scripts

```
pnpm test        # backend tests (Vitest + in-memory PGlite, no Docker needed)
pnpm typecheck
pnpm dev
pnpm build
pnpm start
pnpm clean
pnpm clean:all
pnpm format
pnpm format:check
```

## Environment Variables

All values are required unless noted.

Backend (`backend/.env`)
- `DATABASE_URL`: Postgres connection string
- `PORT`: Server port
- `DEV_CORS_ORIGINS`: Dev CORS origins (comma‑separated) or `*`/`__ALL__` (dev only)
- `CORS_ALLOWED_ORIGINS`: Production CORS origins (comma‑separated)
- `ADMIN_DID`: Admin DID
- `JETSTREAM_URL` (optional): Jetstream v2 base URL, default `https://jetstream.us-east.bsky.network`

- `PUBLIC_URL` (production): Public origin of the backend (OAuth client_id/redirect_uri derive from it)
- `FRONTEND_URL` (optional): Where the browser lands after login, default `PUBLIC_URL`
- `OAUTH_PRIVATE_KEY_JWK` (production): Confidential OAuth client key from `pnpm --filter backend gen-key`

Frontend (`frontend/.env`, development only, all optional)
- `VITE_DEV_SERVER_HOST`, `VITE_DEV_SERVER_PORT`, `VITE_PUBLIC_HOST`
- `VITE_BACKEND_URL`: Backend the dev server proxies to, default `http://127.0.0.1:3000`

## Behavior

- Ingestion resumes from the stored cursor (Jetstream keeps ~36h of live history); without one it starts live
- The first event seen for an account only stores a baseline; Jetstream never delivers previous values
- Profiles younger than one hour are treated as sign-up setup, not renames
- Bots are filtered: accounts that self-label as `bot` or record more than 10 changes within 24h are flagged; their changes are hidden and no longer recorded (admin can unflag via `/api/admin/noisy-accounts`)
- v2 identity events carry no handle, so the current handle is read from the DID document; for unknown accounts the previous handle comes from the PLC audit log

## API

Auth
- Requests are authenticated by the `spooky_session` cookie set after the OAuth login. Admin routes require the configured `ADMIN_DID`.
- `GET /oauth/login?handle=<handle>`: Start login; `GET /oauth/callback`: OAuth redirect target
- `POST /api/auth/logout`: End the session
- `GET /api/me`: Signed-in account (`did`, `handle`, `isAdmin`)

User routes
- `GET /api/me/follows`: Accounts you follow
- `GET /api/me/changes`: Changes among the accounts you follow
- `DELETE /api/me/data`: Delete your own changes and stored profile state
- `GET /api/changes?limit=50&before=<id>`: Newest profile changes (paginated)
- `GET /api/changes/:did/history`: Change history for a DID

Admin routes
- `GET /api/admin/stats`: Tracked accounts, ingestion state, last event time
- `GET /api/admin/jetstream/recommended-cursor`: Cursor of the last processed event
- `POST /api/admin/jetstream/start`: Start ingestion (optional cursor)
- `POST /api/admin/jetstream/stop`: Stop ingestion
- `GET /api/admin/ignored-users`, `POST /api/admin/ignored-users`, `DELETE /api/admin/ignored-users/:did`: Ignore list
- `GET /api/admin/noisy-accounts`, `DELETE /api/admin/noisy-accounts/:did`: Accounts flagged as bots

## Troubleshooting

- OAuth `/oauth/par` 400 in production: ensure `/oauth-client-metadata.json` is publicly reachable at `PUBLIC_URL`
- Logged out right after login in development: open the app via `127.0.0.1`, not `localhost`
- DB connection errors: verify `DATABASE_URL` and role credentials

## License

0BSD

