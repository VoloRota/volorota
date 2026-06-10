import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { getDb } from "./db/schema.js";
import { peopleRouter } from "./routes/people.js";
import { teamsRouter } from "./routes/teams.js";
import { templatesRouter } from "./routes/templates.js";
import { servicesRouter } from "./routes/services.js";
import { blockoutsRouter } from "./routes/blockouts.js";
import { matrixRouter } from "./routes/matrix.js";
import { makeHealthRouter } from "./routes/health.js";
import { layout } from "./views/layout.js";
import {
  validateAuthConfig,
  authMiddleware,
  handleLoginGet,
  handleLoginPost,
  handleLogout,
  type AuthEnv,
} from "./auth.js";

// Validate required env vars — refuse to start if missing
const authConfigError = validateAuthConfig();
if (authConfigError) {
  console.error(`\nERROR: ${authConfigError}\n`);
  process.exit(1);
}

// Read version from package.json at startup (runtime, no bundler needed)
const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json() as { version: string };
const appVersion: string = pkg.version;

// Initialize DB on startup (side-effect: creates tables)
getDb();

const app = new Hono<AuthEnv>();

// Static files
app.use("/static/*", serveStatic({ root: "./public", rewriteRequestPath: (p) => p.replace(/^\/static/, "") }));

// Health check — public, outside the /admin auth gate
app.route("/health", makeHealthRouter(appVersion));

// Inject DB into context for auth middleware
app.use("*", (c, next) => {
  c.set("db", getDb());
  return next();
});

// Login / logout — registered BEFORE the auth middleware
app.get("/admin/login", handleLoginGet);
app.post("/admin/login", handleLoginPost);
app.post("/admin/logout", handleLogout);

// Auth gate — protects all /admin/* (middleware excludes /admin/login itself)
app.use("/admin/*", authMiddleware);

// Admin redirect
app.get("/", (c) => c.redirect("/admin"));
app.get("/admin", (c) => {
  const body = `
    <h1>VoloRota Admin</h1>
    <p>Welcome to the VoloRota church volunteer scheduler.</p>
    <ul>
      <li><a href="/admin/matrix">Matrix View</a> — see all upcoming assignments at a glance</li>
      <li><a href="/admin/people">People</a> — manage your volunteer roster</li>
      <li><a href="/admin/teams">Teams</a> — define teams, roles, and crew assignments</li>
      <li><a href="/admin/templates">Templates</a> — configure recurring service schedules</li>
      <li><a href="/admin/services">Services</a> — generate and manage service instances</li>
    </ul>`;
  return c.html(layout("Dashboard", body));
});

// Mount routers
app.route("/admin/people", peopleRouter);
app.route("/admin/people", blockoutsRouter);
app.route("/admin/teams", teamsRouter);
app.route("/admin/templates", templatesRouter);
app.route("/admin/services", servicesRouter);
app.route("/admin/matrix", matrixRouter);

// Env vars:
//   VOLOROTA_PORT          — listening port (default: PORT ?? 3000)
//   VOLOROTA_DB            — path to SQLite file (default: ./data/volorota.db)
//   VOLOROTA_ADMIN_PASSWORD — required; admin login password
//   VOLOROTA_SESSION_SECRET — optional; ≥32 chars, else generated and persisted in DB
//   VOLOROTA_SMTP_HOST/PORT/USER/PASS — (arriving with notifications feature)
const port = Number(process.env.VOLOROTA_PORT ?? process.env.PORT ?? 3000);

export default {
  port,
  fetch: app.fetch,
};
