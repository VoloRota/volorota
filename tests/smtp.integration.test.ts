/**
 * SMTP integration test — ISC-34
 *
 * Spins up a Mailpit container (docker run axllent/mailpit), sends a message
 * through the SMTP transport, asserts the message via Mailpit's HTTP API,
 * then cleans up the container.
 *
 * The test SKIPS (not fails) if Docker is unavailable.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema, setDb } from "../src/db/schema.js";
import {
  setTransport,
  resetToCaptureTransport,
  sendMail,
  clearCapturedMail,
} from "../src/mail/mailer.js";
import { buildSmtpTransportFromEnv } from "../src/mail/smtp.js";

// ---------------------------------------------------------------------------
// Docker availability check
// ---------------------------------------------------------------------------

async function isDockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "info"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    return exit === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Port utilities
// ---------------------------------------------------------------------------

function randomPort(min = 40000, max = 49999): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let dockerAvailable = false;
let smtpPort = 0;
let httpPort = 0;
let containerId = "";
let db: Database;

beforeAll(async () => {
  dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) return;

  smtpPort = randomPort();
  httpPort = randomPort(50000, 59999);

  // Start Mailpit
  const proc = Bun.spawn([
    "docker", "run", "-d",
    "-p", `127.0.0.1:${smtpPort}:1025`,
    "-p", `127.0.0.1:${httpPort}:8025`,
    "axllent/mailpit",
  ], { stdout: "pipe", stderr: "pipe" });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    dockerAvailable = false;
    return;
  }

  const stdout = await new Response(proc.stdout).text();
  containerId = stdout.trim();

  // Wait for Mailpit to be ready (up to 10s)
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${httpPort}/api/v1/messages`);
      if (res.ok) { ready = true; break; }
    } catch { /* not ready yet */ }
  }

  if (!ready) {
    dockerAvailable = false;
    // Clean up container we started
    Bun.spawn(["docker", "rm", "-f", containerId]);
    return;
  }

  // Set up DB
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  setDb(db);
});

afterAll(async () => {
  resetToCaptureTransport();
  if (containerId) {
    await Bun.spawn(["docker", "rm", "-f", containerId]).exited;
  }
  if (db) db.close();
});

// ---------------------------------------------------------------------------
// ISC-34: SMTP delivery test
// ---------------------------------------------------------------------------

test("ISC-34: SMTP transport delivers email through Mailpit", async () => {
  if (!dockerAvailable) {
    console.log("[smtp.integration] Docker not available — skipping");
    return;
  }

  // Configure SMTP transport pointing at Mailpit
  process.env.VOLOROTA_SMTP_HOST = "127.0.0.1";
  process.env.VOLOROTA_SMTP_PORT = String(smtpPort);
  process.env.VOLOROTA_SMTP_FROM = "volorota-test@example.com";
  delete process.env.VOLOROTA_SMTP_USER;
  delete process.env.VOLOROTA_SMTP_PASS;
  delete process.env.VOLOROTA_SMTP_SECURE;

  const transport = buildSmtpTransportFromEnv();
  expect(transport).not.toBeNull();
  setTransport(transport!);

  clearCapturedMail();

  const uniqueSubject = `ISC-34 test ${Date.now()}`;

  await sendMail(db, {
    to: "volunteer@example.com",
    subject: uniqueSubject,
    text: "This is a test email from the SMTP integration test.",
    html: "<p>This is a test email from the SMTP integration test.</p>",
  });

  // Give Mailpit a moment to ingest
  await Bun.sleep(500);

  // Query Mailpit API
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/v1/messages`);
  expect(res.ok).toBe(true);

  const data = (await res.json()) as { messages: Array<{ Subject: string; To: Array<{ Address: string }> }> };
  const messages = data.messages ?? [];

  const found = messages.find((m) => m.Subject === uniqueSubject);
  expect(found).toBeDefined();
  expect(found!.To[0]?.Address).toBe("volunteer@example.com");

  // Verify outbox row was written with transport = 'smtp'
  const outboxRow = db
    .query("SELECT * FROM outbox WHERE subject = ? AND transport = 'smtp'")
    .get(uniqueSubject) as { transport: string; status: string } | null;
  expect(outboxRow).not.toBeNull();
  expect(outboxRow!.status).toBe("sent");

  // Cleanup env
  delete process.env.VOLOROTA_SMTP_HOST;
  delete process.env.VOLOROTA_SMTP_PORT;
  delete process.env.VOLOROTA_SMTP_FROM;

  resetToCaptureTransport();
}, 30000); // 30s timeout for docker startup
