const config = require('../config/env');

// Shared light/white theme palette so all templates stay consistent.
const T = {
  pageBg: '#F4F5F7',
  cardBg: '#FFFFFF',
  cardBorder: '#E5E7EB',
  divider: '#E5E7EB',
  innerBg: '#F9FAFB',
  innerBorder: '#E5E7EB',
  heading: '#111827',
  subheading: '#6B7280',
  body: '#374151',
  strong: '#111827',
  muted: '#6B7280',
  footer: '#9CA3AF',
  accent: '#06B6D4',
  accentGradient: 'linear-gradient(135deg,#06B6D4,#8B5CF6)',
};

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
<body style="margin:0;padding:0;background:${T.pageBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;background:${T.pageBg};">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background:${T.cardBg};border-radius:20px;border:1px solid ${T.cardBorder};overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04);">

          <!-- Header -->
          <tr>
            <td align="center" style="padding:36px 40px 24px;">
              <div style="width:52px;height:52px;border-radius:14px;background:${T.accentGradient};display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
                <span style="font-size:24px;">🔒</span>
              </div>
              <h1 style="color:${T.heading};font-size:22px;font-weight:700;margin:0 0 6px;">Reset Your Password</h1>
              <p style="color:${T.subheading};font-size:14px;margin:0;">ECG Admin Panel – Wearable Wellness Platform</p>
            </td>
          </tr>

          <tr><td style="height:1px;background:${T.divider};"></td></tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 40px;">
              <p style="color:${T.body};font-size:15px;margin:0 0 16px;">Hi <strong style="color:${T.strong};">${toName}</strong>,</p>
              <p style="color:${T.body};font-size:15px;margin:0 0 24px;line-height:1.6;">
                We received a request to reset the password for your admin account. Click the button below to set a new password.
              </p>

              <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
                <tr>
                  <td align="center" style="border-radius:12px;background:${T.accentGradient};">
                    <a href="${resetUrl}" target="_blank"
                       style="display:inline-block;padding:14px 36px;color:#fff;font-size:15px;font-weight:600;text-decoration:none;border-radius:12px;">
                      Reset Password
                    </a>
                  </td>
                </tr>
              </table>

              <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;padding:12px 16px;margin-bottom:24px;">
                <p style="color:#92400E;font-size:13px;margin:0;">
                  ⏱ This link expires in <strong>15 minutes</strong>. If it has expired, please request a new reset link.
                </p>
              </div>

              <p style="color:${T.muted};font-size:13px;margin:0 0 8px;">If the button doesn't work, copy and paste this URL into your browser:</p>
              <p style="word-break:break-all;font-size:12px;color:${T.accent};margin:0 0 24px;">
                <a href="${resetUrl}" style="color:${T.accent};">${resetUrl}</a>
              </p>

              <p style="color:${T.muted};font-size:13px;margin:0;line-height:1.6;">
                If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.
              </p>
            </td>
          </tr>

          <tr><td style="height:1px;background:${T.divider};"></td></tr>
          <tr>
            <td style="padding:20px 40px;text-align:center;">
              <p style="color:${T.footer};font-size:12px;margin:0;">
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

