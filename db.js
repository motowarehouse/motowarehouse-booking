require('dotenv').config();
const { Pool } = require('pg');

// ── Connection ────────────────────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  console.error('\n❌  DATABASE_URL is not set.');
  console.error('    Add your PostgreSQL connection string to .env or Railway variables.\n');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' || process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// ── Row mappers (DB snake_case → JS camelCase) ────────────────────────────────

function rowToBooking(r) {
  if (!r) return null;
  return {
    id:            r.id,
    ref:           r.ref,
    name:          r.name,
    phone:         r.phone,
    email:         r.email,
    serviceType:   r.service_type,
    date:          r.date,
    time:          r.time,
    model:         r.model,
    year:          r.year,
    plate:         r.plate,
    km:            r.km,
    notes:         r.notes,
    description:   r.description,
    mechanic:      r.mechanic,
    status:        r.status,
    contactStatus: r.contact_status,
    reminderSent:  r.reminder_sent,
    serviceKm:     r.service_km,
    serviceRegNo:  r.service_reg_no,
    completedAt:   r.completed_at,
    updatedAt:     r.updated_at,
    createdAt:     r.created_at
  };
}

function rowToBlock(r) {
  if (!r) return null;
  return {
    id:            r.id,
    date:          r.date,
    startTime:     r.start_time,
    endTime:       r.end_time,
    reason:        r.reason,
    customerName:  r.customer_name,
    customerPhone: r.customer_phone,
    vehicleModel:  r.vehicle_model,
    notes:         r.notes,
    createdAt:     r.created_at
  };
}

function rowToVehicle(r) {
  if (!r) return null;
  return {
    regNo:        r.reg_no,
    frameNo:      r.frame_no,
    engineNo:     r.engine_no,
    model:        r.model,
    manufacturer: r.manufacturer,
    description:  r.description,
    year:         r.year,
    status:       r.status,
    updatedAt:    r.updated_at,
    createdAt:    r.created_at
  };
}

function rowToPartner(r) {
  if (!r) return null;
  return {
    id:           r.id,
    username:     r.username,
    passwordHash: r.password_hash,
    workshopName: r.workshop_name,
    phone:        r.phone,
    active:       r.active,
    createdAt:    r.created_at
  };
}

function rowToServiceEntry(r) {
  if (!r) return null;
  return {
    id:            r.id,
    regNo:         r.reg_no,
    date:          r.date,
    km:            r.km,
    items:         r.items || [],
    notes:         r.notes,
    partnerId:     r.partner_id,
    partnerName:   r.partner_name,
    loggedByAdmin: r.logged_by_admin,
    bookingRef:    r.booking_ref,
    updatedAt:     r.updated_at,
    createdAt:     r.created_at
  };
}

