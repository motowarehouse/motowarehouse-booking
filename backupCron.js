// backupCron.js
// Database backups are handled automatically by Railway's PostgreSQL service.
// This stub exists to satisfy the require() in server.js.
// If a custom backup strategy is ever needed (e.g. exporting to R2), implement it here.

function startBackupCron() {
  console.log('[BackupCron] No custom backup needed — Railway PostgreSQL handles automated backups.');
}

module.exports = { startBackupCron };
