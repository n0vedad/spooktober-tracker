/**
 * Server entrypoint: database, HTTP + WebSocket server and Jetstream ingestion.
 */

import "dotenv/config";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { getSessionDid, purgeExpiredSessions } from "./auth/sessions.js";
import { ADMIN_DID, PORT } from "./config.js";
import { initDB, pool } from "./db.js";
import { ingester } from "./ingest/index.js";
import {
  labeler,
  OPT_IN_SYNC_INTERVAL_MS,
  optInSync,
} from "./labeler/index.js";
import { getLabelsAfter, getLatestSeq, getOptIns } from "./labeler/store.js";
import { seedAccounts } from "./ingest/seed.js";
import { serveLabelSubscription } from "./labeler/subscription.js";
import { readSessionToken } from "./middleware/auth.js";

const IPV6_ANY = "::";
// How often expired sessions and OAuth states are deleted
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
// How often live status is pushed to connected admin clients
const STATUS_BROADCAST_INTERVAL_MS = 2000;
// Last event older than this counts as "catching up" rather than live
const LIVE_THRESHOLD_MS = 60_000;

/**
 * Cursor payload for the admin panel's live display.
 */
function cursorInfo() {
  const { lastEventTime } = ingester.status();
  return {
    timestamp: lastEventTime,
    isInBackfill:
      lastEventTime !== null &&
      Date.now() - Date.parse(lastEventTime) > LIVE_THRESHOLD_MS,
  };
}

/**
 * Boot the server, initialise DB, start ingestion and bind listeners.
 *
 * @returns Promise that resolves once the HTTP server is listening.
 */
const start = async () => {
  try {
    await initDB();
    console.log("✅ Database initialized");

    const httpServer = createServer(createApp());
    const wss = new WebSocketServer({ noServer: true });
    // Public label stream of the labeler
    const labelWss = new WebSocketServer({ noServer: true });
    const LABEL_STREAM_PATH = "/xrpc/com.atproto.label.subscribeLabels";

    // Handle WebSocket upgrade on /ws (admin session required)
    httpServer.on("upgrade", async (request, socket, head) => {
      try {
        const url = new URL(
          request.url || "",
          `http://${request.headers.host}`,
        );
        if (url.pathname === LABEL_STREAM_PATH && labeler) {
          const raw = url.searchParams.get("cursor");
          const cursor =
            raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
          const { events } = labeler;
          labelWss.handleUpgrade(request, socket, head, (ws) => {
            serveLabelSubscription(ws, cursor, {
              events,
              getLabelsAfter,
              getLatestSeq,
            }).catch((error) => {
              console.error("❌ Label subscription failed:", error);
              ws.close();
            });
          });
          return;
        }

        if (url.pathname !== "/ws") {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }

        const token = readSessionToken(request.headers.cookie);
        const did = token ? await getSessionDid(token) : null;
        if (did !== ADMIN_DID) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      } catch (error) {
        console.error("❌ WebSocket upgrade error:", error);
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
      }
    });

    // Send the current cursor to each new client
    wss.on("connection", (ws: WebSocket) => {
      ws.send(
        JSON.stringify({
          type: "cursor_update",
          data: { cursor: cursorInfo() },
        }),
      );
    });

    // Push cursor updates to all clients whenever they change
    let lastBroadcast = "";
    const broadcastTimer = setInterval(() => {
      const message = JSON.stringify({
        type: "cursor_update",
        data: { cursor: cursorInfo() },
      });
      if (message === lastBroadcast) return;
      lastBroadcast = message;
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
      });
    }, STATUS_BROADCAST_INTERVAL_MS);
    broadcastTimer.unref();

    // Periodically delete expired sessions and OAuth states
    const cleanupTimer = setInterval(() => {
      purgeExpiredSessions().catch((error) =>
        console.error("❌ Session cleanup failed:", error),
      );
    }, SESSION_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();

    // Start HTTP Server first and wait for it to be ready
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(PORT, () => {
        const addressInfo = httpServer.address();
        if (addressInfo && typeof addressInfo === "object") {
          const host =
            addressInfo.address === IPV6_ANY ? "::" : addressInfo.address;
          console.log(`✅ Server running on ${host}:${addressInfo.port}`);
        } else {
          console.log(`✅ Server running on ${addressInfo}`);
        }
        resolve();
      });
    });

    // Start network-wide ingestion (resumes from the stored cursor)
    await ingester.start();
    console.log("✅ Jetstream ingestion started");

    // Track who opted in to the labeler (likes/follows)
    if (labeler && optInSync) {
      optInSync.start(OPT_IN_SYNC_INTERVAL_MS);
      // Opted-in accounts must be known before their first change
      void getOptIns().then((optIns) => seedAccounts([...optIns.keys()]));
      console.log(`✅ Labeler running as ${labeler.did}`);
    }
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

/**
 * Gracefully stop ingestion and close DB pool when receiving OS signals.
 *
 * @param signal - Name of the received signal (e.g. SIGTERM).
 * @returns Promise that settles after resources are disposed.
 */
let shuttingDown = false;
const shutdown = async (signal: string) => {
  // Wrappers like npx/tsx may forward the same signal twice
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, closing server...`);
  try {
    await ingester.stop();
    await pool.end();
    console.log("✅ Database connections closed");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error during shutdown:", error);
    process.exit(1);
  }
};

// Shutdown handling
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start();