function rowToWarranty(r) {
  if (!r) return null;
  return {
    id:                r.id,
    regNo:             r.reg_no,
    frameNo:           r.frame_no,
    km:                r.km,
    saleDate:          r.sale_date,
    symptom:           r.symptom,
    priority:          r.priority,
    engineDisassembly: r.engine_disassembly,
    defectAgreed:      r.defect_agreed,
    courtesyVehicle:   r.courtesy_vehicle,
    notes:             r.notes,
    photos:            r.photos     || [],
    mediaTypes:        r.media_types || [],
    loggedBy:          r.logged_by,
    loggedByAdmin:     r.logged_by_admin,
    partnerId:         r.partner_id,
    partnerName:       r.partner_name,
    status:            r.status,
    adminNotes:        r.admin_notes,
    updatedAt:         r.updated_at,
    createdAt:         r.created_at
  };
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function getSetting(key) {
  const { rows } = await pool.query(
    'SELECT value FROM settings WHERE key = $1', [key]
  );
  return rows.length ? rows[0].value : null;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
}

// ── Bookings ─────────────────────────────────────────────────────────────────

const MECHANIC_COUNT = 2;

async function createBooking(data) {
  // Auto-assign to the mechanic that is free at this slot
  const { rows: taken } = await pool.query(
    `SELECT mechanic FROM bookings
     WHERE date = $1 AND time = $2 AND status IN ('pending','accepted')`,
    [data.date, data.time]
  );
  const mechanic = taken.some(b => b.mechanic === 1) ? 2 : 1;

  const { rows } = await pool.query(
    `INSERT INTO bookings
       (name, phone, email, service_type, date, time, model, year, plate, km,
        notes, description, mechanic, status, contact_status, reminder_sent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,false)
     RETURNING *`,
    [
      data.name, data.phone, data.email || '', data.serviceType,
      data.date || '', data.time || '',
      data.model, data.year, data.plate, data.km,
      data.notes || '', data.description || '',
      mechanic,
      data.contactStatus || null
    ]
  );
  return rowToBooking(rows[0]);
}

async function getAllBookings() {
  const { rows } = await pool.query(
    'SELECT * FROM bookings ORDER BY created_at DESC'
  );
  return rows.map(rowToBooking);
}

async function getBookingById(id) {
  const { rows } = await pool.query(
    'SELECT * FROM bookings WHERE id = $1', [parseInt(id)]
  );
  return rowToBooking(rows[0] || null);
}

async function updateBookingStatus(id, status) {
  const extra = status === 'cancelled'
    ? `, contact_status = 'needs-contact'`
    : '';
  const { rows } = await pool.query(
    `UPDATE bookings SET status = $1, updated_at = NOW()${extra}
     WHERE id = $2 RETURNING *`,
    [status, parseInt(id)]
  );
  return rowToBooking(rows[0] || null);
}

async function rescheduleBooking(id, newDate, newTime) {
  const { rows } = await pool.query(
    `UPDATE bookings
     SET date = $1, time = $2, status = 'accepted',
         contact_status = NULL, reminder_sent = false, updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [newDate, newTime, parseInt(id)]
  );
  return rowToBooking(rows[0] || null);
}

async function updateContactStatus(id, contactStatus) {
  const { rows } = await pool.query(
    `UPDATE bookings SET contact_status = $1, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [contactStatus, parseInt(id)]
  );
  return rowToBooking(rows[0] || null);
}

async function markReminderSent(id) {
  await pool.query(
    'UPDATE bookings SET reminder_sent = true WHERE id = $1', [parseInt(id)]
  );
}

async function getAcceptedBookingsDueForReminder() {
  const { rows } = await pool.query(
    `SELECT * FROM bookings WHERE status = 'accepted' AND reminder_sent = false`
  );
  const now = new Date();
  const windowStart    = new Date(now.getTime() + 90 * 60 * 1000);
  const twoHoursFromNow = new Date(now.getTime() + 2  * 60 * 60 * 1000);
  return rows.map(rowToBooking).filter(b => {
    if (!b.date || !b.time) return false;
    const apptTime = new Date(b.date + 'T' + b.time);
    return apptTime >= windowStart && apptTime <= twoHoursFromNow;
  });
}

async function getBookedSlots(date) {
  const { rows: appts } = await pool.query(
    `SELECT time, mechanic FROM bookings
     WHERE date = $1 AND status IN ('pending','accepted')`,
    [date]
  );
  const slotCounts = {};
  appts.forEach(b => { slotCounts[b.time] = (slotCounts[b.time] || 0) + 1; });
  const bookingSlots = Object.keys(slotCounts)
    .filter(s => slotCounts[s] >= MECHANIC_COUNT);

  const { rows: blks } = await pool.query(
    'SELECT start_time, end_time FROM blocks WHERE date = $1', [date]
  );
  const blockSlots = [];
  blks.forEach(bl => {
    let [sh, sm] = bl.start_time.split(':').map(Number);
    const [eh, em] = bl.end_time.split(':').map(Number);
    while (sh * 60 + sm < eh * 60 + em) {
      blockSlots.push(`${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`);
      sm += 30;
      if (sm >= 60) { sh++; sm -= 60; }
    }
  });

  return [...new Set([...bookingSlots, ...blockSlots])];
}

// ── Complete / No-Show ────────────────────────────────────────────────────────

async function completeBooking(id, serviceData) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch booking first to check it exists and get defaults
    const { rows: bRows } = await client.query(
      'SELECT * FROM bookings WHERE id = $1', [parseInt(id)]
    );
    if (!bRows.length) { await client.query('ROLLBACK'); return null; }

    const b = bRows[0];
    const regNo = (serviceData.regNo || b.plate || '').toString()
      .toUpperCase().replace(/\s/g, '');

    // Update booking
    const { rows: updatedRows } = await client.query(
      `UPDATE bookings
       SET status = 'completed', completed_at = NOW(), updated_at = NOW(),
           service_km = $1, service_reg_no = $2
       WHERE id = $3 RETURNING *`,
      [parseInt(serviceData.km) || 0, regNo, parseInt(id)]
    );

    // Insert service history entry atomically
    const entryId = Date.now();
    const { rows: entryRows } = await client.query(
      `INSERT INTO service_history
         (id, reg_no, date, km, items, notes, partner_id, partner_name, logged_by_admin, booking_ref)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        entryId,
        regNo,
        serviceData.date || b.date,
        parseInt(serviceData.km) || 0,
        JSON.stringify(Array.isArray(serviceData.items) ? serviceData.items : []),
        serviceData.notes || '',
        null,
        'Motowarehouse',
        true,
        b.ref
      ]
    );

    await client.query('COMMIT');
    return {
      booking:      rowToBooking(updatedRows[0]),
      serviceEntry: rowToServiceEntry(entryRows[0])
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function markNoShow(id) {
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'no-show', updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [parseInt(id)]
  );
  return rowToBooking(rows[0] || null);
}

// ── Manual Blocks ─────────────────────────────────────────────────────────────

async function createBlock(data) {
  const id = Date.now();
  const { rows } = await pool.query(
    `INSERT INTO blocks (id, date, start_time, end_time, reason, customer_name, customer_phone, vehicle_model, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      id, data.date, data.startTime, data.endTime,
      data.reason || '', data.customerName || '',
      data.customerPhone || '', data.vehicleModel || '', data.notes || ''
    ]
  );
  return rowToBlock(rows[0]);
}