async function sendAppPasswordResetEmail({ toEmail, toName, resetUrl }) {
  const payload = {
    sender: {
      name: config.email.senderName,
      email: config.email.senderEmail,
    },
    to: [{ email: toEmail, name: toName }],
    subject: 'Reset your ECG Wellness password',
    htmlContent: `
<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:${T.pageBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;background:${T.pageBg};">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:${T.cardBg};border-radius:20px;border:1px solid ${T.cardBorder};overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
        <tr><td align="center" style="padding:36px 40px 24px;">
          <h1 style="color:${T.heading};font-size:22px;font-weight:700;margin:0 0 6px;">Reset Your Password</h1>
          <p style="color:${T.subheading};font-size:14px;margin:0;">ECG Wearable Wellness – Mobile App</p>
        </td></tr>
        <tr><td style="height:1px;background:${T.divider};"></td></tr>
        <tr><td style="padding:32px 40px;">
          <p style="color:${T.body};font-size:15px;margin:0 0 16px;">Hi <strong style="color:${T.strong};">${toName}</strong>,</p>
          <p style="color:${T.body};font-size:15px;margin:0 0 24px;line-height:1.6;">
            We received a request to reset the password for your ECG Wellness account. Tap the button below to set a new password.
          </p>
          <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;"><tr>
            <td align="center" style="border-radius:12px;background:${T.accentGradient};">
              <a href="${resetUrl}" target="_blank" style="display:inline-block;padding:14px 36px;color:#fff;font-size:15px;font-weight:600;text-decoration:none;border-radius:12px;">Reset Password</a>
            </td>
          </tr></table>
          <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;padding:12px 16px;margin-bottom:24px;">
            <p style="color:#92400E;font-size:13px;margin:0;">This link expires in <strong>15 minutes</strong>.</p>
          </div>
          <p style="color:${T.muted};font-size:13px;margin:0 0 8px;">If the button doesn't work, copy and paste this URL:</p>
          <p style="word-break:break-all;font-size:12px;color:${T.accent};margin:0 0 24px;">
            <a href="${resetUrl}" style="color:${T.accent};">${resetUrl}</a>
          </p>
          <p style="color:${T.muted};font-size:13px;margin:0;line-height:1.6;">
            If you did not request a password reset, you can safely ignore this email.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim(),
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

async function sendUserOnboardingEmail({ toEmail, toName, password, deviceId, licenseKey, loginUrl }) {
  const deviceLine = deviceId
    ? `<tr><td style="padding:6px 0;color:${T.muted};font-size:13px;">Device:</td><td style="padding:6px 0;color:${T.strong};font-size:13px;font-family:monospace;">${deviceId}</td></tr>`
    : '';
  const licenseLine = licenseKey
    ? `<tr><td style="padding:6px 0;color:${T.muted};font-size:13px;">License Key:</td><td style="padding:6px 0;color:${T.strong};font-size:13px;font-family:monospace;">${licenseKey}</td></tr>`
    : '';

  const payload = {
    sender: { name: config.email.senderName, email: config.email.senderEmail },
    to: [{ email: toEmail, name: toName }],
    subject: 'Welcome to ECG Wellness – Your Login Credentials',
    htmlContent: `
<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:${T.pageBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;background:${T.pageBg};">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:${T.cardBg};border-radius:20px;border:1px solid ${T.cardBorder};overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
        <tr><td align="center" style="padding:36px 40px 24px;">
          <h1 style="color:${T.heading};font-size:22px;font-weight:700;margin:0 0 6px;">Welcome to ECG Wellness</h1>
          <p style="color:${T.subheading};font-size:14px;margin:0;">Your account has been created.</p>
        </td></tr>
        <tr><td style="height:1px;background:${T.divider};"></td></tr>
        <tr><td style="padding:32px 40px;">
          <p style="color:${T.body};font-size:15px;margin:0 0 16px;">Hi <strong style="color:${T.strong};">${toName}</strong>,</p>
          <p style="color:${T.body};font-size:15px;margin:0 0 24px;line-height:1.6;">
            Your ECG Wellness account is ready. Use the credentials below to sign in to the mobile app.
          </p>

          <table width="100%" cellpadding="0" cellspacing="0" style="background:${T.innerBg};border:1px solid ${T.innerBorder};border-radius:10px;padding:16px 18px;margin-bottom:20px;">
            <tr><td style="padding:6px 0;color:${T.muted};font-size:13px;width:110px;">Email:</td><td style="padding:6px 0;color:${T.strong};font-size:13px;font-family:monospace;">${toEmail}</td></tr>
            <tr><td style="padding:6px 0;color:${T.muted};font-size:13px;">Password:</td><td style="padding:6px 0;color:${T.strong};font-size:13px;font-family:monospace;letter-spacing:0.5px;">${password}</td></tr>
            ${deviceLine}
            ${licenseLine}
          </table>

          <div style="background:#ECFEFF;border:1px solid #A5F3FC;border-radius:10px;padding:12px 16px;margin-bottom:20px;">
            <p style="color:#0E7490;font-size:13px;margin:0;line-height:1.5;">
              🔒 For your security you will be asked to change this temporary password on your first login.
            </p>
          </div>

          ${loginUrl ? `<table cellpadding="0" cellspacing="0" style="margin:0 auto 8px;"><tr>
            <td align="center" style="border-radius:12px;background:${T.accentGradient};">
              <a href="${loginUrl}" target="_blank" style="display:inline-block;padding:12px 32px;color:#fff;font-size:14px;font-weight:600;text-decoration:none;border-radius:12px;">Open App</a>
            </td></tr></table>` : ''}

          <p style="color:${T.muted};font-size:12px;margin:16px 0 0;line-height:1.6;">
            If you did not expect this email, please ignore it or contact support.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim(),
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

async function sendDeviceAssignmentEmail({ toEmail, toName, deviceId, licenseKey }) {
  const payload = {
    sender: { name: config.email.senderName, email: config.email.senderEmail },
    to: [{ email: toEmail, name: toName }],
    subject: 'A new device has been assigned to you',
    htmlContent: `
<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:${T.pageBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;background:${T.pageBg};">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:${T.cardBg};border-radius:20px;border:1px solid ${T.cardBorder};overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
        <tr><td align="center" style="padding:36px 40px 24px;">
          <h1 style="color:${T.heading};font-size:22px;font-weight:700;margin:0 0 6px;">Your Device Is Ready</h1>
          <p style="color:${T.subheading};font-size:14px;margin:0;">ECG Wearable Wellness</p>
        </td></tr>
        <tr><td style="height:1px;background:${T.divider};"></td></tr>
        <tr><td style="padding:32px 40px;">
          <p style="color:${T.body};font-size:15px;margin:0 0 16px;">Hi <strong style="color:${T.strong};">${toName}</strong>,</p>
          <p style="color:${T.body};font-size:15px;margin:0 0 24px;line-height:1.6;">
            An ECG Wellness device has been assigned to your account. Use the details below to pair it in the mobile app.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:${T.innerBg};border:1px solid ${T.innerBorder};border-radius:10px;padding:16px 18px;margin-bottom:20px;">
            <tr><td style="padding:6px 0;color:${T.muted};font-size:13px;width:110px;">Device:</td><td style="padding:6px 0;color:${T.strong};font-size:13px;font-family:monospace;">${deviceId}</td></tr>
            <tr><td style="padding:6px 0;color:${T.muted};font-size:13px;">License Key:</td><td style="padding:6px 0;color:${T.strong};font-size:13px;font-family:monospace;letter-spacing:0.5px;">${licenseKey}</td></tr>
          </table>
          <div style="background:#ECFEFF;border:1px solid #A5F3FC;border-radius:10px;padding:12px 16px;">
            <p style="color:#0E7490;font-size:13px;margin:0;line-height:1.5;">
              📱 Open the app &rarr; Pair Device &rarr; enter the Device ID and License Key above.
            </p>
          </div>
          <p style="color:${T.muted};font-size:12px;margin:16px 0 0;line-height:1.6;">
            If you did not expect this email, please ignore it or contact support.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim(),
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

module.exports = {
  sendPasswordResetEmail,
  sendAppPasswordResetEmail,
  sendUserOnboardingEmail,
  sendDeviceAssignmentEmail,
};
