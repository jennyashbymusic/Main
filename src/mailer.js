import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';

const outbox = path.join(cfg.dataDir, 'outbox');

const transport = cfg.smtpHost
  ? nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpPort === 465,
      auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
      pool: true,
      maxConnections: 3,
    })
  : null;

export const mailerMode = () => (transport ? 'smtp' : 'outbox');

/**
 * Send one email. `unsubscribeUrl` adds the List-Unsubscribe headers (one-click, RFC 8058) that
 * Gmail/Yahoo require for bulk senders.
 * With no SMTP_HOST configured, the message is saved as an .html file in ./outbox for previewing.
 */
export async function sendMail({ to, subject, html, text, unsubscribeUrl }) {
  if (!transport) {
    fs.mkdirSync(outbox, { recursive: true });
    const name = `${Date.now()}-${to.replace(/[^a-z0-9@.]/gi, '_')}.html`;
    fs.writeFileSync(path.join(outbox, name), `<!-- to: ${to} | subject: ${subject} -->\n${html}`);
    console.log(`[mail] (no SMTP configured) saved ${path.join(outbox, name)}`);
    return;
  }
  await transport.sendMail({
    from: { name: cfg.fromName, address: cfg.fromEmail },
    to,
    subject,
    html,
    text,
    headers: unsubscribeUrl
      ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      : undefined,
  });
}