async function getAllBlocks() {
  const { rows } = await pool.query(
    'SELECT * FROM blocks ORDER BY date, start_time'
  );
  return rows.map(rowToBlock);
}

async function deleteBlock(id) {
  const { rowCount } = await pool.query(
    'DELETE FROM blocks WHERE id = $1', [parseInt(id)]
  );
  return rowCount > 0;
}

// ── Opening Hours ─────────────────────────────────────────────────────────────

const DEFAULT_HOURS = {
  0: { closed: true,  ranges: [] },
  1: { closed: false, ranges: [['08:30','12:30'],['14:00','17:00']] },
  2: { closed: false, ranges: [['08:30','12:30'],['14:00','17:00']] },
  3: { closed: false, ranges: [['08:30','12:30']] },
  4: { closed: false, ranges: [['08:30','12:30'],['14:00','17:00']] },
  5: { closed: false, ranges: [['08:30','12:30'],['14:00','17:00']] },
  6: { closed: false, ranges: [['09:00','12:30']] }
};

async function getHours() {
  const val = await getSetting('hours');
  return val || DEFAULT_HOURS;
}

async function saveHours(hours) {
  await setSetting('hours', hours);
}

// ── Vehicles ──────────────────────────────────────────────────────────────────

async function importVehicles(rows) {
  let added = 0, updated = 0, skipped = 0;

  for (const row of rows) {
    const rawReg   = (row.regNo   || '').toString().toUpperCase().replace(/\s/g, '');
    const rawFrame = (row.frameNo || '').toString().trim().toUpperCase().replace(/\s/g, '');

    let key;
    let isStock = false;
    if (rawReg) {
      key = rawReg;
    } else if (rawFrame) {
      key = 'FN:' + rawFrame;
      isStock = true;
    } else {
      skipped++;
      continue;
    }

    // xmax = 0 means row was inserted (not updated)
    const { rows: res } = await pool.query(
      `INSERT INTO vehicles (reg_no, frame_no, engine_no, model, manufacturer, description, year, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (reg_no) DO UPDATE SET
         frame_no = EXCLUDED.frame_no,
         engine_no = EXCLUDED.engine_no,
         model = EXCLUDED.model,
         manufacturer = EXCLUDED.manufacturer,
         description = EXCLUDED.description,
         year = EXCLUDED.year,
         status = EXCLUDED.status,
         updated_at = NOW()
       RETURNING (xmax = 0) AS is_insert`,
      [
        key,
        (row.frameNo     || '').toString().trim(),
        (row.engineNo    || '').toString().trim(),
        (row.model       || '').toString().trim(),
        (row.manufacturer|| '').toString().trim(),
        (row.description || '').toString().trim(),
        (row.year        || '').toString().trim(),
        isStock ? 'stock' : 'registered'
      ]
    );
    if (res[0].is_insert) added++; else updated++;
  }

  const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM vehicles');
  return { added, updated, skipped, total: parseInt(countRows[0].count) };
}

