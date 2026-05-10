const cron = require('node-cron');
const db = require('./db');
const { sendReminderToCustomer } = require('./emailService');
const { sendReminderSMS } = require('./smsService');

function startReminderCron() {
  // Check every 15 minutes for upcoming appointments
  cron.schedule('*/15 * * * *', async () => {
    try {
      const due = db.getAcceptedBookingsDueForReminder();
      for (const booking of due) {
        console.log(`[Reminder] Sending reminder for booking ${booking.ref}`);
        await sendReminderToCustomer(booking);
        await sendReminderSMS(booking);
        db.markReminderSent(booking.id);
      }
    } catch (err) {
      console.error('[Reminder cron error]', err.message);
    }
  });
  console.log('[Cron] Reminder scheduler started (every 15 min)');
}

module.exports = { startReminderCron };
