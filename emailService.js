const https = require('https');

const SERVICE_LABELS = {
  'small-service': 'Small Service',
  'full-service':  'Full Service',
  'other':         'Service Request'
};

// ── Date formatter ────────────────────────────────────────────────────────────
// Converts "2026-05-20" → "Wednesday, 20 May 2026"
function formatDateHuman(dateStr) {
  if (!dateStr) return dateStr || '';
  try {
    // Parse as local date (avoid timezone shift — dateStr is always YYYY-MM-DD)
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString('en-GB', {
      weekday: 'long',
      day:     'numeric',
      month:   'long',
      year:    'numeric'
    });
  } catch {
    return dateStr;
  }
}

// ── HTML escape for email templates ──────────────────────────────────────────
// Prevents HTML injection in outbound email bodies. Email clients render HTML
// but sandbox scripts; still, unescaped user data can inject spoofed links or
// content into admin/customer notification emails.
function escE(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

const SENDER    = { name: 'Motowarehouse', email: 'support@motowarehouse.com.cy' };
const SITE_URL  = process.env.SITE_URL || '';

// ── Core Brevo API call ───────────────────────────────────────────────────────
function sendBrevoEmail({ to, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error('[Email] BREVO_API_KEY is not set');
    return Promise.reject(new Error('BREVO_API_KEY not set'));
  }

  const recipients = (Array.isArray(to) ? to : [to]).map(e => ({ email: e }));
  const payload = JSON.stringify({
    sender:      SENDER,
    to:          recipients,
    subject,
    htmlContent: html
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path:     '/v3/smtp/email',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'api-key':        apiKey,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`Brevo error ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── OTP code fallback via email ───────────────────────────────────────────────
async function sendOTPCodeEmail(to, code) {
  await sendBrevoEmail({
    to,
    subject: 'Your Motowarehouse Verification Code',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
        <div style="background:#009BB4;padding:24px;text-align:center;">
          <h1 style="color:white;margin:0;font-size:22px;">Verification Code</h1>
        </div>
        <div style="padding:32px;background:#fff;text-align:center;">
          <p style="color:#444;margin-bottom:24px;">We couldn't send an SMS to your number, so we're sending your verification code by email.</p>
          <div style="font-size:42px;font-weight:bold;letter-spacing:12px;color:#009BB4;background:#f0fbfd;padding:20px 32px;border-radius:8px;display:inline-block;">${code}</div>
          <p style="color:#888;font-size:13px;margin-top:20px;">This code is valid for <strong>5 minutes</strong>. Do not share it with anyone.</p>
          <p style="color:#888;font-size:12px;margin-top:8px;">If you did not request this code, please ignore this email.</p>
        </div>
        <div style="background:#1a1a1a;padding:16px;text-align:center;">
          <p style="color:#999;font-size:12px;margin:0;">Motowarehouse Ltd – support@motowarehouse.com.cy</p>
        </div>
      </div>
    `
  });
}

// ── Notify admin of a self-cancellation ──────────────────────────────────────
async function sendSelfCancelAlert(booking) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;

  await sendBrevoEmail({
    to:      adminEmail,
    subject: `[SELF-CANCELLED] ${booking.ref} – ${booking.name} – ${booking.date} ${booking.time}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#7a0028;padding:24px;text-align:center;">
          <h1 style="color:white;margin:0;font-size:22px;">❌ Customer Self-Cancelled</h1>
        </div>
        <div style="padding:32px;background:#fff;">
          <p>The customer cancelled their own booking via the cancellation link.</p>
          <table style="border-collapse:collapse;width:100%;font-size:14px;">
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;width:160px;">Reference</td><td style="padding:10px;">${escE(booking.ref)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Name</td><td style="padding:10px;">${escE(booking.name)}</td></tr>
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Phone</td><td style="padding:10px;">${escE(booking.phone)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Service</td><td style="padding:10px;">${escE(SERVICE_LABELS[booking.serviceType] || booking.serviceType)}</td></tr>
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Date &amp; Time</td><td style="padding:10px;">${escE(booking.date)} at ${escE(booking.time)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Vehicle</td><td style="padding:10px;">${escE(booking.year)} ${escE(booking.model)} – ${escE(booking.plate)}</td></tr>
          </table>
          <p style="margin-top:20px;background:#fff3cd;padding:12px;border-radius:4px;color:#856404;font-size:13px;">
            <strong>Note:</strong> The slot for this booking is now free. No action required unless you want to follow up.
          </p>
          <div style="margin-top:20px;">
            <a href="${SITE_URL}/admin"
               style="background:#009BB4;color:white;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">
              Open Admin Panel
            </a>
          </div>
        </div>
      </div>
    `
  });
}