async function getVehicleByPlate(regNo) {
  const key = (regNo || '').toString().toUpperCase().replace(/\s/g, '');
  const { rows } = await pool.query(
    'SELECT * FROM vehicles WHERE reg_no = $1', [key]
  );
  return rowToVehicle(rows[0] || null);
}

async function getAllVehicles() {
  const { rows } = await pool.query(
    'SELECT * FROM vehicles ORDER BY reg_no'
  );
  return rows.map(rowToVehicle);
}

// ── Partners ──────────────────────────────────────────────────────────────────

async function createPartner(data) {
  const id = Date.now();
  const { rows } = await pool.query(
    `INSERT INTO partners (id, username, password_hash, workshop_name, phone, active)
     VALUES ($1,$2,$3,$4,$5,true) RETURNING *`,
    [
      id,
      data.username.toLowerCase().trim(),
      data.passwordHash,
      data.workshopName.trim(),
      data.phone || ''
    ]
  );
  return rowToPartner(rows[0]);
}

async function getPartnerByUsername(username) {
  const key = (username || '').toLowerCase().trim();
  const { rows } = await pool.query(
    'SELECT * FROM partners WHERE username = $1', [key]
  );
  return rowToPartner(rows[0] || null);
}

async function getAllPartners() {
  const { rows } = await pool.query(
    'SELECT * FROM partners ORDER BY workshop_name'
  );
  return rows.map(rowToPartner);
}

async function togglePartnerActive(id) {
  const { rows } = await pool.query(
    `UPDATE partners SET active = NOT active WHERE id = $1 RETURNING *`,
    [parseInt(id)]
  );
  return rowToPartner(rows[0] || null);
}

async function updatePartnerPassword(id, passwordHash) {
  const { rows } = await pool.query(
    `UPDATE partners SET password_hash = $1 WHERE id = $2 RETURNING *`,
    [passwordHash, parseInt(id)]
  );
  return rowToPartner(rows[0] || null);
}

// ── Service History ───────────────────────────────────────────────────────────

