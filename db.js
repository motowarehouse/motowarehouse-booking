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

// ── Auto-init: create all tables on startup if they don't exist ───────────────
// This means the app is fully self-initialising on any fresh database.
// CREATE TABLE IF NOT EXISTS is safe to run repeatedly — it never touches existing data.

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value JSONB NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id             SERIAL PRIMARY KEY,
        ref            TEXT    UNIQUE NOT NULL,
        name           TEXT    NOT NULL,
        phone          TEXT    NOT NULL,
        email          TEXT,
        service_type   TEXT    NOT NULL,
        date           TEXT,
        time           TEXT,
        model          TEXT    NOT NULL,
        year           TEXT    NOT NULL,
        plate          TEXT    NOT NULL,
        km             TEXT,
        notes          TEXT,
        description    TEXT,
        mechanic       INTEGER DEFAULT 1,
        status         TEXT    NOT NULL DEFAULT 'pending',
        contact_status TEXT,
        reminder_sent  BOOLEAN DEFAULT FALSE,
        mechanic_notes TEXT,
        duration_mins  INTEGER,
        service_km     TEXT,
        service_reg_no TEXT,
        completed_at   TIMESTAMPTZ,
        updated_at     TIMESTAMPTZ DEFAULT NOW(),
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Safe migration for existing production tables — ADD COLUMN IF NOT EXISTS is idempotent
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS mechanic_notes TEXT`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS duration_mins INTEGER`);
    await client.query(`ALTER TABLE partners  ADD COLUMN IF NOT EXISTS email TEXT`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS mechanic_off_days (
        mechanic_id INTEGER NOT NULL,
        date        TEXT    NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (mechanic_id, date)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS blocks (
        id             SERIAL PRIMARY KEY,
        date           TEXT NOT NULL,
        start_time     TEXT NOT NULL,
        end_time       TEXT NOT NULL,
        reason         TEXT,
        customer_name  TEXT,
        customer_phone TEXT,
        vehicle_model  TEXT,
        notes          TEXT,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vehicles (
        reg_no       TEXT PRIMARY KEY,
        frame_no     TEXT,
        engine_no    TEXT,
        model        TEXT,
        manufacturer TEXT,
        description  TEXT,
        year         TEXT,
        status       TEXT DEFAULT 'active',
        updated_at   TIMESTAMPTZ DEFAULT NOW(),
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS partners (
        id            SERIAL PRIMARY KEY,
        username      TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        workshop_name TEXT NOT NULL,
        phone         TEXT,
        active        BOOLEAN DEFAULT TRUE,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS service_history (
        id             SERIAL PRIMARY KEY,
        reg_no         TEXT NOT NULL,
        date           TEXT NOT NULL,
        km             TEXT,
        items          JSONB DEFAULT '[]',
        notes          TEXT,
        partner_id     INTEGER,
        partner_name   TEXT,
        logged_by_admin BOOLEAN DEFAULT FALSE,
        booking_ref    TEXT,
        updated_at     TIMESTAMPTZ DEFAULT NOW(),
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Session store table (used by connect-pg-simple)
    await client.query(`
      CREATE TABLE IF NOT EXISTS session (
        sid    VARCHAR    NOT NULL COLLATE "default" PRIMARY KEY,
        sess   JSON       NOT NULL,
        expire TIMESTAMP  NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS warranty_claims (
        id                 SERIAL PRIMARY KEY,
        reg_no             TEXT NOT NULL,
        frame_no           TEXT,
        km                 TEXT,
        sale_date          TEXT,
        symptom            TEXT NOT NULL,
        priority           TEXT DEFAULT 'normal',
        engine_disassembly BOOLEAN DEFAULT FALSE,
        defect_agreed      BOOLEAN DEFAULT FALSE,
        courtesy_vehicle   BOOLEAN DEFAULT FALSE,
        notes              TEXT,
        photos             JSONB DEFAULT '[]',
        media_types        JSONB DEFAULT '[]',
        logged_by          TEXT,
        logged_by_admin    BOOLEAN DEFAULT FALSE,
        partner_id         INTEGER,
        partner_name       TEXT,
        status             TEXT DEFAULT 'open',
        admin_notes        TEXT,
        updated_at         TIMESTAMPTZ DEFAULT NOW(),
        created_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query('COMMIT');
    console.log('[DB] ✅ Database tables verified / created.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] ❌ Failed to initialise database tables:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

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
    mechanicNotes: r.mechanic_notes,
    durationMins:  r.duration_mins,
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
    email:        r.email || '',
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

const MECHANIC_COUNT = 2; // Update this if you hire more mechanics

// ── Service Durations (minutes) ────────────────────────────────────────────────
// Keys are UPPERCASE model names (matched case-insensitively).
// small = small service duration in minutes
// full  = full service duration in minutes (worst-case end of any range)

const SERVICE_DURATIONS = {
  // CFMOTO Motorcycles
  '125NK':                { small: 40, full: 180 },
  'DUAL 250':             { small: 40, full: 240 },
  '300NK':                { small: 40, full: 240 },
  '300SR':                { small: 40, full: 240 },
  '450NK':                { small: 40, full: 240 },
  '450SR':                { small: 40, full: 240 },
  '450MT':                { small: 40, full: 300 },
  '450CL-C':              { small: 40, full: 300 },
  '450CL-C BOBBER':       { small: 40, full: 300 },
  '675NK':                { small: 40, full: 300 },
  '675SR-R':              { small: 40, full: 300 },
  '700CL-X SPORT':        { small: 40, full: 300 },
  '700MT':                { small: 40, full: 300 },
  '800NK':                { small: 40, full: 240 },
  '800MT EXPLORE EDITION':{ small: 40, full: 300 },
  '800MT-X':              { small: 40, full: 300 },
  '1000MT-X':             { small: 40, full: 360 },
  // CFMOTO ATVs
  'CFORCE 110':           { small: 30, full: 240 },
  'CFORCE 450L':          { small: 40, full: 300 },
  'CFORCE 520L':          { small: 40, full: 360 },
  'CFORCE 625 TOURING':   { small: 40, full: 360 },
  'CFORCE 850 TOURING':   { small: 40, full: 360 },
  'CFORCE 1000 TOURING':  { small: 40, full: 360 },
  // CFMOTO Side-by-Side / UTV
  'UFORCE 600':           { small: 60, full: 360 },
  'U6 EV':                { small: 60, full: 360 },
  'U10 PRO':              { small: 60, full: 360 },
  'U10 PRO HIGHLAND':     { small: 60, full: 360 },
  'U10 XL PRO':           { small: 60, full: 360 },
  'ZFORCE 800 SPORT':     { small: 60, full: 360 },
  'ZFORCE 950 SPORT':     { small: 60, full: 360 },
  'ZFORCE 950 SPORT-4':   { small: 60, full: 360 },
  'Z10':                  { small: 60, full: 420 },
  'Z10-4':                { small: 60, full: 360 },
  // SYM Scooters / Motorcycles
  'MIO 50':               { small: 30, full: 120 },
  'SR 125 CBS':           { small: 30, full: 180 },
  'SR 125 ABS':           { small: 30, full: 180 },
  'JET 14 EVO 125':       { small: 30, full: 180 },
  'CARGO 125':            { small: 30, full: 180 },
  'ADX 125':              { small: 30, full: 180 },
  'JET X 125':            { small: 30, full: 180 },
  'VF125':                { small: 30, full: 240 },
  'VF185':                { small: 30, full: 240 },
  'SYMPHONY 200':         { small: 30, full: 180 },
  'ADX 300':              { small: 30, full: 240 },
  'JOYRIDE 300 TCS':      { small: 30, full: 240 },
  'ADXTG 400':            { small: 40, full: 240 },
  'MAXSYM TL 508':        { small: 40, full: 300 },
  'TTLBT':                { small: 40, full: 300 },
};

/**
 * Return service duration in minutes for a given model + serviceType.
 *
 * Matching order:
 *  1. Exact match (e.g. "675NK")
 *  2. Strip CFMOTO internal prefix "CF" and try again (e.g. "CF650NK-C" → "650NK-C" → no match → step 3)
 *  3. Displacement-based fallback — extract the first number from the model code and
 *     pick a reasonable duration based on engine size category.
 *     e.g. CF400-8F → 400cc → mid-size defaults.
 */
function getDurationMins(model, serviceType) {
  if (!model || serviceType === 'other') return 60;
  const key = model.trim().toUpperCase();

  // 1. Exact match
  let entry = SERVICE_DURATIONS[key];

  // 2. Strip "CF" prefix (CFMOTO internal codes: CF650NK-C, CF400-8F, CF800-NK …)
  if (!entry && key.startsWith('CF')) {
    const stripped = key.slice(2); // e.g. "650NK-C"
    // Try the stripped value and also without any trailing variant suffix (e.g. "-C", "-8F")
    entry = SERVICE_DURATIONS[stripped]
         || SERVICE_DURATIONS[stripped.replace(/-[^-]*$/, '')]; // remove last "-xxx"
  }

  // 3. Displacement-based fallback
  if (!entry) {
    const numMatch = key.match(/\d+/);
    const cc = numMatch ? parseInt(numMatch[0]) : 0;
    if (serviceType === 'full-service') {
      if (cc >= 900)  return 420; // Large UTVs / big bikes (Z10, 1000MT-X)
      if (cc >= 700)  return 360; // 700–900cc (800NK, UTVs)
      if (cc >= 400)  return 300; // 400–700cc (450–675 range)
      if (cc >= 200)  return 240; // 200–400cc
      if (cc >= 100)  return 180; // 100–200cc (125NK class)
      return 240;                  // unknown — safe 4-hr default
    }
    // Small service displacement fallback
    if (cc >= 600)  return 60;  // UTVs / large bikes
    if (cc >= 100)  return 40;  // standard motorcycle/scooter
    return 30;                   // sub-100cc
  }

  return serviceType === 'full-service' ? entry.full : entry.small;
}

async function createBooking(data) {
  // Calculate service duration for this model + service type
  const durationMins = getDurationMins(data.model, data.serviceType);

  // Assign mechanic: prefer the one who is actually free at the requested
  // time for the full duration. Tiebreak by fewest bookings today.
  let mechanic = 1;
  if (data.date && data.time) {
    const { rows: appts } = await pool.query(
      `SELECT time, mechanic, COALESCE(duration_mins, 60) AS duration_mins
       FROM bookings WHERE date = $1 AND status IN ('pending','accepted')`,
      [data.date]
    );

    // Build per-mechanic busy sets
    const mechBusy = {};
    const dayCounts = {};
    for (let m = 1; m <= MECHANIC_COUNT; m++) {
      mechBusy[m] = buildBusySet(appts, m);
      dayCounts[m] = 0;
    }
    appts.forEach(a => { dayCounts[parseInt(a.mechanic) || 1]++; });

    // Sort mechanics: fewest bookings first (so ties favour less-busy)
    const sorted = Object.keys(dayCounts).map(Number)
      .sort((a, b) => dayCounts[a] - dayCounts[b]);

    const newSlotCount = Math.ceil(durationMins / 30);
    let assigned = sorted[0]; // fallback
    for (const m of sorted) {
      let free = true;
      for (let i = 0; i < newSlotCount; i++) {
        if (mechBusy[m].has(addMins(data.time, i * 30))) { free = false; break; }
      }
      if (free) { assigned = m; break; }
    }
    mechanic = assigned;
  } else if (data.date) {
    // 'other' type — no time yet; just pick the mechanic with fewer bookings
    const { rows: dayCounts } = await pool.query(
      `SELECT mechanic, COUNT(*) AS cnt FROM bookings
       WHERE date = $1 AND status IN ('pending','accepted')
       GROUP BY mechanic`,
      [data.date]
    );
    const counts = {};
    for (let m = 1; m <= MECHANIC_COUNT; m++) counts[m] = 0;
    dayCounts.forEach(r => { counts[parseInt(r.mechanic)] = parseInt(r.cnt); });
    mechanic = Object.entries(counts).sort((a, b) => a[1] - b[1])[0][0];
  }

  const { rows } = await pool.query(
    `INSERT INTO bookings
       (name, phone, email, service_type, date, time, model, year, plate, km,
        notes, description, mechanic, duration_mins, status, contact_status, reminder_sent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15,false)
     RETURNING *`,
    [
      data.name, data.phone, data.email || '', data.serviceType,
      data.date || '', data.time || '',
      data.model, data.year, data.plate, data.km,
      data.notes || '', data.description || '',
      mechanic, durationMins,
      data.contactStatus || null
    ]
  );
  return rowToBooking(rows[0]);
}

async function getAllBookings({ fromDate } = {}) {
  let query, params;
  if (fromDate) {
    // Return bookings within range OR any active booking (pending/accepted) regardless of age
    query = `
      SELECT * FROM bookings
      WHERE created_at >= $1
         OR status IN ('pending', 'accepted')
      ORDER BY created_at DESC
    `;
    params = [fromDate];
  } else {
    query = 'SELECT * FROM bookings ORDER BY created_at DESC';
    params = [];
  }
  const { rows } = await pool.query(query, params);
  return rows.map(rowToBooking);
}

async function getBookingById(id) {
  const { rows } = await pool.query(
    'SELECT * FROM bookings WHERE id = $1', [parseInt(id)]
  );
  return rowToBooking(rows[0] || null);
}

async function getBookingByRef(ref) {
  const { rows } = await pool.query(
    'SELECT * FROM bookings WHERE ref = $1',
    [(ref || '').toUpperCase().trim()]
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

// ── DST-aware UTC conversion for Cyprus (Europe/Nicosia) ─────────────────────
// Converts a local Cyprus date+time string to a UTC Date object.
// Handles the switch between EET (UTC+2, winter) and EEST (UTC+3, summer).
function appointmentToUTC(dateStr, timeStr) {
  const wantH = parseInt(timeStr.split(':')[0], 10);
  // Start with EET (+02:00) as a guess
  const guess = new Date(`${dateStr}T${timeStr}:00+02:00`);
  // Find what Cyprus local hour this UTC time actually corresponds to
  const cyprusH = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Nicosia', hour: 'numeric', hour12: false
    }).format(guess),
    10
  );
  // If Cyprus local hour differs from the wanted hour, Cyprus is at EEST (+03:00)
  return cyprusH === wantH ? guess : new Date(`${dateStr}T${timeStr}:00+03:00`);
}

async function getAcceptedBookingsDueForReminder() {
  const { rows } = await pool.query(
    `SELECT * FROM bookings WHERE status = 'accepted' AND reminder_sent = false`
  );
  const now = new Date();
  const windowStart     = new Date(now.getTime() + 90 * 60 * 1000);
  const twoHoursFromNow = new Date(now.getTime() + 2  * 60 * 60 * 1000);
  return rows.map(rowToBooking).filter(b => {
    if (!b.date || !b.time) return false;
    const apptTime = appointmentToUTC(b.date, b.time);
    return apptTime >= windowStart && apptTime <= twoHoursFromNow;
  });
}

// ── Check for existing active booking by plate ────────────────────────────────
async function getActiveBookingByPlate(plate) {
  const key = (plate || '').toUpperCase().replace(/\s/g, '');
  const { rows } = await pool.query(
    `SELECT * FROM bookings
     WHERE UPPER(REPLACE(plate,' ','')) = $1
       AND status IN ('pending','accepted')
     LIMIT 1`,
    [key]
  );
  return rows.length ? rowToBooking(rows[0]) : null;
}

// ── Mechanic off-day management ───────────────────────────────────────────────
async function getMechanicOffDays(date) {
  const { rows } = await pool.query(
    'SELECT mechanic_id FROM mechanic_off_days WHERE date = $1', [date]
  );
  return rows.map(r => parseInt(r.mechanic_id));
}

async function addMechanicOffDay(mechanicId, date) {
  await pool.query(
    `INSERT INTO mechanic_off_days (mechanic_id, date)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [parseInt(mechanicId), date]
  );
}

async function removeMechanicOffDay(mechanicId, date) {
  await pool.query(
    'DELETE FROM mechanic_off_days WHERE mechanic_id = $1 AND date = $2',
    [parseInt(mechanicId), date]
  );
}

// Helper: convert "HH:MM" + offset in minutes → "HH:MM"
function addMins(time, mins) {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
}

// Helper: build a Set of busy slot strings for one mechanic given their bookings
function buildBusySet(appts, mechanicId) {
  const busy = new Set();
  appts
    .filter(a => parseInt(a.mechanic) === mechanicId)
    .forEach(a => {
      const dur = parseInt(a.duration_mins) || 60;
      const slots = Math.ceil(dur / 30);
      for (let i = 0; i < slots; i++) {
        busy.add(addMins(a.time, i * 30));
      }
    });
  return busy;
}

/**
 * Returns the list of starting slots that are NOT available on `date`
 * for a new booking of `newDurationMins` minutes.
 *
 * A slot is unavailable if EVERY mechanic is occupied for at least one
 * of the slots that the new job would need (start through start+duration-1).
 * Manual blocks always occupy all mechanics.
 */
async function getBookedSlots(date, newDurationMins = 60) {
  // Current bookings with their durations
  const { rows: appts } = await pool.query(
    `SELECT time, mechanic, COALESCE(duration_mins, 60) AS duration_mins
     FROM bookings WHERE date = $1 AND status IN ('pending','accepted')`,
    [date]
  );

  // Mechanics who are off this day — treat as fully booked
  const offMechanics = await getMechanicOffDays(date);

  // Build all possible 30-min slot keys for a full working day (06:00–20:00)
  function fullDaySlots() {
    const s = new Set();
    for (let m = 6 * 60; m < 20 * 60; m += 30) {
      s.add(`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`);
    }
    return s;
  }

  // Per-mechanic busy-slot sets
  const mechBusy = {};
  for (let m = 1; m <= MECHANIC_COUNT; m++) {
    mechBusy[m] = offMechanics.includes(m) ? fullDaySlots() : buildBusySet(appts, m);
  }

  // Manual blocks (block every mechanic for those slots)
  const { rows: blks } = await pool.query(
    'SELECT start_time, end_time FROM blocks WHERE date = $1', [date]
  );
  const blockSet = new Set();
  blks.forEach(bl => {
    let [sh, sm] = bl.start_time.split(':').map(Number);
    const [eh, em] = bl.end_time.split(':').map(Number);
    while (sh * 60 + sm < eh * 60 + em) {
      const s = `${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`;
      blockSet.add(s);
      sm += 30;
      if (sm >= 60) { sh++; sm -= 60; }
    }
  });

  // Determine unavailable starting slots:
  // A starting slot S is unavailable when no mechanic is free for ALL slots
  // from S through S + ceil(newDurationMins/30) - 1.
  const newSlotCount = Math.ceil(newDurationMins / 30);
  const unavailable = new Set(blockSet);

  // Scan every possible 30-min slot in the working day (06:00–20:00)
  for (let totalMins = 6 * 60; totalMins < 20 * 60; totalMins += 30) {
    const startSlot = `${String(Math.floor(totalMins / 60)).padStart(2,'0')}:${String(totalMins % 60).padStart(2,'0')}`;
    if (unavailable.has(startSlot)) continue; // manual block already covers it

    let anyMechFree = false;
    for (let m = 1; m <= MECHANIC_COUNT; m++) {
      let free = true;
      for (let i = 0; i < newSlotCount; i++) {
        const chk = addMins(startSlot, i * 30);
        if (mechBusy[m].has(chk) || blockSet.has(chk)) { free = false; break; }
      }
      if (free) { anyMechFree = true; break; }
    }
    if (!anyMechFree) unavailable.add(startSlot);
  }

  return [...unavailable];
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
        new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Nicosia' })).toISOString().split('T')[0],
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
  0: { closed: true,  ranges: [] },                                       // Sunday
  1: { closed: false, ranges: [['08:30','13:00'],['14:00','17:30']] },    // Monday
  2: { closed: false, ranges: [['08:30','13:00'],['14:00','17:30']] },    // Tuesday
  3: { closed: false, ranges: [['08:30','13:00']] },                       // Wednesday (morning only)
  4: { closed: false, ranges: [['08:30','13:00'],['14:00','17:30']] },    // Thursday
  5: { closed: false, ranges: [['08:30','13:00'],['14:00','17:30']] },    // Friday
  6: { closed: false, ranges: [['09:00','13:00']] }                        // Saturday
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
    `INSERT INTO partners (id, username, password_hash, workshop_name, phone, email, active)
     VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING *`,
    [
      id,
      data.username.toLowerCase().trim(),
      data.passwordHash,
      data.workshopName.trim(),
      data.phone || '',
      data.email || ''
    ]
  );
  return rowToPartner(rows[0]);
}

async function getPartnerById(id) {
  const { rows } = await pool.query(
    'SELECT * FROM partners WHERE id = $1', [parseInt(id)]
  );
  return rowToPartner(rows[0] || null);
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
      new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Nicosia' })).toISOString().split('T')[0],
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

async function updateServiceEntry(id, data) {
  const { rows } = await pool.query(
    'SELECT * FROM service_history WHERE id = $1', [parseInt(id)]
  );
  if (!rows.length) return { success: false, notFound: true };

  const entry = rowToServiceEntry(rows[0]);
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

// Delete is admin-only (enforced at server level); no time restriction.
async function deleteServiceEntry(id) {
  const { rows } = await pool.query(
    'SELECT id FROM service_history WHERE id = $1', [parseInt(id)]
  );
  if (!rows.length) return { success: false, notFound: true };
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

// ── Mechanic Notes ────────────────────────────────────────────────────────────

async function updateMechanicNotes(id, notes) {
  const { rows } = await pool.query(
    `UPDATE bookings SET mechanic_notes = $1, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [notes || null, parseInt(id)]
  );
  return rowToBooking(rows[0] || null);
}

// ── Customer Self-Cancel ──────────────────────────────────────────────────────

async function cancelBookingByCustomer(ref, phone) {
  // Find active booking by reference
  const { rows } = await pool.query(
    `SELECT * FROM bookings WHERE ref = $1 AND status IN ('pending','accepted')`,
    [ref.toUpperCase().trim()]
  );
  if (!rows.length) return { error: 'not-found' };

  const booking = rowToBooking(rows[0]);

  // Verify phone matches (strip non-digits for comparison)
  const normalize = p => (p || '').replace(/\D/g, '');
  const storedDigits  = normalize(booking.phone);
  const enteredDigits = normalize(phone);
  // Accept if the stored phone ends with the entered digits (handles +357 vs bare number)
  if (!storedDigits.endsWith(enteredDigits) && !enteredDigits.endsWith(storedDigits)) {
    return { error: 'phone-mismatch' };
  }

  const { rows: updated } = await pool.query(
    `UPDATE bookings
     SET status = 'cancelled', contact_status = 'self-cancelled', updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [booking.id]
  );
  return { booking: rowToBooking(updated[0]) };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  getSetting, setSetting,
  createBooking, getAllBookings, getBookingById, getBookingByRef,
  updateBookingStatus, rescheduleBooking, updateContactStatus,
  markReminderSent, getAcceptedBookingsDueForReminder, getBookedSlots,
  getActiveBookingByPlate,
  completeBooking, markNoShow,
  createBlock, getAllBlocks, deleteBlock,
  getHours, saveHours, DEFAULT_HOURS,
  importVehicles, getVehicleByPlate, getAllVehicles,
  createPartner, getPartnerByUsername, getPartnerById, getAllPartners, togglePartnerActive, updatePartnerPassword,
  getMechanicOffDays, addMechanicOffDay, removeMechanicOffDay,
  createServiceEntry, updateServiceEntry, deleteServiceEntry, getServiceHistoryByPlate, DEFAULT_SERVICE_ITEMS,
  createWarrantyClaim, getWarrantyByPlate, getAllWarranties, updateWarrantyStatus,
  updateMechanicNotes,
  cancelBookingByCustomer,
  getDurationMins,
  initDB
};
