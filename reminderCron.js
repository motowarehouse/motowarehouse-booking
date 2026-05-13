const cron = require('node-cron');
const db = require('./db');
const { sendReminderToCustomer } = require('./emailService');
const { sendReminderSMS } = require('./smsService');

function startReminderCron() {
  // Check every 15 minutes for upcoming appointments
  cron.schedule('*/15 * * * *', async () => {
    try {
      const due = await db.getAcceptedBookingsDueForReminder();
      for (const booking of due) {
        console.log(`[Reminder] Sending reminder for booking ${booking.ref}`);
        try { await sendReminderToCustomer(booking); } catch (e) { console.error('[Reminder email failed]', e.message); }
        try { await sendReminderSMS(booking); }         catch (e) { console.error('[Reminder SMS failed]',   e.message); }
        await db.markReminderSent(booking.id);
      }
    } catch (err) {
      console.error('[Reminder cron error]', err.message);
    }
  });
  console.log('[Cron] Reminder scheduler started (every 15 min)');
  // Note: no file-based backup needed — PostgreSQL on Railway handles data persistence.
}

module.exports = { startReminderCron };
