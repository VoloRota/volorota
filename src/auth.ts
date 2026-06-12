/**
 * AdminAuth — session middleware and login/logout handlers.
 *
 * Security properties:
 *  - Admin password is read from VOLOROTA_ADMIN_PASSWORD at startup.
 *    If unset or empty, the server refuses to start.
 *  - Password compared with crypto.timingSafeEqual against a SHA-256 digest
 *    so naïve timing attacks cannot distinguish "wrong password" from "no match".
 *  - Sessions are signed HttpOnly SameSite=Lax cookies.
 *    Signing secret comes from VOLOROTA_SESSION_SECRET, or is generated once
 *    and persisted in the SQLite kv_store table so sessions survive restarts.
 *  - Brute-force damper: failed login always waits 300 ms before responding,
 *    plus an in-memory attempt counter (5 attempts per IP per 15 min window).
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Database } from "bun:sqlite";
import { layout, escHtml } from "./views/layout.js";

/** Typed Hono env — must match index.ts AppEnv */
export type AuthEnv = { Variables: { db: Database } };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AttemptRecord {
  count: number;
  resetAt: number;
}

// ---------------------------------------------------------------------------
// Config validation — call at process startup
// ---------------------------------------------------------------------------

/**
 * Validates required environment variables.
 * Returns an error string if invalid, or null if valid.
 * Call this before constructing the Hono app.
 */
