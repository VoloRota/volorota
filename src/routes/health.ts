import { Hono } from "hono";

export interface HealthResponse {
  status: "ok";
  version: string;
}

/**
 * Returns a Hono router that serves GET /health → {status, version}.
 * Called from src/index.ts as app.route("/health", makeHealthRouter(version)).
 */
export function makeHealthRouter(version: string): Hono {
  const router = new Hono();

  router.get("/", (c) => {
    return c.json<HealthResponse>({ status: "ok", version });
  });

  return router;
}
