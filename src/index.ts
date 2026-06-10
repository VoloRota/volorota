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
import { volunteerRouter } from "./routes/volunteer.js";
import { adminVolunteerRouter } from "./routes/admin-volunteer.js";
import { outboxRouter } from "./routes/outbox.js";
import { exportRouter, printRouter } from "./routes/export.js";
import { layout } from "./views/layout.js";
import {
  validateAuthConfig,
  authMiddleware,
  handleLoginGet,
  handleLoginPost,
  handleLogout,
  type AuthEnv,
} from "./auth.js";
import { setTransport } from "./mail/mailer.js";
import { buildSmtpTransportFromEnv } from "./mail/smtp.js";
import { runReminderCheck } from "./notifications/reminders.js";

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

// Activate SMTP transport if configured (ISC-34)
const smtpTransport = buildSmtpTransportFromEnv();
if (smtpTransport) {
  setTransport(smtpTransport);
}

// Start reminder check loop (ISC-35) — every 15 minutes
// ONLY started here (server startup), never on module import
const REMINDER_INTERVAL_MS = 15 * 60 * 1000;
setInterval(() => {
  runReminderCheck(getDb(), new Date()).catch((err) => {
    console.error("[reminders] Check failed:", err);
  });
}, REMINDER_INTERVAL_MS);

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
  const isCaptureMode = !process.env.VOLOROTA_SMTP_HOST;
  const captureBanner = isCaptureMode
    ? `<div class="flash flash-info" style="margin:.5rem 0 1rem">
         <strong>Capture mode:</strong> SMTP not configured — emails are captured, not delivered.
         <a href="/admin/outbox">View outbox</a>
       </div>`
    : "";
  const body = `
    <h1>VoloRota Admin</h1>
    ${captureBanner}
    <p>Welcome to the VoloRota church volunteer scheduler.</p>
    <ul>
      <li><a href="/admin/matrix">Matrix View</a> — see all upcoming assignments at a glance</li>
      <li><a href="/admin/people">People</a> — manage your volunteer roster</li>
      <li><a href="/admin/teams">Teams</a> — define teams, roles, and crew assignments</li>
      <li><a href="/admin/templates">Templates</a> — configure recurring service schedules</li>
      <li><a href="/admin/services">Services</a> — generate and manage service instances</li>
      <li><a href="/admin/outbox">Email Outbox</a> — view sent emails and capture log</li>
    </ul>`;
  return c.html(layout("Dashboard", body));
});

// Mount routers
app.route("/admin/people", peopleRouter);
app.route("/admin/people", blockoutsRouter);
app.route("/admin/teams", teamsRouter);
app.route("/admin/templates", templatesRouter);
// exportRouter must mount before servicesRouter: its literal /export.csv
// would otherwise be swallowed by servicesRouter's /:id param route
app.route("/admin/services", exportRouter);
app.route("/admin/services", servicesRouter);
app.route("/admin/matrix", matrixRouter);
app.route("/admin/outbox", outboxRouter);

// Admin volunteer touchpoints (inside auth gate via /admin/* middleware above)
app.route("/admin/people", adminVolunteerRouter);
app.route("/admin/services", adminVolunteerRouter);

// Print route (inside auth gate)
app.route("/admin/print", printRouter);

// Volunteer surface — OUTSIDE the admin auth gate
app.route("/v", volunteerRouter);

// Env vars:
//   VOLOROTA_PORT          — listening port (default: PORT ?? 3000)
//   VOLOROTA_DB            — path to SQLite file (default: ./data/volorota.db)
//   VOLOROTA_ADMIN_PASSWORD — required; admin login password
//   VOLOROTA_SESSION_SECRET — optional; ≥32 chars, else generated and persisted in DB
//   VOLOROTA_SMTP_HOST/PORT/USER/PASS/FROM/SECURE — optional; capture mode when unset
//   VOLOROTA_ADMIN_EMAIL   — optional; leader-notification fallback recipient
//   VOLOROTA_REMINDER_DAYS — optional; default "3", comma-separated (e.g. "7,3")
//   VOLOROTA_SERVICE_MINUTES — optional; ICS event duration, default 75
const port = Number(process.env.VOLOROTA_PORT ?? process.env.PORT ?? 3000);

export default {
  port,
  fetch: app.fetch,
};
