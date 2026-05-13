const fs = require('fs');
const path = require('path');

// Use Railway persistent volume if available, otherwise fall back to local (for development)
const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'bookings.json')
  : path.join(__dirname, 'bookings.json');

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = { bookings: [], blocks: [], hours: null, lastId: 0, vehicles: [], partners: [], serviceHistory: [], warrantyHistory: [], settings: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  // Migrate older DBs
  if (!db.blocks) db.blocks = [];
  if (!db.hours) db.hours = null;
  if (!db.vehicles) db.vehicles = [];
  if (!db.partners) db.partners = [];
  if (!db.serviceHistory) db.serviceHistory = [];
  if (!db.warrantyHistory) db.warrantyHistory = [];
  if (!db.settings) db.settings = {};
  return db;
}

// ── Settings ──────────────────────────────────────────────────────────────────

function getSetting(key) {
  return readDB().settings[key] ?? null;
}

function setSetting(key, value) {
  const db = readDB();
  db.settings[key] = value;
  writeDB(db);
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function generateRef(id) {
  return 'MW' + String(id).padStart(5, '0');
}

// ── Bookings ─────────────────────────────────────────────────────────────────

const MECHANIC_COUNT = 2;

function createBooking(data) {
  const db = readDB();

  // Auto-assign to whichever mechanic is free at this slot
  const existing = db.bookings.filter(
    b => b.date === data.date && b.time === data.time &&
    (b.status === 'pending' || b.status === 'accepted')
  );
  const mechanic = existing.some(b => b.mechanic === 1) ? 2 : 1;

  db.lastId += 1;
  const booking = {
    id: db.lastId,
    ref: generateRef(db.lastId),
    ...data,
    mechanic,
    status: 'pending',
    createdAt: new Date().toISOString(),
    reminderSent: false
  };
  db.bookings.push(booking);
  writeDB(db);
  return booking;
}

function getAllBookings() {
  return readDB().bookings;
}

function getBookingById(id) {
  return readDB().bookings.find(b => b.id === parseInt(id));
}

function updateBookingStatus(id, status) {
  const db = readDB();
  const idx = db.bookings.findIndex(b => b.id === parseInt(id));
  if (idx === -1) return null;
  db.bookings[idx].status = status;
  db.bookings[idx].updatedAt = new Date().toISOString();
  if (status === 'cancelled') {
    db.bookings[idx].contactStatus = 'needs-contact';
  }
  writeDB(db);
  return db.bookings[idx];
}

function rescheduleBooking(id, newDate, newTime) {
  const db = readDB();
  const idx = db.bookings.findIndex(b => b.id === parseInt(id));
  if (idx === -1) return null;
  db.bookings[idx].date = newDate;
  db.bookings[idx].time = newTime;
  db.bookings[idx].status = 'accepted';
  db.bookings[idx].contactStatus = null;
  db.bookings[idx].reminderSent = false;
  db.bookings[idx].updatedAt = new Date().toISOString();
  writeDB(db);
  return db.bookings[idx];
}

function updateContactStatus(id, contactStatus) {
  const db = readDB();
  const idx = db.bookings.findIndex(b => b.id === parseInt(id));
  if (idx === -1) return null;
  db.bookings[idx].contactStatus = contactStatus;
  db.bookings[idx].updatedAt = new Date().toISOString();
  writeDB(db);
  return db.bookings[idx];
}

function markReminderSent(id) {
  const db = readDB();
  const idx = db.bookings.findIndex(b => b.id === parseInt(id));
  if (idx !== -1) {
    db.bookings[idx].reminderSent = true;
    writeDB(db);
  }
}

function getAcceptedBookingsDueForReminder() {
  const db = readDB();
  const now = new Date();
  const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const windowStart = new Date(now.getTime() + 90 * 60 * 1000);
  return db.bookings.filter(b => {
    if (b.status !== 'accepted' || b.reminderSent) return false;
    const apptTime = new Date(b.date + 'T' + b.time);
    return apptTime >= windowStart && apptTime <= twoHoursFromNow;
  });
}

// Returns all fully-booked + manually blocked 30-min slots for a given date
// A slot is only fully booked when all mechanics (MECHANIC_COUNT) are taken
function getBookedSlots(date) {
  const db = readDB();

  // Count active bookings per slot
  const slotCounts = {};
  db.bookings
    .filter(b => b.date === date && (b.status === 'pending' || b.status === 'accepted'))
    .forEach(b => { slotCounts[b.time] = (slotCounts[b.time] || 0) + 1; });

  // Only mark slot as unavailable when all mechanics are booked
  const bookingSlots = Object.keys(slotCounts).filter(s => slotCounts[s] >= MECHANIC_COUNT);

  // Manual blocks always block the full slot (both mechanics)
  const blockSlots = [];
  (db.blocks || [])
    .filter(bl => bl.date === date)
    .forEach(bl => {
      let [sh, sm] = bl.startTime.split(':').map(Number);
      const [eh, em] = bl.endTime.split(':').map(Number);
      while (sh * 60 + sm < eh * 60 + em) {
        blockSlots.push(`${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`);
        sm += 30;
        if (sm >= 60) { sh++; sm -= 60; }
      }
    });

  return [...new Set([...bookingSlots, ...blockSlots])];
}

// ── Manual Blocks ─────────────────────────────────────────────────────────────

function createBlock(data) {
  const db = readDB();
  const block = {
    id: Date.now(),
    date: data.date,
    startTime: data.startTime,
    endTime: data.endTime,
    reason: data.reason || '',
    customerName: data.customerName || '',
    customerPhone: data.customerPhone || '',
    vehicleModel: data.vehicleModel || '',
    notes: data.notes || '',
    createdAt: new Date().toISOString()
  };
  db.blocks.push(block);
  writeDB(db);
  return block;
}

function getAllBlocks() {
  return readDB().blocks || [];
}

function deleteBlock(id) {
  const db = readDB();
  const idx = db.blocks.findIndex(b => b.id === parseInt(id));
  if (idx === -1) return false;
  db.blocks.splice(idx, 1);
  writeDB(db);
  return true;
}

// ── Opening Hours ─────────────────────────────────────────────────────────────
// Stored as an object keyed by day index (0=Sun ... 6=Sat)
// Each day: { closed: bool, ranges: [['HH:MM','HH:MM'], ...] }

const DEFAULT_HOURS = {
  0: { closed: true,  ranges: [] },                                   // Sunday
  1: { closed: false, ranges: [['08:30','12:30'],['14:00','17:00']] }, // Monday
  2: { closed: false, ranges: [['08:30','12:30'],['14:00','17:00']] }, // Tuesday
  3: { closed: false, ranges: [['08:30','12:30']] },                   // Wednesday
  4: { closed: false, ranges: [['08:30','12:30'],['14:00','17:00']] }, // Thursday
  5: { closed: false, ranges: [['08:30','12:30'],['14:00','17:00']] }, // Friday
  6: { closed: false, ranges: [['09:00','12:30']] }                    // Saturday
};

function getHours() {
  const db = readDB();
  return db.hours || DEFAULT_HOURS;
}

function saveHours(hours) {
  const db = readDB();
  db.hours = hours;
  writeDB(db);
}

// ── Vehicles ──────────────────────────────────────────────────────────────────

function importVehicles(rows) {
  // rows: array of { regNo, frameNo, engineNo, model, manufacturer, description, year }
  // Primary key: regNo (normalised). Fallback for unregistered/stock units: frameNo (stored as "FN:<frameNo>").
  // This means a vehicle with no plate but a frame number is kept as a stock unit and can be
  // updated to a registered vehicle later by re-importing with the reg number filled in.
  const db = readDB();
  let added = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    const rawReg   = (row.regNo   || '').toString().toUpperCase().replace(/\s/g, '');
    const rawFrame = (row.frameNo || '').toString().trim().toUpperCase().replace(/\s/g, '');

    // Determine the lookup key
    let key;
    let isStock = false;
    if (rawReg) {
      key = rawReg;
    } else if (rawFrame) {
      key = 'FN:' + rawFrame;   // prefix distinguishes from real plates
      isStock = true;
    } else {
      skipped++;
      continue; // nothing to identify this row by
    }

    const idx = db.vehicles.findIndex(v => v.regNo === key);
    const record = {
      regNo:        key,
      frameNo:      (row.frameNo || '').toString().trim(),
      engineNo:     (row.engineNo || '').toString().trim(),
      model:        (row.model || '').toString().trim(),
      manufacturer: (row.manufacturer || '').toString().trim(),
      description:  (row.description || '').toString().trim(),
      year:         (row.year || '').toString().trim(),
      status:       isStock ? 'stock' : 'registered',
      updatedAt:    new Date().toISOString()
    };
    if (idx === -1) {
      record.createdAt = new Date().toISOString();
      db.vehicles.push(record);
      added++;
    } else {
      db.vehicles[idx] = { ...db.vehicles[idx], ...record };
      updated++;
    }
  }
  writeDB(db);
  return { added, updated, skipped, total: db.vehicles.length };
}