export function validateAuthConfig(): string | null {
  const pw = process.env.VOLOROTA_ADMIN_PASSWORD;
  if (!pw || pw.trim() === "") {
    return (
      "VOLOROTA_ADMIN_PASSWORD is not set or is empty. " +
      "Set this environment variable to a strong password before starting the server."
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session secret — env var or persisted in SQLite
// ---------------------------------------------------------------------------

let _signingSecret: Uint8Array | null = null;

/**
 * Returns the 32-byte HMAC signing key.
 * Priority: VOLOROTA_SESSION_SECRET env → generated-and-stored in DB.
 */
export function getSigningSecret(db: Database): Uint8Array {
  if (_signingSecret) return _signingSecret;

  const envSecret = process.env.VOLOROTA_SESSION_SECRET;
  if (envSecret && envSecret.length >= 32) {
    _signingSecret = new TextEncoder().encode(envSecret.slice(0, 32));
    return _signingSecret;
  }

  // Ensure kv_store table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const row = db
    .query<{ value: string }, []>("SELECT value FROM kv_store WHERE key = 'session_secret'")
    .get();

  if (row) {
    _signingSecret = hexToBytes(row.value);
    return _signingSecret;
  }

  // Generate and persist a new secret
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const hex = bytesToHex(secret);
  db.query("INSERT INTO kv_store (key, value) VALUES ('session_secret', ?)").run(hex);
  _signingSecret = secret;
  return _signingSecret;
}

/** Reset the cached signing secret (used in tests). */
export function resetSigningSecretCache(): void {
  _signingSecret = null;
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const COOKIE_NAME = "volorota_sess";
const SESSION_MAXAGE = 7 * 24 * 60 * 60; // 7 days in seconds

/** Produce a signed cookie value: base64(payload) + "." + base64(hmac) */
async function signPayload(payload: string, secret: Uint8Array): Promise<string> {
  const keyBuf = secret.buffer.slice(secret.byteOffset, secret.byteOffset + secret.byteLength) as ArrayBuffer;
  const key = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const msgBuf = new TextEncoder().encode(payload).buffer.slice(0) as ArrayBuffer;
  const sig = await crypto.subtle.sign("HMAC", key, msgBuf);
  return `${btoa(payload)}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}

/** Verify and unwrap a signed cookie value. Returns payload or null. */
async function verifyPayload(value: string, secret: Uint8Array): Promise<string | null> {
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const rawPayload = value.slice(0, dot);
  const rawSig = value.slice(dot + 1);

  let payload: string;
  let sigBytes: Uint8Array;
  try {
    payload = atob(rawPayload);
    sigBytes = Uint8Array.from(atob(rawSig), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }

  const keyBuf = secret.buffer.slice(secret.byteOffset, secret.byteOffset + secret.byteLength) as ArrayBuffer;
  const key = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const msgBuf = new TextEncoder().encode(payload).buffer.slice(0) as ArrayBuffer;
  const sigBuf = sigBytes.buffer.slice(sigBytes.byteOffset, sigBytes.byteOffset + sigBytes.byteLength) as ArrayBuffer;
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBuf,
    msgBuf
  );
  if (!valid) return null;

  // Parse JSON session payload and check expiry
  try {
    const obj = JSON.parse(payload) as { admin: boolean; exp: number };
    if (!obj.admin || typeof obj.exp !== "number") return null;
    if (Date.now() > obj.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Password comparison — constant-time
// ---------------------------------------------------------------------------

async function sha256(text: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", encoded.buffer.slice(0) as ArrayBuffer);
  return new Uint8Array(buf);
}

/** Returns true if the submitted password matches the configured admin password. */
async function passwordMatches(submitted: string): Promise<boolean> {
  const configured = process.env.VOLOROTA_ADMIN_PASSWORD ?? "";
  // Compare digests via timingSafeEqual to prevent timing side channels
  const [a, b] = await Promise.all([sha256(submitted), sha256(configured)]);
  // Both are 32 bytes — same length guaranteed
  try {
    // Bun exposes crypto.timingSafeEqual via node:crypto
    const { timingSafeEqual } = await import("node:crypto");
    return timingSafeEqual(a, b);
  } catch {
    // Fallback: manual constant-time compare
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    }
    return diff === 0;
  }
}

// ---------------------------------------------------------------------------
// Brute-force damper (in-memory; resets on restart, acceptable for v1)
// ---------------------------------------------------------------------------

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;
const FAIL_DELAY_MS = 300;

const _attempts = new Map<string, AttemptRecord>();

function getClientIp(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown"
  );
}

function isRateLimited(ip: string): boolean {
  const record = _attempts.get(ip);
  if (!record) return false;
  if (Date.now() > record.resetAt) {
    _attempts.delete(ip);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const record = _attempts.get(ip);
  if (!record || now > record.resetAt) {
    _attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
  } else {
    record.count += 1;
  }
}

function clearAttempts(ip: string): void {
  _attempts.delete(ip);
}

/** Reset all attempt records — used in tests only. */
export function resetAttemptRecords(): void {
  _attempts.clear();
}

// ---------------------------------------------------------------------------
// Middleware — gates all /admin/* routes except /admin/login
// ---------------------------------------------------------------------------

/** Returns the DB instance from context (set via c.set in index.ts). */
function requireDb(c: Context<AuthEnv>): Database {
  return c.get("db");
}

/**
 * Auth middleware for /admin/* (except /admin/login and /admin/logout).
 * Mount with: app.use("/admin/*", authMiddleware)
 * Note: /admin/login and /admin/logout are registered BEFORE this middleware
 * is applied by mounting them on a separate router path, or by checking the
 * path prefix inside this handler.
 */
export const authMiddleware: MiddlewareHandler<AuthEnv> = async (c: Context<AuthEnv>, next: Next) => {
  const path = new URL(c.req.url).pathname;

  // /admin/login and /admin/logout are explicitly excluded
  if (path === "/admin/login" || path === "/admin/logout") {
    return next();
  }

  const db = requireDb(c);
  const secret = getSigningSecret(db);
  const cookieValue = getCookie(c, COOKIE_NAME);

  if (cookieValue) {
    const payload = await verifyPayload(cookieValue, secret);
    if (payload !== null) {
      return next();
    }
  }

  // Determine if this is an HTML (browser) request
  const accept = c.req.header("Accept") ?? "";
  const wantsHtml = accept.includes("text/html");

  if (wantsHtml) {
    return c.redirect("/admin/login", 302);
  }
  return c.text("Unauthorized", 401);
};

// ---------------------------------------------------------------------------
// Login page render helper
// ---------------------------------------------------------------------------

function loginPage(errorMsg: string | null = null): string {
  const err =
    errorMsg
      ? `<div class="flash flash-error">${escHtml(errorMsg)}</div>`
      : "";

  // ISC-58: optional hint from env — e.g. the demo can publish the password here.
  // Escaped to prevent HTML injection; unset → no element.
  const rawHint = process.env.VOLOROTA_LOGIN_HINT;
  const hint = rawHint
    ? `<p class="login-hint">${escHtml(rawHint)}</p>`
    : "";

  return layout(
    "Login",
    `<div class="login-page">
      <div class="login-card">
        <div class="login-wordmark">
          <div class="wordmark-text">
            <span class="wordmark-dot"></span>VoloRota
          </div>
          <div class="wordmark-sub">Church Volunteer Scheduler</div>
        </div>
        ${err}
        <form method="POST" action="/admin/login">
          <div class="form-row">
            <label for="password">Admin password</label>
            <input id="password" type="password" name="password" autofocus autocomplete="current-password" />
          </div>
          <button type="submit" style="width:100%;margin-top:.5rem">Sign in</button>
        </form>
        ${hint}
      </div>
    </div>`,
    { loggedIn: false }
  );
}

// ---------------------------------------------------------------------------
// Login / logout handlers — attach to your Hono app
// ---------------------------------------------------------------------------

/**
 * GET /admin/login
 */
export async function handleLoginGet(c: Context<AuthEnv>): Promise<Response> {
  return c.html(loginPage(), 200);
}

/**
 * POST /admin/login
 */
export async function handleLoginPost(c: Context<AuthEnv>): Promise<Response> {
  const ip = getClientIp(c);

  if (isRateLimited(ip)) {
    await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
    return c.html(loginPage("Too many failed attempts. Please wait before trying again."), 429);
  }

  const body = await c.req.parseBody();
  const submitted = typeof body["password"] === "string" ? body["password"] : "";

  const ok = await passwordMatches(submitted);

  if (!ok) {
    recordFailure(ip);
    await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
    return c.html(loginPage("Incorrect password."), 200);
  }

  clearAttempts(ip);

  const db = requireDb(c);
  const secret = getSigningSecret(db);

  const payload = JSON.stringify({ admin: true, exp: Date.now() + SESSION_MAXAGE * 1000 });
  const signed = await signPayload(payload, secret);

  // ISC-62: Secure flag is set automatically when VOLOROTA_BASE_URL starts with
  // https:// — no separate env required. Omitted on plain HTTP so local dev works.
  const isHttps = (process.env.VOLOROTA_BASE_URL ?? "").startsWith("https://");
  setCookie(c, COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_MAXAGE,
    path: "/",
    secure: isHttps,
  });

  return c.redirect("/admin", 302);
}

/**
 * POST /admin/logout
 */
export function handleLogout(c: Context<AuthEnv>): Response {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.redirect("/admin/login", 302);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
