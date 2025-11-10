/**
 * Express server for spooktober_tracker
 * Serves frontend build + API endpoints
 */

import type { CorsOptions } from "cors";
import cors from "cors";
import "dotenv/config";
import express from "express";
import fs from "fs";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket, WebSocketServer } from "ws";
import { getCorsConfig, PORT } from "./config.js";
import { initDB, pool } from "./db.js";
import jetstreamService, {
  temporaryJetstreamManager,
} from "./jetstream-service.js";
import adminRouter from "./routes/admin.js";
import changesRouter from "./routes/changes.js";
import monitoringRouter, {
  broadcastMonitoringStatusUpdate,
  getMonitoringStatusSnapshot,
  registerMonitoringStatusBroadcaster,
} from "./routes/monitoring.js";

// Paths and core app primitives
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Express application instance
const app = express();
const IPV6_ANY = "::";

// Resolve CORS policy from environment (dev/prod aware)
const corsConfig = getCorsConfig();
const allowAllOrigins = corsConfig.allowAll;
const resolvedOrigins = corsConfig.origins;

// Enforce allowed origins; log and reject unexpected ones
const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin || allowAllOrigins || resolvedOrigins.includes(origin)) {
      return callback(null, true);
    }
    console.warn(`❌ Blocked CORS origin: ${origin}`);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-User-DID"],
};

// Middleware
app.use(express.json());
app.use(cors(corsOptions));

// API Routes
app.use("/api/changes", changesRouter);
app.use("/api/monitoring", monitoringRouter);
app.use("/api/admin", adminRouter);

