const { Resend } = require('resend');

const SERVICE_LABELS = {
  'oil-change':    'Oil Change',
  'small-service': 'Small Service',
  'big-service':   'Big Service'
};

function getResend() {
  if (!process.env.RESEND_API_KEY) {
    console.error('[Email] RESEND_API_KEY is not set in environment variables');
  }
  return new Resend(process.env.RESEND_API_KEY);
}

// The "from" address — once you verify motowarehouse.com.cy in Resend dashboard
// you can change this to: 'Motowarehouse <bookings@motowarehouse.com.cy>'
const FROM = 'Motowarehouse <onboarding@resend.dev>';
const REPLY_TO = 'Motowarehouse <support@motowarehouse.com.cy>';

// ── Notify Nikolas of a new booking ─────────────────────────────────────────
async function sendNewBookingAlert(booking) {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
  if (!adminEmail) return;

  const resend = getResend();
  const { error } = await resend.emails.send({
    from:     FROM,
    reply_to: REPLY_TO,
    to:       [adminEmail],
    subject: `[NEW BOOKING] ${booking.ref} – ${booking.name} – ${SERVICE_LABELS[booking.serviceType]}`,
    html: `
      <h2 style="color:#009BB4;">New Service Booking</h2>
      <table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;">
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Reference</td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.ref}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Name</td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.name}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Phone</td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.phone}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Email</td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.email || '—'}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Service</td><td style="padding:8px;border-bottom:1px solid #eee;">${SERVICE_LABELS[booking.serviceType]}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Date &amp; Time</td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.date} at ${booking.time}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Vehicle</td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.year} ${booking.model}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Plate</td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.plate}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Current KM</td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.km ? Number(booking.km).toLocaleString() + ' km' : '—'}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;">Notes</td><td style="padding:8px;">${booking.notes || '—'}</td></tr>
      </table>
      <p style="margin-top:20px;">
        <a href="${process.env.SITE_URL || 'https://web-production-ad678.up.railway.app'}/admin"
           style="background:#009BB4;color:white;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">
          Open Admin Panel
        </a>
      </p>
    `
  });

  if (error) throw new Error(error.message || JSON.stringify(error));
}

// ── Confirmation to customer ─────────────────────────────────────────────────
async function sendConfirmationToCustomer(booking) {
  if (!booking.email) return;

  const resend = getResend();
  const { error } = await resend.emails.send({
    from:     FROM,
    reply_to: REPLY_TO,
    to:       [booking.email],
    subject: `Your Service Appointment is Confirmed – ${booking.ref}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#009BB4;padding:24px;text-align:center;">
          <h1 style="color:white;margin:0;font-size:24px;">Appointment Confirmed</h1>
        </div>
        <div style="padding:32px;background:#fff;">
          <p>Dear ${booking.name},</p>
          <p>Your service appointment at <strong>Motowarehouse</strong> has been confirmed. Here are your details:</p>
          <table style="border-collapse:collapse;width:100%;margin:20px 0;">
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Booking Reference</td><td style="padding:10px;">${booking.ref}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Service</td><td style="padding:10px;">${SERVICE_LABELS[booking.serviceType]}</td></tr>
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Date</td><td style="padding:10px;">${booking.date}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Time</td><td style="padding:10px;">${booking.time}</td></tr>
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Vehicle</td><td style="padding:10px;">${booking.year} ${booking.model}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Plate Number</td><td style="padding:10px;">${booking.plate}</td></tr>
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Current KM</td><td style="padding:10px;">${booking.km ? Number(booking.km).toLocaleString() + ' km' : '—'}</td></tr>
          </table>
          <div style="background:#f0fbfd;border-left:4px solid #009BB4;padding:16px;margin:20px 0;">
            <strong>Location:</strong><br>
            Motowarehouse – 40 Athinon Str., Strovolos, Nicosia, Cyprus<br>
            Tel: 22 328 788
          </div>
          <p>Please arrive a few minutes before your scheduled time. If you need to reschedule, please call us at <strong>22 328 788</strong>.</p>
          <p>The Motowarehouse Team</p>
        </div>
        <div style="background:#1a1a1a;padding:16px;text-align:center;">
          <p style="color:#999;font-size:12px;margin:0;">Motowarehouse Ltd – info@motowarehouse.com.cy</p>
        </div>
      </div>
    `
  });

  if (error) throw new Error(error.message || JSON.stringify(error));
}

// ── Cancellation to customer ─────────────────────────────────────────────────
async function sendCancellationToCustomer(booking) {
  if (!booking.email) return;

  const resend = getResend();
  const { error } = await resend.emails.send({
    from:     FROM,
    reply_to: REPLY_TO,
    to:       [booking.email],
    subject: `Your Booking ${booking.ref} – Update Required`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1a1a1a;padding:24px;text-align:center;">
          <h1 style="color:#009BB4;margin:0;font-size:24px;">Booking Update</h1>
        </div>
        <div style="padding:32px;background:#fff;">
          <p>Dear ${booking.name},</p>
          <p>Unfortunately, we are unable to accommodate your booking <strong>${booking.ref}</strong> on <strong>${booking.date} at ${booking.time}</strong>.</p>
          <p>Please contact us to arrange a more suitable time:</p>
          <div style="background:#f0fbfd;border-left:4px solid #009BB4;padding:16px;margin:20px 0;">
            <strong>📞 22 328 788</strong><br>
            info@motowarehouse.com.cy
          </div>
          <p>We apologise for any inconvenience and look forward to assisting you.</p>
          <p>The Motowarehouse Team</p>
        </div>
      </div>
    `
  });

  if (error) throw new Error(error.message || JSON.stringify(error));
}

// ── Reminder (2 hours before appointment) ───────────────────────────────────
async function sendReminderToCustomer(booking) {
  if (!booking.email) return;

  const resend = getResend();
  const { error } = await resend.emails.send({
    from:     FROM,
    reply_to: REPLY_TO,
    to:       [booking.email],
    subject: `Reminder: Your appointment today at ${booking.time} – ${booking.ref}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#009BB4;padding:24px;text-align:center;">
          <h1 style="color:white;margin:0;font-size:24px;">Appointment Reminder</h1>
        </div>
        <div style="padding:32px;background:#fff;">
          <p>Dear ${booking.name},</p>
          <p>This is a reminder that your <strong>${SERVICE_LABELS[booking.serviceType]}</strong> appointment is in approximately <strong>2 hours</strong>.</p>
          <table style="border-collapse:collapse;width:100%;margin:20px 0;">
            <tr style="background:#f5f5f5;"><td style="padding:10px;font-weight:bold;">Time</td><td style="padding:10px;">${booking.time}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Vehicle</td><td style="padding:10px;">${booking.year} ${booking.model}</td></tr>
          </table>
          <div style="background:#f0fbfd;border-left:4px solid #009BB4;padding:16px;">
            <strong>Motowarehouse – 40 Athinon Str., Strovolos, Nicosia</strong><br>
            Tel: 22 328 788
          </div>
          <p style="margin-top:20px;">The Motowarehouse Team</p>
        </div>
      </div>
    `
  });

  if (error) throw new Error(error.message || JSON.stringify(error));
}

module.exports = {
  sendNewBookingAlert,
  sendConfirmationToCustomer,
  sendCancellationToCustomer,
  sendReminderToCustomer
};
