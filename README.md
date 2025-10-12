# Spooktober Tracker

Tracks Bluesky profile changes (handle, display name, avatar) via a SolidJS frontend and an Express/Postgres backend that consumes Bluesky Jetstream.

## Features

- OAuth and app‑password login
- Continuous Jetstream monitoring (main stream)
- Temporary 24h backfill streams per user (queued; capacity‑limited)
- Ignored users: excluded in main and temporary streams before sending to Jetstream; DB insert also skips
- Admin panel (stats, start/stop, recommended cursor, ignore list)

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

4) OAuth client metadata
- Set values in `frontend/.env` (see Environment Variables)
- The Vite build emits `client-metadata.json` and serves it in dev

## Run

Dev
```
pnpm dev
```
- Frontend dev server: `VITE_DEV_SERVER_HOST:VITE_DEV_SERVER_PORT` (default `127.0.0.1:13214`)
- Backend: `HOST:PORT` (default `0.0.0.0:3000`)

Build + start
```
pnpm build
pnpm start
```
`pnpm start` runs `node dist/backend/src/server.js`.

## Workspace Scripts

```
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
- `JETSTREAM_HOSTS`: Comma‑separated hostnames (without `wss://`)

Frontend (`frontend/.env`)
- `VITE_API_BASE_URL`: Backend HTTP base URL
- `VITE_WS_URL`: Backend WebSocket URL
- `VITE_OAUTH_SCOPE`: Space‑separated Bluesky scopes
- `VITE_OAUTH_CLIENT_ID`: OAuth client ID (public metadata URL in prod)
- `VITE_OAUTH_REDIRECT_URL`: OAuth redirect URL
- `VITE_CLIENT_URI`: Public client base URL
- `VITE_CLIENT_METADATA_NAME` (prod): Client display name
- Dev server only: `VITE_DEV_SERVER_HOST`, `VITE_DEV_SERVER_PORT`, `VITE_PUBLIC_HOST`

Notes
- In development, you can use the Bluesky localhost helper `client_id` and a local redirect URL
- In production, host `client-metadata.json` and set `VITE_OAUTH_CLIENT_ID` to its public URL

## Behavior

- Main Jetstream stream starts live by default
- Backfill mode is active only when started with a cursor older than ~60 seconds
- Backfill completion log includes the initial lag (seconds)
- Ignored users are filtered in main and temporary streams before sending to Jetstream; DB insert also checks and skips

## API

Auth
- All routes require authentication (`X-User-DID`). Admin routes require the configured admin DID.

User routes
- `GET /api/changes`: Global profile changes
- `GET /api/changes/:did/history`: Change history for a DID
- `POST /api/monitoring/enable`: Enable monitoring for a user DID
- `GET /api/monitoring/follows/:user_did`: List monitored follows
- `GET /api/monitoring/changes/:user_did`: Changes for monitored follows
- `DELETE /api/monitoring/disable/:user_did`: Disable monitoring
- `GET /api/monitoring/status`: Monitoring status snapshot

Admin routes
- `GET /api/admin/stats`: Monitored counts, Jetstream state, cursor timestamp, backfill flag
- `GET /api/admin/jetstream/recommended-cursor`: Recommended start cursor
- `POST /api/admin/jetstream/start`: Start Jetstream (optional cursor)
- `POST /api/admin/jetstream/stop`: Stop Jetstream
- `GET /api/admin/ignored-users`: List ignored users
- `POST /api/admin/ignored-users`: Add ignored user
- `DELETE /api/admin/ignored-users/:did`: Remove ignored user

## Troubleshooting

- OAuth `/oauth/par` 400: ensure client metadata is publicly reachable and redirect URL matches
- Local build login fails after `pnpm start`: confirm `frontend/.env` points to backend before `pnpm build`
- DB connection errors: verify `DATABASE_URL` and role credentials
- Unauthorized: ensure `X-User-DID` is present (logged in)

## License

0BSD

