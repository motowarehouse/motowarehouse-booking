const https = require('https');

const SERVICE_LABELS = {
  'small-service': 'Small Service',
  'full-service':  'Full Service',
  'other':         'Service Request'
};

function formatPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  // If already has country code (from form), just ensure + prefix
  if (digits.startsWith('00')) return '+' + digits.slice(2);
  if (phone.startsWith('+'))   return phone;
  // Fallback: assume Cyprus 8-digit number
  if (digits.length === 8) return '+357' + digits;
  return '+' + digits;
}

function sendBrevoSMS(to, content) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.log('[SMS skipped – BREVO_API_KEY not set]');
    return Promise.resolve();
  }

  const payload = JSON.stringify({
    sender:    'MotoWH',   // max 11 chars, alphanumeric
    recipient: formatPhone(to),
    content,
    type:      'transactional'
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path:     '/v3/transactionalSMS/sms',
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
          console.log(`[SMS] Sent to ${to}`);
          resolve();
        } else {
          reject(new Error(`Brevo SMS error ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendConfirmationSMS(booking) {
  // 'other' type bookings are handled by phone call, not auto-SMS
  if (booking.serviceType === 'other') return;
  const siteUrl = process.env.SITE_URL || '';
  const cancelUrl = siteUrl ? ` Cancel: ${siteUrl}/cancel?ref=${booking.ref}` : '';
  const msg = `Motowarehouse: Your ${SERVICE_LABELS[booking.serviceType]} is confirmed for ${booking.date} at ${booking.time}. Ref: ${booking.ref}. 40 Athinon Str, Strovolos. Tel: 22328788.${cancelUrl}`;
  await sendBrevoSMS(booking.phone, msg);
}

async function sendCancellationSMS(booking) {
  const msg = `Motowarehouse: Your booking ${booking.ref} on ${booking.date} at ${booking.time} could not be confirmed. Please call 22328788 to reschedule.`;
  await sendBrevoSMS(booking.phone, msg);
}

async function sendReminderSMS(booking) {
  const msg = `Motowarehouse: Reminder – your ${SERVICE_LABELS[booking.serviceType]} is in ~2 hours at ${booking.time}. 40 Athinon Str, Strovolos. Tel: 22328788`;
  await sendBrevoSMS(booking.phone, msg);
}

async function sendRescheduleSMS(booking) {
  const msg = `Motowarehouse: Your booking ${booking.ref} has been rescheduled to ${booking.date} at ${booking.time}. Tel: 22328788`;
  await sendBrevoSMS(booking.phone, msg);
}

async function sendVehicleReadySMS(booking) {
  const msg = `Motowarehouse: Your ${SERVICE_LABELS[booking.serviceType] || 'service'} is complete. Your vehicle (${booking.plate}) is ready for collection. 40 Athinon Str, Strovolos. Tel: 22328788`;
  await sendBrevoSMS(booking.phone, msg);
}

async function sendPreviousDayReminderSMS(booking) {
  const msg = `Motowarehouse: Reminder – you have a ${SERVICE_LABELS[booking.serviceType]} appointment tomorrow (${booking.date}) at ${booking.time}. 40 Athinon Str, Strovolos. Tel: 22328788`;
  await sendBrevoSMS(booking.phone, msg);
}

module.exports = { sendConfirmationSMS, sendCancellationSMS, sendReminderSMS, sendRescheduleSMS, sendVehicleReadySMS, sendPreviousDayReminderSMS, sendBrevoSMS };
