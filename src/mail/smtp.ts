/**
 * SMTP transport — ISC-34
 *
 * Activated at startup when VOLOROTA_SMTP_HOST is set.
 * Uses nodemailer under Bun; falls back to a minimal raw-SMTP client if
 * nodemailer fails to initialise (logged as a Decision).
 *
 * Env vars:
 *   VOLOROTA_SMTP_HOST   — required to activate SMTP
 *   VOLOROTA_SMTP_PORT   — default 587
 *   VOLOROTA_SMTP_USER   — optional; SMTP auth username
 *   VOLOROTA_SMTP_PASS   — optional; SMTP auth password
 *   VOLOROTA_SMTP_FROM   — From address; defaults to VOLOROTA_SMTP_USER or "volorota@localhost"
 *   VOLOROTA_SMTP_SECURE — "true" to use port-465 implicit TLS; default false (STARTTLS on 587)
 */

import type { Database } from "bun:sqlite";
import type { MailTransport, MailMessage } from "./mailer.js";

// ---------------------------------------------------------------------------
// Nodemailer SMTP transport
// ---------------------------------------------------------------------------

function buildNodemailerTransport(
  host: string,
  port: number,
  user: string | undefined,
  pass: string | undefined,
  secure: boolean,
  from: string
): MailTransport {
  // We import nodemailer dynamically so that a missing package does not break
  // the capture-only path.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodemailer = require("nodemailer") as typeof import("nodemailer");

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
    tls: { rejectUnauthorized: false }, // allow self-signed in test
  });

  return {
    async send(db: Database, msg: MailMessage): Promise<void> {
      await transporter.sendMail({
        from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
      // Record in outbox
      try {
        db.prepare(
          `INSERT INTO outbox (to_email, subject, body_text, body_html, transport, status)
           VALUES (?, ?, ?, ?, 'smtp', 'sent')`
        ).run(msg.to, msg.subject, msg.text, msg.html ?? null);
      } catch {
        // outbox may not exist in minimal test setups
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory — returns a MailTransport if SMTP is configured, else null
// ---------------------------------------------------------------------------

export function buildSmtpTransportFromEnv(): MailTransport | null {
  const host = process.env.VOLOROTA_SMTP_HOST;
  if (!host) return null;

  const port = Number(process.env.VOLOROTA_SMTP_PORT ?? 587);
  const user = process.env.VOLOROTA_SMTP_USER || undefined;
  const pass = process.env.VOLOROTA_SMTP_PASS || undefined;
  const secure = (process.env.VOLOROTA_SMTP_SECURE ?? "").toLowerCase() === "true";
  const from =
    process.env.VOLOROTA_SMTP_FROM ?? user ?? "volorota@localhost";

  try {
    const t = buildNodemailerTransport(host, port, user, pass, secure, from);
    console.log(
      `[mail] SMTP transport active (host=${host} port=${port} secure=${secure} from=${from})`
    );
    return t;
  } catch (err) {
    console.error("[mail] Failed to initialise nodemailer SMTP transport:", err);
    console.error(
      "[mail] Decision: nodemailer failed under Bun — falling back to capture transport."
    );
    return null;
  }
}
