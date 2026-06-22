require('../../config/env');

const dns = require('dns').promises;

let nodemailer;

function getNodemailer() {
  if (!nodemailer) {
    nodemailer = require('nodemailer');
  }
  return nodemailer;
}

function smtpConfigured() {
  return Boolean(
    process.env.SMTP_HOST
    && process.env.SMTP_PORT
    && process.env.SMTP_USER
    && process.env.SMTP_PASS
    && process.env.SMTP_FROM
  );
}

function resendConfigured() {
  return Boolean(
    process.env.RESEND_API_KEY
    && process.env.RESEND_FROM
  );
}

async function sendWithResend({ to, subject, text }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.RESEND_FROM || '').trim();

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
    }),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || `Resend API failed with status ${response.status}`;
    const error = new Error(message);
    error.code = `RESEND_${response.status}`;
    error.responseCode = response.status;
    throw error;
  }

  return payload;
}

async function buildSmtpTransporter() {
  const smtpHost = String(process.env.SMTP_HOST || '').trim();
  const smtpPort = Number(process.env.SMTP_PORT || 0);
  const smtpUser = String(process.env.SMTP_USER || '').trim();
  const smtpPass = String(process.env.SMTP_PASS || '').replace(/\s+/g, '');
  const smtpFamily = Number(process.env.SMTP_FAMILY || 4);

  let resolvedHost = smtpHost;
  if (smtpHost) {
    try {
      const lookup = await dns.lookup(smtpHost, { family: smtpFamily === 6 ? 6 : 4 });
      resolvedHost = lookup.address || smtpHost;
    } catch {
      resolvedHost = smtpHost;
    }
  }

  const secureSetting = String(process.env.SMTP_SECURE || '').toLowerCase();
  const secure = secureSetting === 'true' || smtpPort === 465;

  return getNodemailer().createTransport({
    host: resolvedHost,
    port: smtpPort,
    secure,
    family: Number.isInteger(smtpFamily) && (smtpFamily === 4 || smtpFamily === 6) ? smtpFamily : 4,
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT || 20000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT || 15000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 30000),
    tls: smtpHost ? { servername: smtpHost } : undefined,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });
}

async function sendTextMail({ to, subject, text }) {
  if (resendConfigured()) {
    return sendWithResend({ to, subject, text });
  }

  const smtpFrom = String(process.env.SMTP_FROM || '').trim();
  const transporter = await buildSmtpTransporter();
  return transporter.sendMail({
    from: smtpFrom,
    to,
    subject,
    text,
  });
}

async function sendTestEmail({ to, subject, text }) {
  if (resendConfigured()) {
    return sendWithResend({ to, subject, text });
  }

  const smtpFrom = String(process.env.SMTP_FROM || '').trim();
  const transporter = await buildSmtpTransporter();
  await transporter.verify();
  return transporter.sendMail({
    from: smtpFrom,
    to,
    subject,
    text,
  });
}

module.exports = {
  smtpConfigured,
  resendConfigured,
  sendTextMail,
  sendTestEmail,
};
