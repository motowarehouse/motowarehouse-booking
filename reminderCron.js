const cron = require('node-cron');
const fs   = require('fs');
const path = require('path');
const db = require('./db');
const { sendReminderToCustomer } = require('./emailService');
const { sendReminderSMS } = require('./smsService');

// Resolve same DB path logic as db.js
const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'bookings.json')
  : path.join(__dirname, 'bookings.json');

const BACKUP_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'backups')
  : path.join(__dirname, 'backups');

function runDailyBackup() {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const dest = path.join(BACKUP_DIR, `bookings-${date}.json`);
    fs.copyFileSync(DB_PATH, dest);
    console.log(`[Backup] bookings.json backed up → bookings-${date}.json`);

    // Keep only last 30 backups to avoid filling up storage
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('bookings-') && f.endsWith('.json'))
      .sort();
    if (files.length > 30) {
      const toDelete = files.slice(0, files.length - 30);
      toDelete.forEach(f => {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
        console.log(`[Backup] Removed old backup: ${f}`);
      });
    }
  } catch (err) {
    console.error('[Backup error]', err.message);
  }
}

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

  // Daily backup at 02:00 Cyprus time (00:00 UTC)
  cron.schedule('0 0 * * *', () => {
    console.log('[Cron] Running daily backup…');
    runDailyBackup();
  }, { timezone: 'UTC' });
  console.log('[Cron] Daily backup scheduled (02:00 Cyprus / 00:00 UTC)');

  // Run once immediately on startup so there's always a fresh backup
  runDailyBackup();
}

module.exports = { startReminderCron };