const DEFAULT_SERVICE_ITEMS = [
  { en: 'ENGINE OIL',          el: 'ΛΑΔΙ ΜΗΧΑΝΗΣ' },
  { en: 'GEAR OIL',            el: 'ΛΑΔΙ ΣΥΜΠΛΕΚΤΗ' },
  { en: 'SPARK PLUG',          el: 'ΜΠΟΥΖΙ' },
  { en: 'SPARK PLUG CAP',      el: 'ΚΑΠΑΚΙ ΜΠΟΥΖΙ' },
  { en: 'CHAIN',               el: 'ΑΛΥΣΙΔΑ ΚΙΝΗΣΗΣ' },
  { en: 'DRIVE SPROCKET',      el: 'ΓΡΑΝΑΖΙ ΚΙΝΗΣΗΣ' },
  { en: 'REAR SPROCKET',       el: 'ΓΡΑΝΑΖΙ ΟΠΙΣΘΙΟΥ ΤΡΟΧΟΥ' },
  { en: 'CHECK VALVES',        el: 'ΕΛΕΓΧΟΣ ΔΙΑΚΕΝΩΝ ΒΑΛΒΙΔΩΝ' },
  { en: 'AIR FILTER',          el: 'ΦΙΛΤΡΟ ΑΕΡΟΣ' },
  { en: 'OIL FILTER',          el: 'ΦΙΛΤΡΟ ΛΑΔΙΟΥ' },
  { en: 'FRONT BRAKE PADS',    el: 'ΤΑΚΑΚΙΑ ΜΠΡΟΣΤΑ' },
  { en: 'REAR BRAKE PADS',     el: 'ΤΑΚΑΚΙΑ ΠΙΣΩ' },
  { en: 'BELT',                el: 'ΙΜΑΝΤΑΣ ΚΙΝΗΣΗΣ' },
  { en: 'ROLLERS',             el: 'ΜΠΙΛΙΕΣ ΦΥΓΟΚΕΝΤΡΙΚΟΥ' },
  { en: 'SLIDERS',             el: 'ΦΩΛΙΕΣ ΦΥΓΟΚΕΝΤΡΙΚΟΥ' },
  { en: 'CLUTCH',              el: 'ΣΥΜΠΛΕΚΤΗΣ' },
  { en: 'DRIVE FACE',          el: 'DRIVE FACE' },
  { en: 'MOVABLE DRIVE',       el: 'MOVABLE DRIVE' },
  { en: 'FTEROTI',             el: 'ΦΤΕΡΩΤΗ' },
  { en: 'VARIATOR',            el: 'ΒΑΡΙΑΤΟΡ' },
  { en: 'FRONT LAMP',          el: 'ΛΑΜΠΑ ΕΜΠΡΟΣΘΙΟΥ ΦΑΝΟΥ' },
  { en: 'REAR LAMP',           el: 'ΛΑΜΠΑ ΟΠΙΣΘΙΟΥ ΦΑΝΟΥ' },
  { en: 'FRONT TYRE',          el: 'ΕΛΑΣΤΙΚΟ ΜΠΡΟΣΤΑ' },
  { en: 'REAR TYRE',           el: 'ΕΛΑΣΤΙΚΟ ΠΙΣΩ' }
];