function getVehicleByPlate(regNo) {
  const key = (regNo || '').toString().toUpperCase().replace(/\s/g, '');
  return readDB().vehicles.find(v => v.regNo === key) || null;
}

function getAllVehicles() {
  return readDB().vehicles;
}

// ── Partners ──────────────────────────────────────────────────────────────────

function createPartner(data) {
  const db = readDB();
  const partner = {
    id: Date.now(),
    username:     data.username.toLowerCase().trim(),
    passwordHash: data.passwordHash,
    workshopName: data.workshopName.trim(),
    phone:        data.phone || '',
    active:       true,
    createdAt:    new Date().toISOString()
  };
  db.partners.push(partner);
  writeDB(db);
  return partner;
}

function getPartnerByUsername(username) {
  const key = (username || '').toLowerCase().trim();
  return readDB().partners.find(p => p.username === key) || null;
}

function getAllPartners() {
  return readDB().partners;
}

function togglePartnerActive(id) {
  const db = readDB();
  const idx = db.partners.findIndex(p => p.id === parseInt(id));
  if (idx === -1) return null;
  db.partners[idx].active = !db.partners[idx].active;
  writeDB(db);
  return db.partners[idx];
}

// ── Service History ───────────────────────────────────────────────────────────

// Official 24-item service checklist (bilingual GR/EN)
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

