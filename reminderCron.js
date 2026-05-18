const cron = require('node-cron');
const db = require('./db');
const { sendReminderToCustomer, sendPreviousDayReminderToCustomer } = require('./emailService');
const { sendReminderSMS, sendPreviousDayReminderSMS } = require('./smsService');

function startReminderCron() {

  // ── 2-hour appointment reminder (every 15 minutes) ──────────────────────────
  cron.schedule('*/15 * * * *', async () => {
    try {
      const due = await db.getAcceptedBookingsDueForReminder();
      for (const booking of due) {
        console.log(`[Reminder] Sending 2-hour reminder for booking ${booking.ref}`);
        try { await sendReminderToCustomer(booking); } catch (e) { console.error('[Reminder email failed]', e.message); }
        try { await sendReminderSMS(booking); }         catch (e) { console.error('[Reminder SMS failed]',   e.message); }
        await db.markReminderSent(booking.id);
      }
    } catch (err) {
      console.error('[Reminder cron error]', err.message);
    }
  });

  // ── Previous-day reminder at 20:00 (for early next-day appointments) ─────────
  // Runs at 20:00 Cyprus time every day. Sends email + SMS to customers with
  // appointments before 11:00 the following morning.
  // Cyprus is UTC+2 (EET) / UTC+3 (EEST). The safe cross-DST cron for "20:00 Cyprus":
  //   In summer (EEST, UTC+3): 20:00 local = 17:00 UTC → cron "0 17 * * *"
  //   In winter (EET,  UTC+2): 20:00 local = 18:00 UTC → cron "0 18 * * *"
  // We run both and guard with a Cyprus-local-hour check to avoid double-sending.
  const dayBeforeReminderHandler = async () => {
    const cyprusHour = parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Nicosia', hour: 'numeric', hour12: false
      }).format(new Date()),
      10
    );
    // Only proceed if it's genuinely 20:xx in Cyprus
    if (cyprusHour !== 20) return;

    try {
      const due = await db.getBookingsDueForDayBeforeReminder();
      for (const booking of due) {
        console.log(`[DayBefore] Sending previous-day reminder for booking ${booking.ref} (${booking.date} ${booking.time})`);
        try { await sendPreviousDayReminderToCustomer(booking); } catch (e) { console.error('[DayBefore email failed]', e.message); }
        try {
          if (typeof sendPreviousDayReminderSMS === 'function') {
            await sendPreviousDayReminderSMS(booking);
          }
        } catch (e) { console.error('[DayBefore SMS failed]', e.message); }
        await db.markDayBeforeReminderSent(booking.id);
      }
    } catch (err) {
      console.error('[DayBefore cron error]', err.message);
    }
  };

  cron.schedule('0 17 * * *', dayBeforeReminderHandler); // 20:00 EEST (summer)
  cron.schedule('0 18 * * *', dayBeforeReminderHandler); // 20:00 EET  (winter)

  // ── Pending booking expiry (every day at 01:00 UTC) ───────────────────────────
  // Expires bookings that have been pending for more than 48 hours.
  cron.schedule('0 1 * * *', async () => {
    try {
      await db.expirePendingBookings();
    } catch (err) {
      console.error('[Expiry cron error]', err.message);
    }
  });

  // ── GDPR data retention — annual deletion (1 January at 03:00 UTC) ───────────
  // Deletes bookings and related service history older than 6 years.
  // Cyprus tax law requires records to be retained for 6 years; they must be
  // deleted once that period has elapsed. Runs once a year at a low-traffic time.
  cron.schedule('0 3 1 1 *', async () => {
    try {
      console.log('[GDPR Cron] Annual data retention run started — deleting records older than 6 years...');
      await db.deleteOldBookings();
    } catch (err) {
      console.error('[GDPR Cron] Annual deletion failed:', err.message);
    }
  });

  console.log('[Cron] Reminder scheduler started (15-min reminders, 20:00 day-before, 01:00 expiry, annual GDPR deletion)');
  // Note: no file-based backup needed — PostgreSQL on Railway handles data persistence.
}

module.exports = { startReminderCron };
