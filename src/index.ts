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
import { getSetupChecklist } from "./db/onboarding.js";

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

// Security headers — applied globally before any route (ISC-61)
// CSP: no JS in the app; inline styles used by volunteer layout + interstitials;
// favicon is a data URI so img-src must allow data:.
const CSP =
  "default-src 'self'; " +
  "script-src 'none'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "frame-ancestors 'none'; " +
  "form-action 'self'; " +
  "base-uri 'none'";

app.use("*", (c, next) => {
  c.res.headers.set("Content-Security-Policy", CSP);
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  c.res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return next();
});

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
  const db = getDb();
  const checklist = getSetupChecklist(db);

  const isCaptureMode = !process.env.VOLOROTA_SMTP_HOST;
  const captureBanner = isCaptureMode
    ? `<div class="flash flash-info">
         <strong>Capture mode:</strong> SMTP not configured — emails are captured, not delivered.
         <a href="/admin/outbox">View outbox</a>
       </div>`
    : "";

  // ISC-64: warn when BASE_URL is unset or still points at localhost
  const baseUrl = process.env.VOLOROTA_BASE_URL ?? "";
  const baseUrlIsLocal =
    !baseUrl ||
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1");
  const baseUrlWarning = baseUrlIsLocal
    ? `<div class="flash flash-warn">
         <strong>Configuration notice:</strong> Emailed links will point at localhost — set
         <code>VOLOROTA_BASE_URL</code> to your public URL so volunteers can open their links.
       </div>`
    : "";

  // Setup checklist — only shown while no assignment exists (ISC-56).
  // Once at least one assignment is present the checklist is permanently absent.
  function checklistStep(done: boolean, text: string, href: string): string {
    if (done) {
      return `<li class="setup-step setup-step-done">
        <span class="setup-step-icon" aria-hidden="true">&#10003;</span>
        <span>${text}</span>
      </li>`;
    }
    return `<li class="setup-step">
      <span class="setup-step-icon" aria-hidden="true">&#9675;</span>
      <a href="${href}">${text}</a>
    </li>`;
  }

  const setupChecklist = checklist.hasAssignment ? "" : `
    <div class="setup-checklist">
      <h2 class="setup-checklist-title">Getting started</h2>
      <ol class="setup-steps">
        ${checklistStep(checklist.hasPeople, "Add at least one person to your roster", "/admin/people")}
        ${checklistStep(checklist.hasTeamWithRole, "Create a team and add roles to it", "/admin/teams")}
        ${checklistStep(checklist.hasTeamMember, "Add members to your teams", "/admin/teams")}
        ${checklistStep(checklist.hasTemplateWithRole, "Create a service template with roles", "/admin/templates")}
        ${checklistStep(checklist.hasAssignment, "Generate services and run auto-fill", "/admin/services")}
      </ol>
    </div>`;

  const body = `
    <h1>Dashboard</h1>
    ${captureBanner}
    ${baseUrlWarning}
    ${setupChecklist}
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
//   VOLOROTA_BASE_URL      — optional; public URL used in emailed links (ISC-62, ISC-64)
//   VOLOROTA_LOGIN_HINT    — optional; hint text shown beneath the admin login form (ISC-58)
//   VOLOROTA_SMTP_HOST/PORT/USER/PASS/FROM/SECURE — optional; capture mode when unset
//   VOLOROTA_ADMIN_EMAIL   — optional; leader-notification fallback recipient
//   VOLOROTA_REMINDER_DAYS — optional; default "3", comma-separated (e.g. "7,3")
//   VOLOROTA_SERVICE_MINUTES — optional; ICS event duration, default 75
const port = Number(process.env.VOLOROTA_PORT ?? process.env.PORT ?? 3000);

export default {
  port,
  fetch: app.fetch,
};
