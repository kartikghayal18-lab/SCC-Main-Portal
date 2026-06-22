require('../../config/env');

const crypto = require('crypto');
const { getClientConfig } = require('../../config/client');
const { smtpConfigured, resendConfigured, sendTextMail, sendTestEmail } = require('../mail/mailer');

const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 10;

function generateOtpCode() {
  return String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

function normalizePhoneNumber(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return `+${digits}`;
}

function maskEmail(value) {
  const email = String(value || '').trim();
  if (!email.includes('@')) return email;
  const [name, domain] = email.split('@');
  if (name.length <= 2) return `${name[0] || '*'}*@${domain}`;
  return `${name.slice(0, 2)}${'*'.repeat(Math.max(name.length - 2, 1))}@${domain}`;
}

function maskPhone(value) {
  const phone = normalizePhoneNumber(value);
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return `+${digits}`;
  return `+${digits.slice(0, Math.max(digits.length - 4, 2)).replace(/\d/g, '*')}${digits.slice(-4)}`;
}

function getOtpChannelOptions({ email, contactPhone }) {
  const emailDeliveryConfigured = smtpConfigured() || resendConfigured();
  return {
    email: {
      available: Boolean(email) && emailDeliveryConfigured,
      value: String(email || '').trim().toLowerCase(),
      masked: maskEmail(email),
      reason: !email ? 'No email saved for this admin account' : (!emailDeliveryConfigured ? 'Email delivery is not configured yet' : null),
    },
    sms: {
      available: false,
      value: '',
      masked: '',
      reason: 'SMS OTP is disabled. Use email OTP.',
    },
  };
}

function getPurposeLabel(purpose) {
  if (purpose === 'forgot-password') return 'password reset';
  if (purpose === 'login-2fa') return 'sign in verification';
  if (purpose === 'settings-password-change') return 'password change';
  return 'security verification';
}

async function sendEmailOtp({ to, otpCode, adminName, className, purpose }) {
  const clientConfig = getClientConfig();
  const purposeLabel = getPurposeLabel(purpose);
  const portalName = String(className || clientConfig.clientName || 'Coaching Portal').trim();
  const subject = `OTP for ${purposeLabel} - ${portalName}`;
  const text = [
    `Hello ${adminName},`,
    '',
    `Your ${clientConfig.clientName} OTP is: ${otpCode}`,
    `This OTP is valid for ${OTP_TTL_MINUTES} minutes.`,
    '',
    `Purpose: ${purposeLabel}`,
    '',
    `Portal: ${portalName}`,
    '',
    clientConfig.supportEmail ? `Support: ${clientConfig.supportEmail}` : null,
    'If you did not request this, please ignore this message.',
  ].filter(Boolean).join('\n');

  await sendTextMail({ to, subject, text });
}

async function sendOtpMessage({ channel, destination, otpCode, adminName, className, purpose }) {
  if (channel === 'email') {
    await sendEmailOtp({
      to: destination,
      otpCode,
      adminName,
      className,
      purpose,
    });
    return;
  }

  throw new Error('Only email OTP is enabled');
}

module.exports = {
  OTP_TTL_MINUTES,
  generateOtpCode,
  smtpConfigured,
  resendConfigured,
  getOtpChannelOptions,
  sendOtpMessage,
  sendTestEmail,
};
