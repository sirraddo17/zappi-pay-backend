const fetch = require('node-fetch');

const SUPPORT_EMAIL = 'support@zappipay.com.ng';

// Transactional email via Resend's HTTPS API (https://resend.com).
// HTTPS rather than SMTP because many free hosts block outbound SMTP
// ports. Needs two env vars on Render:
//   RESEND_API_KEY  – from the Resend dashboard
//   EMAIL_FROM      – e.g. "ZappiPay <no-reply@zappipay.com.ng>", on a
//                     domain you've verified in Resend
// Optional: EMAIL_REPLY_TO (defaults to support@zappipay.com.ng) so
// customer replies land in the support inbox.
// Without them, sendEmail() does nothing and reports why, so the rest
// of the app keeps working before email is set up.
async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const replyTo = process.env.EMAIL_REPLY_TO || SUPPORT_EMAIL;
  if (!apiKey || !from) {
    console.warn('sendEmail skipped: RESEND_API_KEY or EMAIL_FROM not set.');
    return { sent: false, reason: 'not_configured' };
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, html, text }),
    });
    if (!response.ok) {
      const body = await response.text();
      console.error('sendEmail failed:', response.status, body);
      return { sent: false, reason: 'provider_error' };
    }
    return { sent: true };
  } catch (error) {
    console.error('sendEmail failed:', error);
    return { sent: false, reason: 'network_error' };
  }
}

function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

module.exports = { sendEmail, isEmailConfigured, SUPPORT_EMAIL };
