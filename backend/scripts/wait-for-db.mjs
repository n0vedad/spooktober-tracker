/**
 * Wait until the database from DATABASE_URL accepts TCP connections, so
 * `pnpm dev` can start the backend together with the local dev database.
 */

import "dotenv/config";
import net from "node:net";

const TIMEOUT_MS = 30_000;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (backend/.env)");
  process.exit(1);
}

const { hostname, port } = new URL(url);
const target = { host: hostname, port: Number(port || 5432) };

const reachable = () =>
  new Promise((resolve) => {
    const socket = net.connect(target);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

const deadline = Date.now() + TIMEOUT_MS;
while (!(await reachable())) {
  if (Date.now() > deadline) {
    console.error(`Database ${target.host}:${target.port} not reachable`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