// ── Notify admin of a new booking ────────────────────────────────────────────
async function sendNewBookingAlert(booking) {
  // Route self-cancel alerts separately
  if (booking._selfCancelAlert) return sendSelfCancelAlert(booking);

  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;

  const isOther = booking.serviceType === 'other';
  const subjectTag = isOther ? '[NEEDS CALL]' : '[NEW BOOKING]';
  const headerColor = isOther ? '#E59000' : '#009BB4';
  const headerText  = isOther ? '📞 New Service Request — Needs Call' : 'New Service Booking';

  await sendBrevoEmail({
    to:      adminEmail,
    subject: `${subjectTag} ${booking.ref} – ${booking.name} – ${SERVICE_LABELS[booking.serviceType] || booking.serviceType}`,
    html: `
      <h2 style="color:${headerColor};">${headerText}</h2>
      <table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;">
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Reference</td><td style="padding:8px;border-bottom:1px solid #eee;">${escE(booking.ref)}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Name</td><td style="padding:8px;border-bottom:1px solid #eee;">${escE(booking.name)}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Phone</td><td style="padding:8px;border-bottom:1px solid #eee;">${escE(booking.phone)}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Email</td><td style="padding:8px;border-bottom:1px solid #eee;">${escE(booking.email || '—')}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Service</td><td style="padding:8px;border-bottom:1px solid #eee;">${escE(SERVICE_LABELS[booking.serviceType] || booking.serviceType)}</td></tr>
        ${isOther
          ? `<tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Description</td><td style="padding:8px;border-bottom:1px solid #eee;">${escE(booking.description || '—')}</td></tr>`
          : `<tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Date &amp; Time</td><td style="padding:8px;border-bottom:1px solid #eee;">${escE(booking.date)} at ${escE(booking.time)}</td></tr>`
        }
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Vehicle</td><td style="padding:8px;border-bottom:1px solid #eee;">${escE(String(booking.year))} ${escE(booking.model)}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Plate</td><td style="padding:8px;border-bottom:1px solid #eee;">${escE(booking.plate)}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Current KM</td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.km ? Number(booking.km).toLocaleString() + ' km' : '—'}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;">Notes</td><td style="padding:8px;">${escE(booking.notes || '—')}</td></tr>
      </table>
      ${isOther ? `<p style="margin-top:16px;background:#fff3cd;padding:12px;border-radius:4px;color:#856404;font-family:Arial;"><strong>⚠️ Action required:</strong> This customer needs to be called to schedule a date and time.</p>` : ''}
      <p style="margin-top:20px;">
        <a href="${SITE_URL}/admin"
           style="background:#009BB4;color:white;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">
          Open Admin Panel
        </a>
      </p>
    `
  });
}

