const webpush = require('web-push');
const { pool } = require('./db');

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Save a new subscription ────────────────────────────────────────────────
async function saveSubscription(subscription) {
  const { endpoint, keys: { p256dh, auth } } = subscription;
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth)
     VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = $2, auth = $3`,
    [endpoint, p256dh, auth]
  );
}

// ── Remove a subscription ──────────────────────────────────────────────────
async function removeSubscription(endpoint) {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

// ── Send push to all saved subscriptions ──────────────────────────────────
async function sendPushToAll(payload) {
  const { rows } = await pool.query('SELECT * FROM push_subscriptions');
  if (!rows.length) return;

  const json = JSON.stringify(payload);

  const results = await Promise.allSettled(
    rows.map(row => {
      const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      return webpush.sendNotification(sub, json).catch(async err => {
        // 410 Gone = subscription expired/revoked — clean it up
        if (err.statusCode === 410 || err.statusCode === 404) {
          await removeSubscription(row.endpoint).catch(() => {});
        }
        throw err;
      });
    })
  );

  const sent   = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  console.log(`[Push] Sent: ${sent}, Failed/cleaned: ${failed}`);
}

// ── Pre-built notification payloads ───────────────────────────────────────
function newBookingPayload(booking) {
  const SVC = { 'small-service': 'Small Service', 'full-service': 'Full Service', 'other': 'Other Request' };
  const isOther = booking.serviceType === 'other';
  return {
    title: `📋 New Booking — ${booking.ref}`,
    body:  isOther
      ? `${booking.name} · ${booking.model} · Needs a call to arrange date`
      : `${booking.name} · ${booking.model} · ${SVC[booking.serviceType] || booking.serviceType} · ${booking.date} at ${booking.time}`,
    tag:   'new-booking',
    url:   '/admin/',
    requireInteraction: true,
  };
}

function selfCancelPayload(booking) {
  return {
    title: `❌ Booking Cancelled — ${booking.ref}`,
    body:  `${booking.name} cancelled their ${booking.date} appointment via the self-service link.`,
    tag:   'booking-cancelled',
    url:   '/admin/',
  };
}

module.exports = { saveSubscription, removeSubscription, sendPushToAll, newBookingPayload, selfCancelPayload };
