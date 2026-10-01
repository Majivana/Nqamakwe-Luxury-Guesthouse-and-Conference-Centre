const nodemailer = require("nodemailer");

function createMailer(env) {
  if (!env.SMTP_HOST) {
    if (env.SMTP_USER || env.SMTP_PASSWORD) {
      throw new Error("SMTP_HOST is required when SMTP credentials are configured.");
    }
    return null;
  }
  if (!env.MAIL_FROM) throw new Error("MAIL_FROM is required when SMTP_HOST is configured.");
  const port = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be a valid TCP port.");
  }
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) {
    throw new Error("SMTP_USER and SMTP_PASSWORD must be configured together.");
  }
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE === "true",
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined
  });
  transporter.mailFrom = env.MAIL_FROM;
  return transporter;
}

function enqueueEmail(db, { recipient, subject, text, html = "" }) {
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return null;
  const result = db.prepare(`
    INSERT INTO email_outbox (recipient, subject, text_body, html_body)
    VALUES (?, ?, ?, ?)
  `).run(recipient, subject.slice(0, 200), text.slice(0, 12000), html.slice(0, 30000));
  return Number(result.lastInsertRowid);
}

async function flushEmailOutbox(db, transporter, limit = 20) {
  if (!transporter) return { sent: 0, queued: db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE status = 'queued'").get().count };
  db.prepare(`
    UPDATE email_outbox SET status = 'queued'
    WHERE status = 'sending' AND next_attempt_at <= datetime('now')
  `).run();
  const messages = db.prepare(`
    SELECT id, recipient, subject, text_body, html_body, attempts
    FROM email_outbox
    WHERE status = 'queued' AND next_attempt_at <= datetime('now')
    ORDER BY id LIMIT ?
  `).all(limit);
  let sent = 0;
  for (const message of messages) {
    const claimed = db.prepare(`
      UPDATE email_outbox SET status = 'sending',
        next_attempt_at = datetime('now', '+10 minutes')
      WHERE id = ? AND status = 'queued'
    `).run(message.id);
    if (!claimed.changes) continue;
    try {
      await transporter.sendMail({
        from: transporter.mailFrom || process.env.MAIL_FROM,
        to: message.recipient,
        subject: message.subject,
        text: message.text_body,
        ...(message.html_body ? { html: message.html_body } : {})
      });
      db.prepare(`
        UPDATE email_outbox SET status = 'sent', attempts = attempts + 1,
          sent_at = datetime('now'), last_error = '' WHERE id = ? AND status = 'sending'
      `).run(message.id);
      sent += 1;
    } catch (error) {
      const attempts = message.attempts + 1;
      const failed = attempts >= 8;
      const delayMinutes = Math.min(60, 2 ** Math.min(attempts, 6));
      db.prepare(`
        UPDATE email_outbox SET status = ?, attempts = ?,
          next_attempt_at = datetime('now', ?), last_error = ?
        WHERE id = ? AND status = 'sending'
      `).run(failed ? "failed" : "queued", attempts, `+${delayMinutes} minutes`, String(error.message).slice(0, 500), message.id);
    }
  }
  const queued = db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE status IN ('queued', 'sending')").get().count;
  return { sent, queued };
}

module.exports = { createMailer, enqueueEmail, flushEmailOutbox };