async function createServiceEntry(data) {
  const id = Date.now();
  const { rows } = await pool.query(
    `INSERT INTO service_history
       (id, reg_no, date, km, items, notes, partner_id, partner_name, logged_by_admin, booking_ref)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      id,
      (data.regNo || '').toString().toUpperCase().replace(/\s/g, ''),
      data.date || new Date().toISOString().split('T')[0],
      parseInt(data.km) || 0,
      JSON.stringify(Array.isArray(data.items) ? data.items : []),
      data.notes || '',
      data.partnerId   || null,
      data.partnerName || 'Motowarehouse',
      data.loggedByAdmin || false,
      data.bookingRef    || null
    ]
  );
  return rowToServiceEntry(rows[0]);
}

async function getServiceHistoryByPlate(regNo) {
  const key = (regNo || '').toString().toUpperCase().replace(/\s/g, '');
  const { rows } = await pool.query(
    `SELECT * FROM service_history WHERE reg_no = $1 ORDER BY date DESC, created_at DESC`,
    [key]
  );
  return rows.map(rowToServiceEntry);
}

const EDIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

async function updateServiceEntry(id, data) {
  const { rows } = await pool.query(
    'SELECT * FROM service_history WHERE id = $1', [parseInt(id)]
  );
  if (!rows.length) return { success: false, notFound: true };

  const entry = rowToServiceEntry(rows[0]);
  const age = Date.now() - new Date(entry.createdAt).getTime();
  if (age > EDIT_WINDOW_MS && !data.adminOverride) {
    return { success: false, locked: true };
  }

  const newKm    = parseInt(data.km) || entry.km;
  const newItems = Array.isArray(data.items) ? data.items : entry.items;
  const newNotes = data.notes !== undefined ? data.notes : entry.notes;

  const { rows: updated } = await pool.query(
    `UPDATE service_history
     SET km = $1, items = $2::jsonb, notes = $3, updated_at = NOW()
     WHERE id = $4 RETURNING *`,
    [newKm, JSON.stringify(newItems), newNotes, parseInt(id)]
  );
  return { success: true, entry: rowToServiceEntry(updated[0]) };
}

async function deleteServiceEntry(id, adminOverride) {
  const { rows } = await pool.query(
    'SELECT created_at FROM service_history WHERE id = $1', [parseInt(id)]
  );
  if (!rows.length) return { success: false, notFound: true };

  const age = Date.now() - new Date(rows[0].created_at).getTime();
  if (age > EDIT_WINDOW_MS && !adminOverride) {
    return { success: false, locked: true };
  }

  await pool.query('DELETE FROM service_history WHERE id = $1', [parseInt(id)]);
  return { success: true };
}

// ── Warranty History ──────────────────────────────────────────────────────────

async function createWarrantyClaim(data) {
  const id = Date.now();
  const { rows } = await pool.query(
    `INSERT INTO warranty_history
       (id, reg_no, frame_no, km, sale_date, symptom, priority,
        engine_disassembly, defect_agreed, courtesy_vehicle,
        notes, photos, media_types, logged_by, logged_by_admin,
        partner_id, partner_name, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,'open')
     RETURNING *`,
    [
      id,
      (data.regNo  || '').toString().toUpperCase().replace(/\s/g, ''),
      data.frameNo  || '',
      parseInt(data.km) || 0,
      data.saleDate || '',
      data.symptom  || '',
      data.priority || 'normal',
      !!data.engineDisassembly,
      !!data.defectAgreed,
      !!data.courtesyVehicle,
      data.notes || '',
      JSON.stringify(Array.isArray(data.photos)     ? data.photos     : []),
      JSON.stringify(Array.isArray(data.mediaTypes) ? data.mediaTypes : []),
      data.loggedBy      || 'Motowarehouse',
      data.loggedByAdmin || false,
      data.partnerId     || null,
      data.partnerName   || 'Motowarehouse'
    ]
  );
  return rowToWarranty(rows[0]);
}

async function getWarrantyByPlate(regNo) {
  const key = (regNo || '').toString().toUpperCase().replace(/\s/g, '');
  const { rows } = await pool.query(
    `SELECT * FROM warranty_history WHERE reg_no = $1 ORDER BY created_at DESC`,
    [key]
  );
  return rows.map(rowToWarranty);
}

async function getAllWarranties() {
  const { rows } = await pool.query(
    'SELECT * FROM warranty_history ORDER BY created_at DESC'
  );
  return rows.map(rowToWarranty);
}

async function updateWarrantyStatus(id, status, adminNotes) {
  const { rows } = await pool.query(
    `UPDATE warranty_history
     SET status = $1, admin_notes = COALESCE($2, admin_notes), updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [status, adminNotes !== undefined ? adminNotes : null, parseInt(id)]
  );
  return rowToWarranty(rows[0] || null);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  getSetting, setSetting,
  createBooking, getAllBookings, getBookingById,
  updateBookingStatus, rescheduleBooking, updateContactStatus,
  markReminderSent, getAcceptedBookingsDueForReminder, getBookedSlots,
  completeBooking, markNoShow,
  createBlock, getAllBlocks, deleteBlock,
  getHours, saveHours, DEFAULT_HOURS,
  importVehicles, getVehicleByPlate, getAllVehicles,
  createPartner, getPartnerByUsername, getAllPartners, togglePartnerActive, updatePartnerPassword,
  createServiceEntry, updateServiceEntry, deleteServiceEntry, getServiceHistoryByPlate, DEFAULT_SERVICE_ITEMS,
  createWarrantyClaim, getWarrantyByPlate, getAllWarranties, updateWarrantyStatus
};
