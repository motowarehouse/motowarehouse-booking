const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'bookings.json');

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = { bookings: [], blocks: [], hours: null, lastId: 0 };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  // Migrate older DBs that don't have blocks/hours yet
  if (!db.blocks) db.blocks = [];
  if (!db.hours) db.hours = null;
  return db;
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function generateRef(id) {
  return 'MW' + String(id).padStart(5, '0');
}

// ── Bookings ─────────────────────────────────────────────────────────────────

function createBooking(data) {
  const db = readDB();
  db.lastId += 1;
  const booking = {
    id: db.lastId,
    ref: generateRef(db.lastId),
    ...data,
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

// Returns all booked + manually blocked 30-min slots for a given date
function getBookedSlots(date) {
  const db = readDB();

  // Online bookings (pending or accepted)
  const bookingSlots = db.bookings
    .filter(b => b.date === date && (b.status === 'pending' || b.status === 'accepted'))
    .map(b => b.time);

  // Manual blocks — expand time ranges into individual 30-min slots
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
// Stored as an object keyed by day index (0=Sun … 6=Sat)
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

module.exports = {
  createBooking, getAllBookings, getBookingById,
  updateBookingStatus, markReminderSent,
  getAcceptedBookingsDueForReminder, getBookedSlots,
  createBlock, getAllBlocks, deleteBlock,
  getHours, saveHours, DEFAULT_HOURS
};