// Health check
app.get("/api/health", (_, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Serve frontend (static files from Vite build)
const frontendPath = path.join(__dirname, "../public");
app.use(express.static(frontendPath));

// Backend Landing Page
const ASCII_LANDING_PAGE = `
 ######   ######     ######    ######   #    #   #######   ######   ######   #######  ######   
#      #  #     #   #      #  #      #  #   #       #     #      #  #     #  #        #     #  
#         #     #   #      #  #      #  #  #        #     #      #  #     #  #        #     #  
 ######   ######    #      #  #      #  ###         #     #      #  ######   #####    ######   
       #  #         #      #  #      #  #  #        #     #      #  #     #  #        #   #    
#      #  #         #      #  #      #  #   #       #     #      #  #     #  #        #    #   
 ######   #          ######    ######   #    #      #      ######   ######   #######  #     #  

Spooktober Tracker Backend is working
API-Endpoints starts with /api/
`.trim();
const sendAsciiLandingPage = (res: express.Response) => {
  res.type("text/plain").send(ASCII_LANDING_PAGE);
};

// SPA fallback - serve index.html for all non-API routes (production only)
app.get("*", (_, res) => {
  const indexPath = path.join(frontendPath, "index.html");

  // In dev mode, frontend runs on Vite, so don't serve from here
  if (process.env.NODE_ENV !== "production") {
    return sendAsciiLandingPage(res);
  }

  // If the built index.html is missing, fall back to ASCII landing page
  if (!fs.existsSync(indexPath)) {
    return sendAsciiLandingPage(res);
  }
  res.sendFile(indexPath, (error) => {
    if (error) {
      // On send error, log and fall back to ASCII landing if headers not yet sent
      console.error("❌ Failed to serve frontend:", error);
      if (!res.headersSent) {
        sendAsciiLandingPage(res);
      }
    }
  });
});

// WebSocket server for live updates
let wss: WebSocketServer;

/**
 * Emit cursor updates to all live WebSocket clients.
 *
 * @param cursorInfo - Cursor metadata (timestamp) or null when unavailable.
 */
export const broadcastCursorUpdate = (cursorInfo: {
  timestamp: string | null;
  isInBackfill: boolean;
}) => {
  if (!wss) return;

  // Cursor update
  const message = JSON.stringify({
    type: "cursor_update",
    data: {
      cursor: cursorInfo,
    },
  });

  // If client open send message
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
};

/**
 * Boot the server, initialise DB, start Jetstream and bind listeners.
 *
 * @returns Promise that resolves once the HTTP server is listening.
 */
const start = async () => {
  try {
    await initDB();
    console.log("✅ Database initialized");

    // Create HTTP server
    const httpServer = createServer(app);

    // Create WebSocket server
    wss = new WebSocketServer({
      server: httpServer,
      path: "/ws",
      noServer: true,
    });

    // Handle WebSocket upgrade with authentication
    httpServer.on("upgrade", (request, socket, head) => {
      try {
        // Parse URL to get query parameters
        const url = new URL(
          request.url || "",
          `http://${request.headers.host}`,
        );
        const did = url.searchParams.get("did");

        // Validate DID format
        const didRegex = /^did:(plc|web):[a-z0-9.-]+$/;
        if (!did || !didRegex.test(did)) {
          console.warn(
            `❌ WebSocket connection rejected: Invalid or missing DID (${did})`,
          );
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        // DID is valid, allow upgrade
        wss?.handleUpgrade(request, socket, head, (ws) => {
          wss?.emit("connection", ws, request, did);
        });
      } catch (error) {
        console.error("❌ WebSocket upgrade error:", error);
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
      }
    });

    // Bridge monitoring status snapshots to connected WebSocket clients
    registerMonitoringStatusBroadcaster((snapshot) => {
      if (!wss) return;
      // Encode update payload
      const message = JSON.stringify({
        type: "monitoring_status_update",
        data: snapshot,
      });
      // Broadcast to all currently open clients
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    });

    // Push an initial snapshot so clients have state immediately on connect
    void broadcastMonitoringStatusUpdate();

    // Connect (with authenticated DID)
    wss.on(
      "connection",
      (ws: WebSocket, _request: any, authenticatedDID: string) => {
        console.log(
          `✅ WebSocket connection established for ${authenticatedDID}`,
        );

        // Disconnect
        ws.on("close", () => {
          console.log(`🔌 WebSocket disconnected for ${authenticatedDID}`);
        });

        // Send initial cursor info
        const cursorInfo = jetstreamService.getCursorInfo();
        ws.send(
          JSON.stringify({
            type: "cursor_update",
            data: {
              cursor: cursorInfo,
            },
          }),
        );

        // Send a one-time snapshot to the newly connected client
        getMonitoringStatusSnapshot()
          .then((snapshot) => {
            // Encode and deliver the initial monitoring status
            ws.send(
              JSON.stringify({
                type: "monitoring_status_update",
                data: snapshot,
              }),
            );
          })
          .catch((error) => {
            // Log, but don't break the connection; periodic updates will follow
            console.error(
              "❌ Failed to send initial monitoring status:",
              error,
            );
          });
      },
    );

    // Start HTTP Server first and wait for it to be ready
    await new Promise<void>((resolve, reject) => {
      httpServer.listen(PORT, () => {
        const addressInfo = httpServer.address();
        if (addressInfo && typeof addressInfo === "object") {
          const host =
            addressInfo.address === IPV6_ANY ? "::" : addressInfo.address;
          console.log(`✅ Server running on ${host}:${addressInfo.port}`);
          resolve();

          // Unix socket/pipe
        } else if (typeof addressInfo === "string") {
          console.log(`✅ Server running on ${addressInfo}`);
          resolve();

          // This shouldn't happen, but handle it
        } else {
          console.error("❌ Failed to get server address");
          reject(new Error("Failed to get server address"));
        }
      });

      // Handle server start fail
      httpServer.on("error", (err) => {
        console.error("❌ Failed to start HTTP server:", err);
        reject(err);
      });
    });

    // Start Jetstream Service after server is running
    await jetstreamService.start();

    // After successful start, attempt to auto-restart any pending temp streams
    void (async () => {
      try {
        // Only restart temp streams if main Jetstream is running with a valid cursor
        if (!jetstreamService.isRunningWithCursor()) {
          console.log(
            "ℹ️  Skipping temp-stream auto-restart: main stream not yet running with a valid cursor (retrying in 30s)",
          );
          setTimeout(() => {
            void (async () => {
              try {
                if (!jetstreamService.isRunningWithCursor()) return;
                const { getMonitoringUserCounts, getMonitoredFollows } =
                  await import("./db.js");
                const users = await getMonitoringUserCounts();
                const pendingUsers = users
                  .filter((u) => {
                    if (!u.last_started_at) return false;
                    if (!u.last_completed_at) return true;
                    return (
                      new Date(u.last_completed_at).getTime() <
                      new Date(u.last_started_at).getTime()
                    );
                  })
                  .map((u) => u.user_did);
                for (const userDID of pendingUsers) {
                  try {
                    const rows = await getMonitoredFollows(userDID);
                    const followDIDs = rows.map((r) => r.follow_did);
                    if (followDIDs.length === 0) continue;
                    await temporaryJetstreamManager.startForUser(
                      userDID,
                      followDIDs,
                    );
                    console.log(
                      `♻️  Auto-restarted temporary Jetstream for ${userDID} (${followDIDs.length} DIDs)`,
                    );
                  } catch (err) {
                    console.error(
                      `❌ Failed to auto-restart temporary stream for ${userDID}:`,
                      err,
                    );
                  }
                }
              } catch (error) {
                console.error(
                  "❌ Failed temp-stream auto-restart retry:",
                  error,
                );
              }
            })();
          }, 30000);
          return;
        }

        const { getMonitoringUserCounts, getMonitoredFollows } = await import(
          "./db.js"
        );
        const users = await getMonitoringUserCounts();

        // Pending = started but not completed (or completed before started)
        const pendingUsers = users
          .filter((u) => {
            if (!u.last_started_at) return false;
            if (!u.last_completed_at) return true;
            return (
              new Date(u.last_completed_at).getTime() <
              new Date(u.last_started_at).getTime()
            );
          })
          .map((u) => u.user_did);

        for (const userDID of pendingUsers) {
          try {
            const rows = await getMonitoredFollows(userDID);
            const followDIDs = rows.map((r) => r.follow_did);
            if (followDIDs.length === 0) continue;
            await temporaryJetstreamManager.startForUser(userDID, followDIDs);
            console.log(
              `♻️  Auto-restarted temporary Jetstream for ${userDID} (${followDIDs.length} DIDs)`,
            );
          } catch (err) {
            console.error(
              `❌ Failed to auto-restart temporary stream for ${userDID}:`,
              err,
            );
          }
        }
      } catch (error) {
        console.error("❌ Failed temp-stream auto-restart bootstrap:", error);
      }
    })();
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

/**
 * Gracefully stop Jetstream and close DB pool when receiving OS signals.
 *
 * @param signal - Name of the received signal (e.g. SIGTERM).
 * @returns Promise that settles after resources are disposed.
 */
const shutdown = async (signal: string) => {
  console.log(`${signal} received, closing server...`);
  try {
    await jetstreamService.stop();
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
