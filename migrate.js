/**
 * migrate.js — One-time migration from bookings.json → PostgreSQL
 *
 * Run ONCE after provisioning the database and running schema.sql:
 *   node migrate.js
 *
 * Safe to run multiple times — uses ON CONFLICT DO NOTHING for all inserts.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌  DATABASE_URL not set in .env');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' || process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'bookings.json')
  : path.join(__dirname, 'bookings.json');

async function migrate() {
  if (!fs.existsSync(DB_PATH)) {
    console.log('ℹ️  No bookings.json found — nothing to migrate.');
    await pool.end();
    return;
  }

  const raw = fs.readFileSync(DB_PATH, 'utf8');
  const data = JSON.parse(raw);

  let counts = { bookings: 0, blocks: 0, vehicles: 0, partners: 0, service: 0, warranty: 0, settings: 0 };

  // ── Settings ──────────────────────────────────────────────────────────────
  if (data.hours) {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('hours', $1::jsonb) ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify(data.hours)]
    );
    counts.settings++;
  }
  if (data.settings) {
    for (const [key, value] of Object.entries(data.settings)) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`,
        [key, JSON.stringify(value)]
      );
      counts.settings++;
    }
  }

  // ── Bookings ──────────────────────────────────────────────────────────────
  for (const b of (data.bookings || [])) {
    const { rowCount } = await pool.query(
      `INSERT INTO bookings
         (id, name, phone, email, service_type, date, time, model, year, plate, km,
          notes, description, mechanic, status, contact_status, reminder_sent,
          service_km, service_reg_no, completed_at, updated_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (id) DO NOTHING`,
      [
        b.id, b.name, b.phone, b.email || '', b.serviceType,
        b.date || '', b.time || '',
        b.model, b.year, b.plate, b.km,
        b.notes || '', b.description || '',
        b.mechanic || 1, b.status || 'pending',
        b.contactStatus || null, b.reminderSent || false,
        b.serviceKm || null, b.serviceRegNo || null,
        b.completedAt || null, b.updatedAt || null,
        b.createdAt || new Date().toISOString()
      ]
    );
    if (rowCount) counts.bookings++;
  }

  // Advance the serial sequence past the highest migrated ID
  if ((data.bookings || []).length > 0) {
    const maxId = Math.max(...data.bookings.map(b => b.id));
    await pool.query(`SELECT setval(pg_get_serial_sequence('bookings','id'), $1, true)`, [maxId]);
    console.log(`   Booking sequence advanced to ${maxId}`);
  }

  // ── Blocks ────────────────────────────────────────────────────────────────
  for (const b of (data.blocks || [])) {
    const { rowCount } = await pool.query(
      `INSERT INTO blocks (id, date, start_time, end_time, reason, customer_name, customer_phone, vehicle_model, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [b.id, b.date, b.startTime, b.endTime,
       b.reason||'', b.customerName||'', b.customerPhone||'', b.vehicleModel||'', b.notes||'',
       b.createdAt || new Date().toISOString()]
    );
    if (rowCount) counts.blocks++;
  }

  // ── Vehicles ──────────────────────────────────────────────────────────────
  for (const v of (data.vehicles || [])) {
    const { rowCount } = await pool.query(
      `INSERT INTO vehicles (reg_no, frame_no, engine_no, model, manufacturer, description, year, status, updated_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (reg_no) DO NOTHING`,
      [v.regNo, v.frameNo||'', v.engineNo||'', v.model||'', v.manufacturer||'', v.description||'', v.year||'',
       v.status||'registered',
       v.updatedAt||new Date().toISOString(), v.createdAt||new Date().toISOString()]
    );
    if (rowCount) counts.vehicles++;
  }

  // ── Partners ──────────────────────────────────────────────────────────────
  for (const p of (data.partners || [])) {
    const { rowCount } = await pool.query(
      `INSERT INTO partners (id, username, password_hash, workshop_name, phone, active, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.username, p.passwordHash, p.workshopName, p.phone||'', p.active!==false, p.createdAt||new Date().toISOString()]
    );
    if (rowCount) counts.partners++;
  }

  // ── Service History ───────────────────────────────────────────────────────
  for (const e of (data.serviceHistory || [])) {
    const { rowCount } = await pool.query(
      `INSERT INTO service_history (id, reg_no, date, km, items, notes, partner_id, partner_name, logged_by_admin, booking_ref, updated_at, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
      [e.id, e.regNo, e.date, e.km||0,
       JSON.stringify(e.items||[]), e.notes||'',
       e.partnerId||null, e.partnerName||'Motowarehouse',
       e.loggedByAdmin||false, e.bookingRef||null,
       e.updatedAt||null, e.createdAt||new Date().toISOString()]
    );
    if (rowCount) counts.service++;
  }

  // ── Warranty History ──────────────────────────────────────────────────────
  for (const w of (data.warrantyHistory || [])) {
    const { rowCount } = await pool.query(
      `INSERT INTO warranty_history
         (id, reg_no, frame_no, km, sale_date, symptom, priority,
          engine_disassembly, defect_agreed, courtesy_vehicle,
          notes, photos, media_types, logged_by, logged_by_admin,
          partner_id, partner_name, status, admin_notes, updated_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (id) DO NOTHING`,
      [w.id, w.regNo, w.frameNo||'', w.km||0, w.saleDate||'',
       w.symptom, w.priority||'normal',
       !!w.engineDisassembly, !!w.defectAgreed, !!w.courtesyVehicle,
       w.notes||'',
       JSON.stringify(w.photos||[]), JSON.stringify(w.mediaTypes||[]),
       w.loggedBy||'Motowarehouse', w.loggedByAdmin||false,
       w.partnerId||null, w.partnerName||'Motowarehouse',
       w.status||'open', w.adminNotes||null,
       w.updatedAt||null, w.createdAt||new Date().toISOString()]
    );
    if (rowCount) counts.warranty++;
  }

  console.log('\n✅ Migration complete:');
  console.log(`   Bookings:        ${counts.bookings}`);
  console.log(`   Blocks:          ${counts.blocks}`);
  console.log(`   Vehicles:        ${counts.vehicles}`);
  console.log(`   Partners:        ${counts.partners}`);
  console.log(`   Service entries: ${counts.service}`);
  console.log(`   Warranty claims: ${counts.warranty}`);
  console.log(`   Settings:        ${counts.settings}\n`);

  await pool.end();
}

migrate().catch(err => {
  console.error('❌  Migration failed:', err.message);
  process.exit(1);
});
