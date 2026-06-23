/**
 * Settings route test suite
 *
 * Covers:
 *   1. GET /admin/settings renders SMTP status (capture mode)
 *   2. GET /admin/settings renders SMTP status (SMTP mode)
 *   3. POST /test-email in capture mode → captures to outbox, redirects with success msg
 *   4. POST /test-email with blank address → redirects with error
 *   5. POST /test-email with invalid address → redirects with error
 *   6. POST /test-email in SMTP mode when transport throws → redirects with error detail
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";

import { applySchema, setDb } from "../src/db/schema.js";
import { authMiddleware, handleLoginGet, handleLoginPost, handleLogout, type AuthEnv } from "../src/auth.js";
import { settingsRouter } from "../src/routes/settings.js";
import {
  resetToCaptureTransport,
  getCapturedMail,
  clearCapturedMail,
  setTransport,
  type MailTransport,
} from "../src/mail/mailer.js";

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

const TEST_PASSWORD = "TestPass!99";

function buildApp(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });

  app.get("/admin/login", handleLoginGet);
  app.post("/admin/login", handleLoginPost);
  app.post("/admin/logout", handleLogout);
  app.use("/admin/*", authMiddleware);
  app.route("/admin/settings", settingsRouter);

  return app;
}

async function login(app: Hono<AuthEnv>): Promise<string> {
  const res = await app.request("/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(TEST_PASSWORD)}`,
  });
  const cookie = res.headers.get("Set-Cookie") ?? "";
  return cookie.split(";")[0] ?? "";
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let db: Database;
let app: Hono<AuthEnv>;
let cookie: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  setDb(db);
  resetToCaptureTransport();
  clearCapturedMail();

  savedEnv.VOLOROTA_ADMIN_PASSWORD = process.env.VOLOROTA_ADMIN_PASSWORD;
  savedEnv.VOLOROTA_SMTP_HOST = process.env.VOLOROTA_SMTP_HOST;
  savedEnv.VOLOROTA_ADMIN_EMAIL = process.env.VOLOROTA_ADMIN_EMAIL;

  process.env.VOLOROTA_ADMIN_PASSWORD = TEST_PASSWORD;
  delete process.env.VOLOROTA_SMTP_HOST;
  delete process.env.VOLOROTA_ADMIN_EMAIL;

  app = buildApp(db);
  cookie = await login(app);
});

afterEach(() => {
  db.close();
  resetToCaptureTransport();
  clearCapturedMail();

  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("GET /admin/settings renders capture-mode status", async () => {
  const res = await app.request("/admin/settings", {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Capture mode");
  expect(html).toContain("Send test email");
  expect(html).toContain("VOLOROTA_SMTP_HOST");
});

test("GET /admin/settings renders SMTP-active status", async () => {
  process.env.VOLOROTA_SMTP_HOST = "smtp.example.com";
  process.env.VOLOROTA_SMTP_PORT = "587";
  const res = await app.request("/admin/settings", {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("SMTP active");
  expect(html).toContain("smtp.example.com");
});

test("GET /admin/settings pre-fills VOLOROTA_ADMIN_EMAIL in the to field", async () => {
  process.env.VOLOROTA_ADMIN_EMAIL = "admin@church.org";
  const res = await app.request("/admin/settings", {
    headers: { Cookie: cookie },
  });
  const html = await res.text();
  expect(html).toContain("admin@church.org");
});

test("POST /test-email in capture mode captures message and redirects with success", async () => {
  const res = await app.request("/admin/settings/test-email", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "to=test%40example.com",
  });
  expect(res.status).toBe(302);
  const location = res.headers.get("Location") ?? "";
  expect(location).toContain("/admin/settings");
  expect(location).toContain("msg=");
  expect(location).not.toContain("err=");

  const captured = getCapturedMail();
  expect(captured).toHaveLength(1);
  const [first] = captured;
  expect(first?.to).toBe("test@example.com");
  expect(first?.subject).toBe("[VoloRota] Test email");
});

test("POST /test-email stores message in outbox table", async () => {
  await app.request("/admin/settings/test-email", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "to=outbox%40example.com",
  });
  const row = db
    .query("SELECT * FROM outbox WHERE to_email = ?")
    .get("outbox@example.com") as { subject: string; transport: string } | null;
  expect(row).not.toBeNull();
  expect(row!.subject).toBe("[VoloRota] Test email");
  expect(row!.transport).toBe("capture");
});

test("POST /test-email with empty address redirects with error", async () => {
  const res = await app.request("/admin/settings/test-email", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "to=",
  });
  expect(res.status).toBe(302);
  const location = res.headers.get("Location") ?? "";
  expect(location).toContain("err=");
  expect(getCapturedMail()).toHaveLength(0);
});

test("POST /test-email with address missing @ redirects with error", async () => {
  const res = await app.request("/admin/settings/test-email", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "to=notanemail",
  });
  expect(res.status).toBe(302);
  const location = res.headers.get("Location") ?? "";
  expect(location).toContain("err=");
  expect(getCapturedMail()).toHaveLength(0);
});

test("POST /test-email when transport throws redirects with error detail", async () => {
  const brokenTransport: MailTransport = {
    async send() {
      throw new Error("Connection refused");
    },
  };
  setTransport(brokenTransport);

  const res = await app.request("/admin/settings/test-email", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "to=test%40example.com",
  });
  expect(res.status).toBe(302);
  const location = res.headers.get("Location") ?? "";
  expect(location).toContain("err=");
  expect(decodeURIComponent(location)).toContain("Connection refused");
});
