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
    ? `<div class="flash flash-info">
         <strong>Capture mode:</strong> SMTP not configured — emails are captured, not delivered.
         <a href="/admin/outbox">View outbox</a>
       </div>`
    : "";
  const body = `
    <h1>Dashboard</h1>
    ${captureBanner}
    <div class="dash-grid">
      <a class="dash-card" href="/admin/matrix">
        <div class="dash-card-title">Matrix View</div>
        <div class="dash-card-desc">See all upcoming assignments at a glance</div>
      </a>
      <a class="dash-card" href="/admin/people">
        <div class="dash-card-title">People</div>
        <div class="dash-card-desc">Manage your volunteer roster</div>
      </a>
      <a class="dash-card" href="/admin/teams">
        <div class="dash-card-title">Teams</div>
        <div class="dash-card-desc">Define teams, roles, and crew assignments</div>
      </a>
      <a class="dash-card" href="/admin/templates">
        <div class="dash-card-title">Templates</div>
        <div class="dash-card-desc">Configure recurring service schedules</div>
      </a>
      <a class="dash-card" href="/admin/services">
        <div class="dash-card-title">Services</div>
        <div class="dash-card-desc">Generate and manage service instances</div>
      </a>
      <a class="dash-card" href="/admin/outbox">
        <div class="dash-card-title">Email Outbox</div>
        <div class="dash-card-desc">View sent emails and capture log</div>
      </a>
    </div>`;
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
