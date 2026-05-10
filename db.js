const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'bookings.json');

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = { bookings: [], lastId: 0 };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function generateRef(id) {
  return 'MW' + String(id).padStart(5, '0');
}

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

function getBookedSlots(date) {
  const db = readDB();
  return db.bookings
    .filter(b => b.date === date && (b.status === 'pending' || b.status === 'accepted'))
    .map(b => b.time);
}

module.exports = {
  createBooking, getAllBookings, getBookingById,
  updateBookingStatus, markReminderSent,
  getAcceptedBookingsDueForReminder, getBookedSlots
};
