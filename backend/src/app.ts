/**
 * Express application: API routes, health check and frontend delivery.
 * Kept free of side effects so tests can mount it without starting servers.
 */

import type { CorsOptions } from "cors";
import cors from "cors";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FRONTEND_URL, PUBLIC_URL, getCorsConfig } from "./config.js";
import { loadSession, rejectCrossSite } from "./middleware/auth.js";
import adminRouter from "./routes/admin.js";
import authRouter from "./routes/auth.js";
import changesRouter from "./routes/changes.js";
import meRouter from "./routes/me.js";
import xrpcRouter from "./routes/xrpc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

/**
 * Build the Express application.
 *
 * @returns Configured Express app.
 */
export function createApp(): express.Express {
  const app = express();

  // Resolve CORS policy from environment (dev/prod aware)
  const corsConfig = getCorsConfig();

  // Enforce allowed origins; log and reject unexpected ones
  const corsOptions: CorsOptions = {
    origin(origin, callback) {
      if (
        !origin ||
        corsConfig.allowAll ||
        corsConfig.origins.includes(origin)
      ) {
        return callback(null, true);
      }
      // No CORS headers: the browser won't expose responses to this origin,
      // and rejectCrossSite answers its state-changing requests with 403
      console.warn(`❌ Blocked CORS origin: ${origin}`);
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  };

  // Origins the frontend may send state-changing requests from
  const frontendOrigins = [
    new URL(PUBLIC_URL).origin,
    new URL(FRONTEND_URL).origin,
    ...corsConfig.origins,
  ];

  // Middleware
  app.use(express.json());
  app.use(cors(corsOptions));
  app.use(rejectCrossSite(frontendOrigins));
  app.use(loadSession);

  // OAuth login (/oauth/*, client metadata) and /api/me, /api/auth/logout
  app.use(authRouter);

  // API Routes
  app.use("/api/me", meRouter);
  app.use("/api/changes", changesRouter);
  app.use("/api/admin", adminRouter);
  app.use("/xrpc", xrpcRouter);

  // Health check
  app.get("/api/health", (_, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Serve frontend (static files from Vite build)
  const frontendPath = path.join(__dirname, "../public");
  app.use(express.static(frontendPath));

  // SPA fallback - serve index.html for all non-API routes (production only)
  app.get("/{*splat}", (_, res) => {
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

  return app;
}