// ── Confirmation to customer ──────────────────────────────────────────────────
async function sendConfirmationToCustomer(booking) {
  // 'other' type: no confirmation email until manually scheduled
  if (booking.serviceType === 'other' || !booking.email) return;

  await sendBrevoEmail({
    to:      booking.email,
    subject: `Your Service Appointment is Confirmed – ${booking.ref}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#009BB4;padding:24px;text-align:center;">
          <h1 style="color:white;margin:0;font-size:24px;">Appointment Confirmed</h1>
        </div>
        <div style="padding:32px;background:#fff;">
          <p>Dear ${escE(booking.name)},</p>
          <p>Your service appointment at <strong>Motowarehouse</strong> has been confirmed. Here are your details:</p>
          <table style="border-collapse:collapse;width:100%;margin:20px 0;">
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Booking Reference</td><td style="padding:10px;">${escE(booking.ref)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Service</td><td style="padding:10px;">${SERVICE_LABELS[booking.serviceType]}</td></tr>
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Date</td><td style="padding:10px;">${formatDateHuman(booking.date)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Time</td><td style="padding:10px;">${escE(booking.time)}</td></tr>
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Vehicle</td><td style="padding:10px;">${escE(String(booking.year))} ${escE(booking.model)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Plate Number</td><td style="padding:10px;">${escE(booking.plate)}</td></tr>
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Current KM</td><td style="padding:10px;">${booking.km ? Number(booking.km).toLocaleString() + ' km' : '—'}</td></tr>
          </table>
          <div style="background:#f0fbfd;border-left:4px solid #009BB4;padding:16px;margin:20px 0;">
            <strong>Location:</strong><br>
            Motowarehouse – 40 Athinon Str., Strovolos, Nicosia, Cyprus<br>
            Tel: 22 328 788
          </div>
          <p>Please arrive a few minutes before your scheduled time. If you need to reschedule, please call us at <strong>22 328 788</strong>.</p>
          <div style="background:#f0fbfd;border:1px solid #cce8ed;border-radius:6px;padding:14px 18px;margin:20px 0;font-size:13px;color:#444;">
            <strong>Manage your booking online:</strong><br>
            <a href="${SITE_URL}/my-booking?ref=${booking.ref}"
               style="color:#009BB4;word-break:break-all;">
              Check your booking status →
            </a>
          </div>
          <div style="background:#fff8f8;border:1px solid #f0d0d0;border-radius:6px;padding:14px 18px;margin:20px 0;font-size:13px;color:#666;">
            Need to cancel? You can cancel your booking online using your reference number:<br>
            <a href="${SITE_URL}/cancel?ref=${booking.ref}"
               style="color:#E50052;word-break:break-all;">
              Cancel booking ${escE(booking.ref)}
            </a>
          </div>
          <p>The Motowarehouse Team</p>
        </div>
        <div style="background:#1a1a1a;padding:16px;text-align:center;">
          <p style="color:#999;font-size:12px;margin:0;">Motowarehouse Ltd – support@motowarehouse.com.cy</p>
        </div>
      </div>
    `
  });
}