function createServiceEntry(data) {
  // data: { regNo, km, items[], notes, partnerId, partnerName, loggedByAdmin }
  const db = readDB();
  const entry = {
    id:           Date.now(),
    regNo:        (data.regNo || '').toString().toUpperCase().replace(/\s/g, ''),
    date:         data.date || new Date().toISOString().split('T')[0],
    km:           parseInt(data.km) || 0,
    items:        Array.isArray(data.items) ? data.items : [],
    notes:        data.notes || '',
    partnerId:    data.partnerId || null,
    partnerName:  data.partnerName || 'Motowarehouse',
    loggedByAdmin: data.loggedByAdmin || false,
    createdAt:    new Date().toISOString()
  };
  db.serviceHistory.push(entry);
  writeDB(db);
  return entry;
}

function getServiceHistoryByPlate(regNo) {
  const key = (regNo || '').toString().toUpperCase().replace(/\s/g, '');
  return readDB().serviceHistory
    .filter(e => e.regNo === key)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

const EDIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function updateServiceEntry(id, data) {
  // Returns { success, locked, entry }
  const db = readDB();
  const idx = db.serviceHistory.findIndex(e => e.id === parseInt(id));
  if (idx === -1) return { success: false, notFound: true };
  const entry = db.serviceHistory[idx];
  const age = Date.now() - new Date(entry.createdAt).getTime();
  if (age > EDIT_WINDOW_MS && !data.adminOverride) return { success: false, locked: true };
  db.serviceHistory[idx] = {
    ...entry,
    km:        parseInt(data.km)    || entry.km,
    items:     Array.isArray(data.items) ? data.items : entry.items,
    notes:     data.notes !== undefined ? data.notes : entry.notes,
    updatedAt: new Date().toISOString()
  };
  writeDB(db);
  return { success: true, entry: db.serviceHistory[idx] };
}

function deleteServiceEntry(id, adminOverride) {
  const db = readDB();
  const idx = db.serviceHistory.findIndex(e => e.id === parseInt(id));
  if (idx === -1) return { success: false, notFound: true };
  const entry = db.serviceHistory[idx];
  const age = Date.now() - new Date(entry.createdAt).getTime();
  if (age > EDIT_WINDOW_MS && !adminOverride) return { success: false, locked: true };
  db.serviceHistory.splice(idx, 1);
  writeDB(db);
  return { success: true };
}

// ── Warranty History ──────────────────────────────────────────────────────────

function createWarrantyClaim(data) {
  const db = readDB();
  const claim = {
    id:               Date.now(),
    regNo:            (data.regNo  || '').toString().toUpperCase().replace(/\s/g, ''),
    frameNo:          data.frameNo  || '',
    km:               parseInt(data.km) || 0,
    saleDate:         data.saleDate || '',
    symptom:          data.symptom  || '',
    priority:         data.priority || 'normal',
    engineDisassembly: !!data.engineDisassembly,
    defectAgreed:     !!data.defectAgreed,
    courtesyVehicle:  !!data.courtesyVehicle,
    notes:            data.notes   || '',
    photos:           Array.isArray(data.photos)     ? data.photos     : [],
    mediaTypes:       Array.isArray(data.mediaTypes) ? data.mediaTypes : [],
    loggedBy:         data.loggedBy   || 'Motowarehouse',
    loggedByAdmin:    data.loggedByAdmin || false,
    status:           'open',
    createdAt:        new Date().toISOString()
  };
  db.warrantyHistory.push(claim);
  writeDB(db);
  return claim;
}

function getWarrantyByPlate(regNo) {
  const key = (regNo || '').toString().toUpperCase().replace(/\s/g, '');
  return readDB().warrantyHistory
    .filter(e => e.regNo === key)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getAllWarranties() {
  return readDB().warrantyHistory
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function updateWarrantyStatus(id, status, adminNotes) {
  const db = readDB();
  const idx = db.warrantyHistory.findIndex(e => e.id === parseInt(id));
  if (idx === -1) return null;
  db.warrantyHistory[idx].status = status;
  db.warrantyHistory[idx].updatedAt = new Date().toISOString();
  if (adminNotes !== undefined) db.warrantyHistory[idx].adminNotes = adminNotes;
  writeDB(db);
  return db.warrantyHistory[idx];
}

// ── Complete / No-Show ────────────────────────────────────────────────────────

function completeBooking(id, serviceData) {
  // Marks booking as 'completed' and writes a service history entry in one atomic write.
  const db = readDB();
  const idx = db.bookings.findIndex(b => b.id === parseInt(id));
  if (idx === -1) return null;

  const booking = db.bookings[idx];
  const regNo = (serviceData.regNo || booking.plate || '').toString().toUpperCase().replace(/\s/g, '');

  // Update booking
  booking.status       = 'completed';
  booking.completedAt  = new Date().toISOString();
  booking.updatedAt    = new Date().toISOString();
  booking.serviceKm    = parseInt(serviceData.km) || 0;
  booking.serviceRegNo = regNo; // may differ from original plate if admin corrected it

  // Build service history entry
  const entry = {
    id:            Date.now(),
    regNo:         regNo,
    date:          serviceData.date || booking.date,
    km:            parseInt(serviceData.km) || 0,
    items:         Array.isArray(serviceData.items) ? serviceData.items : [],
    notes:         serviceData.notes || '',
    partnerId:     null,
    partnerName:   'Motowarehouse',
    loggedByAdmin: true,
    bookingRef:    booking.ref,
    createdAt:     new Date().toISOString()
  };

  db.serviceHistory.push(entry);
  writeDB(db);
  return { booking: db.bookings[idx], serviceEntry: entry };
}

function markNoShow(id) {
  const db = readDB();
  const idx = db.bookings.findIndex(b => b.id === parseInt(id));
  if (idx === -1) return null;
  db.bookings[idx].status    = 'no-show';
  db.bookings[idx].updatedAt = new Date().toISOString();
  writeDB(db);
  return db.bookings[idx];
}

function updatePartnerPassword(id, passwordHash) {
  const db = readDB();
  const idx = db.partners.findIndex(p => p.id === parseInt(id));
  if (idx === -1) return null;
  db.partners[idx].passwordHash = passwordHash;
  writeDB(db);
  return db.partners[idx];
}

module.exports = {
  getSetting, setSetting,
  createBooking, getAllBookings, getBookingById,
  updateBookingStatus, rescheduleBooking, updateContactStatus,
  markReminderSent, getAcceptedBookingsDueForReminder, getBookedSlots,
  createBlock, getAllBlocks, deleteBlock,
  getHours, saveHours, DEFAULT_HOURS,
  importVehicles, getVehicleByPlate, getAllVehicles,
  createPartner, getPartnerByUsername, getAllPartners, togglePartnerActive, updatePartnerPassword,
  createServiceEntry, updateServiceEntry, deleteServiceEntry, getServiceHistoryByPlate, DEFAULT_SERVICE_ITEMS,
  completeBooking, markNoShow,
  createWarrantyClaim, getWarrantyByPlate, getAllWarranties, updateWarrantyStatus
};
