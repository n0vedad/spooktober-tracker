/**
 * Starts an in-memory PGlite database exposed over the Postgres wire protocol,
 * so the regular `pg` driver can talk to it without Docker.
 */

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { TestProject } from "vitest/node";

export default async function setup(project: TestProject) {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({
    db,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 1,
  });
  await server.start();

  // `getServerConn()` returns "host:port" once the server is listening
  const conn = server.getServerConn();
  project.provide(
    "databaseUrl",
    `postgresql://postgres:postgres@${conn}/postgres`,
  );

  return async () => {
    await server.stop();
    await db.close();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
