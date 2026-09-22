const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// attachments: [{ filename, content: Buffer, contentType }]
async function sendEmail({ to, subject, html, attachments = [] }) {
  if (!resend) {
    console.warn(`[email] RESEND_API_KEY not set — would have emailed "${subject}" to ${to}`);
    return { skipped: true };
  }
  return resend.emails.send({
    from: process.env.FROM_EMAIL || 'onboarding@resend.dev',
    to,
    subject,
    html,
    attachments: attachments.map((a) => ({
      filename: a.filename,
      content: a.content.toString('base64')
    }))
  });
}

module.exports = { sendEmail };
