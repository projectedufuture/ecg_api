const config = require('../config/env');

async function sendPasswordResetEmail({ toEmail, toName, resetUrl }) {
  const payload = {
    sender: {
      name: config.email.senderName,
      email: config.email.senderEmail,
    },
    to: [{ email: toEmail, name: toName }],
    subject: 'Password Reset Request – ECG Admin Panel',
    htmlContent: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Password Reset</title>
</head>
<body style="margin:0;padding:0;background:#0B0F19;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background:#151d2e;border-radius:20px;border:1px solid #1e293b;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td align="center" style="padding:36px 40px 24px;">
              <div style="width:52px;height:52px;border-radius:14px;background:linear-gradient(135deg,#06B6D4,#8B5CF6);display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
                <span style="font-size:24px;">🔒</span>
              </div>
              <h1 style="color:#F1F5F9;font-size:22px;font-weight:700;margin:0 0 6px;">Reset Your Password</h1>
              <p style="color:#64748B;font-size:14px;margin:0;">ECG Admin Panel – Wearable Wellness Platform</p>
            </td>
          </tr>

          <!-- Divider -->
          <tr><td style="height:1px;background:#1e293b;"></td></tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 40px;">
              <p style="color:#94A3B8;font-size:15px;margin:0 0 16px;">Hi <strong style="color:#F1F5F9;">${toName}</strong>,</p>
              <p style="color:#94A3B8;font-size:15px;margin:0 0 24px;line-height:1.6;">
                We received a request to reset the password for your admin account. Click the button below to set a new password.
              </p>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
                <tr>
                  <td align="center" style="border-radius:12px;background:linear-gradient(135deg,#06B6D4,#8B5CF6);">
                    <a href="${resetUrl}" target="_blank"
                       style="display:inline-block;padding:14px 36px;color:#fff;font-size:15px;font-weight:600;text-decoration:none;border-radius:12px;">
                      Reset Password
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Expiry notice -->
              <div style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);border-radius:10px;padding:12px 16px;margin-bottom:24px;">
                <p style="color:#F59E0B;font-size:13px;margin:0;">
                  ⏱ This link expires in <strong>15 minutes</strong>. If it has expired, please request a new reset link.
                </p>
              </div>

              <!-- Fallback link -->
              <p style="color:#64748B;font-size:13px;margin:0 0 8px;">If the button doesn't work, copy and paste this URL into your browser:</p>
              <p style="word-break:break-all;font-size:12px;color:#06B6D4;margin:0 0 24px;">
                <a href="${resetUrl}" style="color:#06B6D4;">${resetUrl}</a>
              </p>

              <p style="color:#64748B;font-size:13px;margin:0;line-height:1.6;">
                If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr><td style="height:1px;background:#1e293b;"></td></tr>
          <tr>
            <td style="padding:20px 40px;text-align:center;">
              <p style="color:#334155;font-size:12px;margin:0;">
                © ${new Date().getFullYear()} ECG Admin Panel · Wellness-grade platform — Not for medical diagnosis
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim(),
  };

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': config.email.apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Brevo API error ${response.status}: ${errBody}`);
  }
}

module.exports = { sendPasswordResetEmail };
