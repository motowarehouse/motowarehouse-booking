const cron = require('node-cron');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const BACKUP_RETAIN_DAYS = 30;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' || (process.env.DATABASE_URL || '').includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// ── Tables to back up ────────────────────────────────────────────────────────
const TABLES = [
  'bookings',
  'partners',
  'vehicles',
  'service_history',
  'warranty_claims',
  'opening_hours',
  'manual_blocks',
  'session'
];

async function runBackup() {
  const startedAt = new Date();
  console.log(`[Backup] Starting at ${startedAt.toISOString()}`);

  try {
    // ── 1. Dump all tables to JSON ───────────────────────────────────────────
    const dump = { _meta: { createdAt: startedAt.toISOString(), tables: {} } };

    for (const table of TABLES) {
      try {
        const { rows } = await pool.query(`SELECT * FROM ${table}`);
        dump._meta.tables[table] = rows.length;
        dump[table] = rows;
      } catch (err) {
        // Table might not exist yet — skip it gracefully
        console.warn(`[Backup] Skipping table "${table}": ${err.message}`);
        dump[table] = [];
      }
    }

    // ── 2. Serialise ─────────────────────────────────────────────────────────
    const json    = JSON.stringify(dump, null, 2);
    const buffer  = Buffer.from(json, 'utf8');

    // ── 3. Build filename: backups/2026-05-15T02-00-00.json ─────────────────
    const dateStr = startedAt.toISOString().replace(/:/g, '-').split('.')[0];
    const key     = `backups/${dateStr}.json`;

    // ── 4. Upload to R2 ──────────────────────────────────────────────────────
    await s3.send(new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET_NAME,
      Key:         key,
      Body:        buffer,
      ContentType: 'application/json',
    }));

    const sizeKB = (buffer.length / 1024).toFixed(1);
    console.log(`[Backup] ✅ Uploaded ${key} (${sizeKB} KB)`);

    // ── 5. Delete backups older than BACKUP_RETAIN_DAYS ──────────────────────
    const cutoff = new Date(startedAt);
    cutoff.setDate(cutoff.getDate() - BACKUP_RETAIN_DAYS);

    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME,
      Prefix: 'backups/'
    }));

    const toDelete = (listed.Contents || []).filter(obj => {
      return obj.Key !== key && new Date(obj.LastModified) < cutoff;
    });

    for (const obj of toDelete) {
      await s3.send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key:    obj.Key
      }));
      console.log(`[Backup] 🗑  Deleted old backup: ${obj.Key}`);
    }

    console.log(`[Backup] Done. ${Object.keys(dump._meta.tables).length} tables, ${sizeKB} KB.`);
  } catch (err) {
    console.error('[Backup] ❌ Failed:', err.message);
  }
}

// ── Schedule: every day at 02:00 Cyprus time (UTC+3 in summer / UTC+2 in winter)
// Running at 23:00 UTC covers both offsets safely.
function startBackupCron() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID) {
    console.warn('[Backup] R2 env vars not set — nightly backup disabled.');
    return;
  }

  // Run at 23:00 UTC every day (= 02:00 Cyprus time)
  cron.schedule('0 23 * * *', () => {
    runBackup();
  });

  console.log('[Backup] Nightly backup scheduled (23:00 UTC = 02:00 Cyprus).');
}

module.exports = { startBackupCron, runBackup };
