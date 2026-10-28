/**
 * SMS transport abstraction — provider-agnostic reminder channel.
 *
 * Interface: sendSms({ to, body })
 *
 * Default transport: CAPTURE
 *   - Appends to an in-memory array accessible to tests (getCapturedSms).
 *   - Also writes to the `sms_outbox` table in SQLite (admin-viewable).
 *
 * Provider selection is env-driven so self-hosters bring their own account:
 *   VOLOROTA_SMS_PROVIDER = "capture" (default) | "twilio"
 *   VOLOROTA_TWILIO_ACCOUNT_SID / VOLOROTA_TWILIO_AUTH_TOKEN / VOLOROTA_TWILIO_FROM
 *
 * The Twilio implementation uses fetch against the REST API directly — no SDK
 * dependency. Other providers (Telnyx, SignalWire, ...) slot in the same way:
 * implement SmsTransport, register it in getSmsTransport().
 *
 * Consent is handled upstream: callers only invoke sendSms for people with
 * sms_opt_in. Message bodies must carry opt-out language where the channel
 * allows replies (see reminders.ts).
 */

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Message + transport types
// ---------------------------------------------------------------------------

export interface SmsMessage {
  to: string;
  body: string;
}

export interface SmsTransport {
  readonly name: string;
  send(db: Database, msg: SmsMessage): Promise<void>;
}

// ---------------------------------------------------------------------------
// CAPTURE transport (default) — in-memory + sms_outbox
// ---------------------------------------------------------------------------

let capturedSms: Array<SmsMessage & { transport: string }> = [];

export function getCapturedSms(): Array<SmsMessage & { transport: string }> {
  return capturedSms;
}

export function clearCapturedSms(): void {
  capturedSms = [];
}

const captureTransport: SmsTransport = {
  name: "capture",
  async send(db, msg) {
    capturedSms.push({ ...msg, transport: "capture" });
    recordOutbox(db, msg, "capture", "sent");
  },
};

// ---------------------------------------------------------------------------
// Twilio transport — REST API via fetch, no SDK
// ---------------------------------------------------------------------------

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string;
}

export function createTwilioTransport(cfg: TwilioConfig): SmsTransport {
  return {
    name: "twilio",
    async send(db, msg) {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`;
      const basic = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: msg.to,
          From: cfg.from,
          Body: msg.body,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Twilio send failed (${res.status}): ${detail.slice(0, 300)}`);
      }
      recordOutbox(db, msg, "twilio", "sent");
    },
  };
}

// ---------------------------------------------------------------------------
// Outbox record — mirrors the email outbox pattern (volunteer/tokens.ts)
// ---------------------------------------------------------------------------

function ensureSmsOutbox(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sms_outbox (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      to_phone    TEXT    NOT NULL,
      body        TEXT    NOT NULL,
      transport   TEXT    NOT NULL DEFAULT 'capture',
      status      TEXT    NOT NULL DEFAULT 'sent',
      sent_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function recordOutbox(
  db: Database,
  msg: SmsMessage,
  transport: string,
  status: string
): void {
  try {
    ensureSmsOutbox(db);
    db.prepare(
      "INSERT INTO sms_outbox (to_phone, body, transport, status) VALUES (?, ?, ?, ?)"
    ).run(msg.to, msg.body, transport, status);
  } catch (err) {
    // Outbox is observability, never the send path — don't fail sends on it.
    console.error("[sms] outbox record failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------

let overrideTransport: SmsTransport | null = null;

/** Test hook — override the selected transport (null restores env-driven). */
export function setSmsTransport(t: SmsTransport | null): void {
  overrideTransport = t;
}

export function getSmsTransport(db?: Database): SmsTransport {
  if (overrideTransport) return overrideTransport;
  const provider = (process.env.VOLOROTA_SMS_PROVIDER ?? "capture").toLowerCase();
  if (provider === "twilio") {
    const sid = process.env.VOLOROTA_TWILIO_ACCOUNT_SID;
    const token = process.env.VOLOROTA_TWILIO_AUTH_TOKEN;
    const from = process.env.VOLOROTA_TWILIO_FROM;
    if (!sid || !token || !from) {
      console.error(
        "[sms] VOLOROTA_SMS_PROVIDER=twilio but TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM missing — falling back to capture"
      );
      return captureTransport;
    }
    return createTwilioTransport({ accountSid: sid, authToken: token, from });
  }
  if (provider !== "capture") {
    console.error(`[sms] unknown VOLOROTA_SMS_PROVIDER "${provider}" — using capture`);
  }
  return captureTransport;
}

// ---------------------------------------------------------------------------
// Public send API — the single entry point for the SMS channel
// ---------------------------------------------------------------------------

export async function sendSms(db: Database, msg: SmsMessage): Promise<void> {
  const transport = getSmsTransport(db);
  await transport.send(db, msg);
}
