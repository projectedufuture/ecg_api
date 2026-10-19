const nodemailer = require('nodemailer');
const config = require('../config/env');

// ── Mail transport (Brevo SMTP relay) ───────────────────────────────────────
// All templates below build the same Brevo-style `payload`
// ({ sender, to, subject, htmlContent }); `dispatch` translates that into a
// nodemailer send over Brevo's SMTP relay. Using SMTP (not the REST API) lets
// us authenticate with the SMTP key (xsmtpsib-…) the project already has.
let _transporter = null;
function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465, // 465 = implicit TLS; 587 = STARTTLS
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }
  return _transporter;
}

async function dispatch(payload) {
  const to = (payload.to || [])
    .map((r) => (r.name ? `"${r.name}" <${r.email}>` : r.email))
    .join(', ');

  await getTransporter().sendMail({
    from: { name: payload.sender.name, address: payload.sender.email },
    to,
    subject: payload.subject,
    html: payload.htmlContent,
  });
}

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
    subject: 'Password Reset Request – Biotex Admin Panel',
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
              <p style="color:${T.subheading};font-size:14px;margin:0;">Biotex Admin Panel – Wearable Wellness Platform</p>
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
                © ${new Date().getFullYear()} Biotex Admin Panel · Wellness-grade platform — Not for medical diagnosis
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

  await dispatch(payload);
}

async function sendAppPasswordResetEmail({ toEmail, toName, resetUrl }) {
  const payload = {
    sender: {
      name: config.email.senderName,
      email: config.email.senderEmail,
    },
    to: [{ email: toEmail, name: toName }],
    subject: 'Reset your Biotex Wellness password',
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

  await dispatch(payload);
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

  await dispatch(payload);
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

  await dispatch(payload);
}

// Format an ISO timestamp for display inside a given IANA timezone.
function fmtInTz(iso, timezone) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

function fmtDuration(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/**
 * Scheduled session-activity summary.
 * `digest` is the object produced by utils/summaryDigest.buildSummaryDigest.
 */
async function sendSummaryEmail({ toEmail, periodLabel, rangeLabel, timezone, digest, scopeLabel }) {
  const stat = (label, value) => `
    <td align="center" style="padding:12px 8px;">
      <div style="color:${T.heading};font-size:24px;font-weight:700;line-height:1;">${value}</div>
      <div style="color:${T.muted};font-size:12px;margin-top:4px;">${label}</div>
    </td>`;

  const sessionRows = digest.sessions.length
    ? digest.sessions
        .map(
          (s) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid ${T.innerBorder};color:${T.strong};font-size:13px;">${s.userName || '—'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${T.innerBorder};color:${T.body};font-size:13px;">${fmtInTz(s.startTime, timezone)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${T.innerBorder};color:${T.body};font-size:13px;text-transform:capitalize;">${s.activityType}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${T.innerBorder};color:${T.strong};font-size:13px;text-align:right;">${fmtDuration(s.durationMin)}</td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="4" style="padding:16px 10px;color:${T.muted};font-size:13px;text-align:center;">No sessions were recorded in this period.</td></tr>`;

  const loginRows = digest.logins.length
    ? digest.logins
        .slice(0, 50)
        .map(
          (u) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid ${T.innerBorder};color:${T.strong};font-size:13px;">${u.name || '—'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${T.innerBorder};color:${T.body};font-size:13px;">${u.email || '—'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${T.innerBorder};color:${T.body};font-size:13px;text-align:right;">${fmtInTz(u.lastActive, timezone)}</td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="3" style="padding:16px 10px;color:${T.muted};font-size:13px;text-align:center;">No user activity in this period.</td></tr>`;

  const payload = {
    sender: { name: config.email.senderName, email: config.email.senderEmail },
    to: [{ email: toEmail }],
    subject: `${periodLabel} Activity Summary – Biotex`,
    htmlContent: `
<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:${T.pageBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;background:${T.pageBg};">
    <tr><td align="center">
      <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:${T.cardBg};border-radius:20px;border:1px solid ${T.cardBorder};overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
        <tr><td align="center" style="padding:32px 40px 20px;">
          <div style="width:52px;height:52px;border-radius:14px;background:${T.accentGradient};display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
            <span style="font-size:24px;">📊</span>
          </div>
          <h1 style="color:${T.heading};font-size:22px;font-weight:700;margin:0 0 6px;">${periodLabel} Activity Summary</h1>
          <p style="color:${T.subheading};font-size:14px;margin:0;">${rangeLabel}</p>
          ${scopeLabel ? `<p style="color:${T.muted};font-size:12px;margin:6px 0 0;">${scopeLabel}</p>` : ''}
        </td></tr>
        <tr><td style="height:1px;background:${T.divider};"></td></tr>

        <!-- Stat row -->
        <tr><td style="padding:12px 24px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:${T.innerBg};border:1px solid ${T.innerBorder};border-radius:12px;">
            <tr>
              ${stat('Sessions', digest.sessionCount)}
              ${stat('Total Time', fmtDuration(digest.totalDurationMin))}
              ${stat('Session Users', digest.uniqueSessionUsers)}
              ${stat('Active Users', digest.activeUserCount)}
            </tr>
          </table>
        </td></tr>

        <!-- Sessions table -->
        <tr><td style="padding:12px 24px 4px;">
          <p style="color:${T.heading};font-size:15px;font-weight:600;margin:0 0 10px;">Sessions Recorded</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${T.innerBorder};border-radius:10px;overflow:hidden;">
            <tr style="background:${T.innerBg};">
              <th align="left" style="padding:8px 10px;color:${T.muted};font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">User</th>
              <th align="left" style="padding:8px 10px;color:${T.muted};font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Started</th>
              <th align="left" style="padding:8px 10px;color:${T.muted};font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Type</th>
              <th align="right" style="padding:8px 10px;color:${T.muted};font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Duration</th>
            </tr>
            ${sessionRows}
          </table>
        </td></tr>

        <!-- Logins table -->
        <tr><td style="padding:16px 24px 8px;">
          <p style="color:${T.heading};font-size:15px;font-weight:600;margin:0 0 10px;">User Activity / Logins</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${T.innerBorder};border-radius:10px;overflow:hidden;">
            <tr style="background:${T.innerBg};">
              <th align="left" style="padding:8px 10px;color:${T.muted};font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">User</th>
              <th align="left" style="padding:8px 10px;color:${T.muted};font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Email</th>
              <th align="right" style="padding:8px 10px;color:${T.muted};font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Last Active</th>
            </tr>
            ${loginRows}
          </table>
        </td></tr>

        <tr><td style="height:1px;background:${T.divider};margin-top:8px;"></td></tr>
        <tr><td style="padding:20px 40px;text-align:center;">
          <p style="color:${T.footer};font-size:12px;margin:0;">
            © ${new Date().getFullYear()} Biotex Admin Panel · Automated summary — times shown in ${timezone || 'UTC'}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim(),
  };

  await dispatch(payload);
}

module.exports = {
  sendPasswordResetEmail,
  sendAppPasswordResetEmail,
  sendUserOnboardingEmail,
  sendDeviceAssignmentEmail,
  sendSummaryEmail,
};
