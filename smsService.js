let twilioClient = null;

function getClient() {
  if (!twilioClient && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

const SERVICE_LABELS = {
  'oil-change': 'Oil Change',
  'small-service': 'Small Service',
  'big-service': 'Big Service'
};

function formatPhone(phone) {
  // Ensure Cyprus numbers start with +357
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('357')) return '+' + digits;
  if (digits.startsWith('00357')) return '+' + digits.slice(2);
  if (digits.length === 8) return '+357' + digits;
  return '+' + digits;
}

async function sendSMS(to, body) {
  const client = getClient();
  if (!client || !process.env.TWILIO_FROM_NUMBER) {
    console.log('[SMS skipped – Twilio not configured]', to, body);
    return;
  }
  try {
    await client.messages.create({
      body,
      from: process.env.TWILIO_FROM_NUMBER,
      to: formatPhone(to)
    });
  } catch (err) {
    console.error('[SMS error]', err.message);
  }
}

async function sendConfirmationSMS(booking) {
  const msg = `Motowarehouse: Your ${SERVICE_LABELS[booking.serviceType]} is confirmed for ${booking.date} at ${booking.time}. Ref: ${booking.ref}. Address: 40 Athinon Str, Strovolos. Tel: 22328788`;
  await sendSMS(booking.phone, msg);
}

async function sendCancellationSMS(booking) {
  const msg = `Motowarehouse: Your booking ${booking.ref} on ${booking.date} at ${booking.time} could not be confirmed. Please call us on 22328788 to reschedule.`;
  await sendSMS(booking.phone, msg);
}

async function sendReminderSMS(booking) {
  const msg = `Motowarehouse Reminder: Your ${SERVICE_LABELS[booking.serviceType]} appointment is in ~2 hours at ${booking.time}. 40 Athinon Str, Strovolos. Tel: 22328788`;
  await sendSMS(booking.phone, msg);
}

module.exports = { sendConfirmationSMS, sendCancellationSMS, sendReminderSMS };