// ── Cancellation to customer ──────────────────────────────────────────────────
async function sendCancellationToCustomer(booking) {
  if (!booking.email) return;

  await sendBrevoEmail({
    to:      booking.email,
    subject: `Your Booking ${booking.ref} Has Been Cancelled`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1a1a1a;padding:24px;text-align:center;">
          <h1 style="color:#009BB4;margin:0;font-size:24px;">Booking Cancelled</h1>
        </div>
        <div style="padding:32px;background:#fff;">
          <p>Dear ${escE(booking.name)},</p>
          <p>Unfortunately, we are unable to accommodate your booking <strong>${booking.ref}</strong> on <strong>${formatDateHuman(booking.date)} at ${booking.time}</strong>.</p>
          <p>Please contact us to arrange a more suitable time:</p>
          <div style="background:#f0fbfd;border-left:4px solid #009BB4;padding:16px;margin:20px 0;">
            <strong>📞 22 328 788</strong><br>
            support@motowarehouse.com.cy
          </div>
          <p>We apologise for any inconvenience and look forward to assisting you.</p>
          <p>The Motowarehouse Team</p>
        </div>
      </div>
    `
  });
}

// ── Reminder (2 hours before appointment) ────────────────────────────────────
async function sendReminderToCustomer(booking) {
  if (!booking.email) return;

  await sendBrevoEmail({
    to:      booking.email,
    subject: `Reminder: Your appointment today at ${booking.time} – ${booking.ref}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#009BB4;padding:24px;text-align:center;">
          <h1 style="color:white;margin:0;font-size:24px;">Appointment Reminder</h1>
        </div>
        <div style="padding:32px;background:#fff;">
          <p>Dear ${escE(booking.name)},</p>
          <p>This is a reminder that your <strong>${SERVICE_LABELS[booking.serviceType]}</strong> appointment is in approximately <strong>2 hours</strong>.</p>
          <table style="border-collapse:collapse;width:100%;margin:20px 0;">
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Time</td><td style="padding:10px;">${escE(booking.time)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Vehicle</td><td style="padding:10px;">${escE(String(booking.year))} ${escE(booking.model)}</td></tr>
          </table>
          <div style="background:#f0fbfd;border-left:4px solid #009BB4;padding:16px;">
            <strong>Motowarehouse – 40 Athinon Str., Strovolos, Nicosia</strong><br>
            Tel: 22 328 788
          </div>
          <p style="margin-top:16px;font-size:13px;color:#888;">
            Need to cancel? Please call us directly on <strong>22 328 788</strong> or use your original confirmation email's cancel link.
          </p>
          <p style="margin-top:20px;">The Motowarehouse Team</p>
        </div>
      </div>
    `
  });
}

// ── Reschedule notification to customer ──────────────────────────────────────
async function sendRescheduleToCustomer(booking) {
  if (!booking.email) return;

  await sendBrevoEmail({
    to:      booking.email,
    subject: `Your Appointment Has Been Rescheduled – ${booking.ref}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#009BB4;padding:24px;text-align:center;">
          <h1 style="color:white;margin:0;font-size:24px;">Appointment Rescheduled</h1>
        </div>
        <div style="padding:32px;background:#fff;">
          <p>Dear ${escE(booking.name)},</p>
          <p>Your service appointment at <strong>Motowarehouse</strong> has been rescheduled. Here are your updated details:</p>
          <table style="border-collapse:collapse;width:100%;margin:20px 0;">
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Booking Reference</td><td style="padding:10px;">${escE(booking.ref)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Service</td><td style="padding:10px;">${SERVICE_LABELS[booking.serviceType]}</td></tr>
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">New Date</td><td style="padding:10px;">${formatDateHuman(booking.date)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">New Time</td><td style="padding:10px;">${escE(booking.time)}</td></tr>
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Vehicle</td><td style="padding:10px;">${escE(String(booking.year))} ${escE(booking.model)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Plate Number</td><td style="padding:10px;">${escE(booking.plate)}</td></tr>
          </table>
          <div style="background:#f0fbfd;border-left:4px solid #009BB4;padding:16px;margin:20px 0;">
            <strong>Location:</strong><br>
            Motowarehouse – 40 Athinon Str., Strovolos, Nicosia, Cyprus<br>
            Tel: 22 328 788
          </div>
          <p>Please arrive a few minutes before your scheduled time. If you need to make any changes, please call us at <strong>22 328 788</strong>.</p>
          <p>The Motowarehouse Team</p>
        </div>
        <div style="background:#1a1a1a;padding:16px;text-align:center;">
          <p style="color:#999;font-size:12px;margin:0;">Motowarehouse Ltd – support@motowarehouse.com.cy</p>
        </div>
      </div>
    `
  });
}

// ── Notify admin of a new warranty claim ─────────────────────────────────────
async function sendWarrantyAlert(claim) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;

  const priorityColor = claim.priority === 'urgent' ? '#E50052' : claim.priority === 'high' ? '#E59000' : '#009BB4';
  const priorityLabel = (claim.priority || 'normal').toUpperCase();

  await sendBrevoEmail({
    to:      adminEmail,
    subject: `[WARRANTY] ${claim.regNo} – ${claim.loggedBy || 'Partner'} – ${priorityLabel}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#001A21;padding:24px;text-align:center;">
          <h1 style="color:#E59000;margin:0;font-size:22px;">🛡️ New Warranty Claim</h1>
        </div>
        <div style="padding:32px;background:#fff;">
          <table style="border-collapse:collapse;width:100%;font-size:14px;">
            <tr><td style="padding:8px 0;color:#666;width:140px;">Registration</td><td style="padding:8px 0;font-weight:bold;font-size:18px;">${escE(claim.regNo)}</td></tr>
            <tr><td style="padding:8px 0;color:#666;">Workshop</td><td style="padding:8px 0;">${escE(claim.loggedBy || 'Unknown')}</td></tr>
            <tr><td style="padding:8px 0;color:#666;">Priority</td><td style="padding:8px 0;"><span style="background:${priorityColor};color:#fff;padding:2px 10px;border-radius:4px;font-size:12px;font-weight:bold;">${priorityLabel}</span></td></tr>
            ${claim.frameNo ? `<tr><td style="padding:8px 0;color:#666;">Frame No.</td><td style="padding:8px 0;">${escE(claim.frameNo)}</td></tr>` : ''}
            ${claim.km     ? `<tr><td style="padding:8px 0;color:#666;">KM</td><td style="padding:8px 0;">${Number(claim.km).toLocaleString()} km</td></tr>` : ''}
            <tr><td style="padding:8px 0;color:#666;vertical-align:top;">Fault</td><td style="padding:8px 0;">${escE(claim.symptom)}</td></tr>
            ${claim.notes  ? `<tr><td style="padding:8px 0;color:#666;vertical-align:top;">Notes</td><td style="padding:8px 0;">${escE(claim.notes)}</td></tr>` : ''}
          </table>
          ${claim.photos && claim.photos.length ? `<p style="margin-top:16px;color:#666;font-size:13px;">${claim.photos.length} photo(s) attached — view in the admin panel.</p>` : ''}
          <div style="margin-top:24px;">
            <a href="${SITE_URL}/admin" style="background:#E59000;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;">View in Admin Panel →</a>
          </div>
        </div>
        <div style="padding:16px 32px;background:#f5f5f5;font-size:12px;color:#999;">Motowarehouse Ltd · Warranty Management Portal</div>
      </div>
    `
  });
}

// ── Notify partner of warranty claim status change ────────────────────────────
async function sendWarrantyStatusToPartner(claim, partnerEmail, workshopName) {
  if (!partnerEmail) return;

  const statusLabels = {
    open:     { label: 'Open',     color: '#009BB4', icon: '🔵' },
    approved: { label: 'Approved', color: '#28a745', icon: '✅' },
    rejected: { label: 'Rejected', color: '#E50052', icon: '❌' },
    closed:   { label: 'Closed',   color: '#6c757d', icon: '🔒' }
  };
  const s = statusLabels[claim.status] || { label: claim.status, color: '#009BB4', icon: '📋' };

  await sendBrevoEmail({
    to:      partnerEmail,
    subject: `Warranty Claim Update – ${claim.regNo} – ${s.label}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#001A21;padding:24px;text-align:center;">
          <h1 style="color:#E59000;margin:0;font-size:22px;">🛡️ Warranty Claim Update</h1>
        </div>
        <div style="padding:32px;background:#fff;">
          <p>Dear ${escE(workshopName || 'Partner')},</p>
          <p>Your warranty claim for <strong>${escE(claim.regNo)}</strong> has been updated.</p>
          <div style="text-align:center;margin:24px 0;padding:20px;background:#f5f5f5;border-radius:8px;">
            <div style="font-size:48px;">${s.icon}</div>
            <div style="font-size:24px;font-weight:bold;color:${s.color};margin-top:8px;">${s.label}</div>
          </div>
          <table style="border-collapse:collapse;width:100%;font-size:14px;">
            <tr><td style="padding:8px 0;color:#666;width:140px;">Registration</td><td style="padding:8px 0;font-weight:bold;">${escE(claim.regNo)}</td></tr>
            <tr><td style="padding:8px 0;color:#666;">Fault Reported</td><td style="padding:8px 0;">${escE(claim.symptom)}</td></tr>
            ${claim.adminNotes ? `<tr><td style="padding:8px 0;color:#666;vertical-align:top;">Admin Notes</td><td style="padding:8px 0;">${escE(claim.adminNotes)}</td></tr>` : ''}
          </table>
          <p style="margin-top:24px;font-size:13px;color:#666;">
            If you have any questions, please contact Motowarehouse on <strong>22 328 788</strong>
            or reply to this email at <strong>support@motowarehouse.com.cy</strong>.
          </p>
          <p>The Motowarehouse Team</p>
        </div>
        <div style="padding:16px 32px;background:#f5f5f5;font-size:12px;color:#999;">Motowarehouse Ltd · Warranty Management Portal</div>
      </div>
    `
  });
}

// ── Acknowledgement for "other" service requests ──────────────────────────────
async function sendOtherRequestAcknowledgement(booking) {
  if (!booking.email) return;

  await sendBrevoEmail({
    to:      booking.email,
    subject: `We received your service request – ${booking.ref}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#E59000;padding:24px;text-align:center;">
          <h1 style="color:white;margin:0;font-size:22px;">Service Request Received</h1>
        </div>
        <div style="padding:32px;background:#fff;">
          <p>Dear ${escE(booking.name)},</p>
          <p>We have received your service request and a member of our team will call you shortly to arrange a suitable date and time.</p>
          <table style="border-collapse:collapse;width:100%;margin:20px 0;font-size:14px;">
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Reference</td><td style="padding:10px;">${escE(booking.ref)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Vehicle</td><td style="padding:10px;">${escE(String(booking.year))} ${escE(booking.model)} – ${escE(booking.plate)}</td></tr>
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Your Request</td><td style="padding:10px;">${escE(booking.description || '—')}</td></tr>
          </table>
          <div style="background:#f0fbfd;border-left:4px solid #009BB4;padding:16px;margin:20px 0;">
            <strong>📞 22 328 788</strong> &nbsp;|&nbsp; support@motowarehouse.com.cy<br>
            40 Athinon Str., Strovolos, Nicosia
          </div>
          <p style="font-size:13px;color:#666;">Please keep your reference number <strong>${escE(booking.ref)}</strong> handy when we call.</p>
          <p>The Motowarehouse Team</p>
        </div>
        <div style="background:#1a1a1a;padding:16px;text-align:center;">
          <p style="color:#999;font-size:12px;margin:0;">Motowarehouse Ltd – support@motowarehouse.com.cy</p>
        </div>
      </div>
    `
  });
}

// ── Vehicle ready for collection ──────────────────────────────────────────────
async function sendVehicleReadyToCustomer(booking) {
  if (!booking.email) return;

  await sendBrevoEmail({
    to:      booking.email,
    subject: `Your vehicle is ready for collection – ${booking.ref}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#00c896;padding:24px;text-align:center;">
          <h1 style="color:white;margin:0;font-size:24px;">✅ Your Vehicle is Ready</h1>
        </div>
        <div style="padding:32px;background:#fff;">
          <p>Dear ${escE(booking.name)},</p>
          <p>Your <strong>${SERVICE_LABELS[booking.serviceType] || 'service'}</strong> has been completed and your vehicle is ready for collection.</p>
          <table style="border-collapse:collapse;width:100%;margin:20px 0;font-size:14px;">
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Booking Reference</td><td style="padding:10px;">${escE(booking.ref)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Vehicle</td><td style="padding:10px;">${escE(String(booking.year))} ${escE(booking.model)}</td></tr>
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Plate Number</td><td style="padding:10px;">${escE(booking.plate)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Service</td><td style="padding:10px;">${escE(SERVICE_LABELS[booking.serviceType] || booking.serviceType)}</td></tr>
          </table>
          <div style="background:#f0fbfd;border-left:4px solid #00c896;padding:16px;margin:20px 0;">
            <strong>📍 Motowarehouse</strong><br>
            40 Athinon Str., Strovolos, Nicosia, Cyprus<br>
            <strong>📞 22 328 788</strong>
          </div>
          <p style="font-size:13px;color:#666;">Opening hours: Mon–Tue–Thu–Fri 8:30–13:00 / 14:00–17:30 &nbsp;|&nbsp; Wed & Sat 8:30–13:00</p>
          <p>Thank you for choosing Motowarehouse.</p>
          <p>The Motowarehouse Team</p>
        </div>
        <div style="background:#1a1a1a;padding:16px;text-align:center;">
          <p style="color:#999;font-size:12px;margin:0;">Motowarehouse Ltd – support@motowarehouse.com.cy</p>
        </div>
      </div>
    `
  });
}

// ── Previous-day reminder (sent evening before, for early appointments) ────────
async function sendPreviousDayReminderToCustomer(booking) {
  if (!booking.email) return;

  await sendBrevoEmail({
    to:      booking.email,
    subject: `Reminder: Your appointment tomorrow at ${booking.time} – ${booking.ref}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#009BB4;padding:24px;text-align:center;">
          <h1 style="color:white;margin:0;font-size:24px;">Appointment Reminder</h1>
        </div>
        <div style="padding:32px;background:#fff;">
          <p>Dear ${escE(booking.name)},</p>
          <p>This is a friendly reminder that you have a service appointment <strong>tomorrow morning</strong> at <strong>Motowarehouse</strong>.</p>
          <table style="border-collapse:collapse;width:100%;margin:20px 0;">
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Date</td><td style="padding:10px;">${formatDateHuman(booking.date)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Time</td><td style="padding:10px;">${escE(booking.time)}</td></tr>
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Service</td><td style="padding:10px;">${escE(SERVICE_LABELS[booking.serviceType] || booking.serviceType)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Vehicle</td><td style="padding:10px;">${escE(String(booking.year))} ${escE(booking.model)}</td></tr>
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Plate</td><td style="padding:10px;">${escE(booking.plate)}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Reference</td><td style="padding:10px;">${escE(booking.ref)}</td></tr>
          </table>
          <div style="background:#f0fbfd;border-left:4px solid #009BB4;padding:16px;margin:20px 0;">
            <strong>📍 Motowarehouse – 40 Athinon Str., Strovolos, Nicosia</strong><br>
            <strong>📞 22 328 788</strong>
          </div>
          <p>Please arrive a few minutes before your scheduled time. If you need to reschedule or cancel, please call us on <strong>22 328 788</strong> as soon as possible.</p>
          <p>The Motowarehouse Team</p>
        </div>
        <div style="background:#1a1a1a;padding:16px;text-align:center;">
          <p style="color:#999;font-size:12px;margin:0;">Motowarehouse Ltd – support@motowarehouse.com.cy</p>
        </div>
      </div>
    `
  });
}

module.exports = {
  sendOTPCodeEmail,
  sendNewBookingAlert,
  sendConfirmationToCustomer,
  sendCancellationToCustomer,
  sendReminderToCustomer,
  sendRescheduleToCustomer,
  sendWarrantyAlert,
  sendWarrantyStatusToPartner,
  sendOtherRequestAcknowledgement,
  sendVehicleReadyToCustomer,
  sendPreviousDayReminderToCustomer
};
