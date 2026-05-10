require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');
const emailService = require('./emailService');
const smsService = require('./smsService');
const { startReminderCron } = require('./reminderCron');

const app = express();
const PORT = process.env.PORT || 3001;

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'mw-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// --- Auth middleware ---
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ error: 'Unauthorised' });
}

// ==================== PUBLIC API ====================

// Get available time slots for a date
app.get('/api/slots', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });

  const d = new Date(date + 'T12:00:00');
  const day = d.getDay(); // 0=Sun, 6=Sat

  // Define working hours per day
  let slots = [];
  if (day === 0) { // Sunday - closed
    return res.json({ slots: [], closed: true });
  }

  // Generate half-hourly slots based on opening hours
  let ranges = [];
  if (day === 3) { // Wednesday - morning only
    ranges = [['08:30', '12:30']];
  } else if (day === 6) { // Saturday
    ranges = [['09:00', '12:30']];
  } else { // Mon Tue Thu Fri
    ranges = [['08:30', '12:30'], ['14:00', '17:00']];
  }

  for (const [start, end] of ranges) {
    let [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    while (sh * 60 + sm < eh * 60 + em) {
      slots.push(`${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`);
      sm += 30;
      if (sm >= 60) { sh++; sm -= 60; }
    }
  }

  const booked = db.getBookedSlots(date);
  const available = slots.filter(s => !booked.includes(s));
  res.json({ slots: available, booked });
});

// Submit a new booking
app.post('/api/book', async (req, res) => {
  const { name, phone, email, serviceType, date, time, model, year, plate, km, notes } = req.body;

  // Validation
  if (!name || !phone || !email || !serviceType || !date || !time || !model || !year || !plate || !km) {
    return res.status(400).json({ error: 'All required fields must be filled.' });
  }

  const validServices = ['oil-change', 'small-service', 'big-service'];
  if (!validServices.includes(serviceType)) {
    return res.status(400).json({ error: 'Invalid service type.' });
  }

  // Check slot still available
  const booked = db.getBookedSlots(date);
  if (booked.includes(time)) {
    return res.status(409).json({ error: 'This time slot is no longer available. Please choose another.' });
  }

  try {
    const booking = db.createBooking({ name, phone, email, serviceType, date, time, model, year, plate, km, notes });

    // Notify admin
    emailService.sendNewBookingAlert(booking).catch(e => console.error('[Email alert error]', e.message));

    res.json({ success: true, ref: booking.ref, message: 'Booking received. We will confirm your appointment shortly.' });
  } catch (err) {
    console.error('[Booking error]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ==================== ADMIN API ====================

// Login
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  const adminHash = process.env.ADMIN_PASSWORD_HASH;

  if (!adminHash) {
    // First-time setup: any password works, then hash is shown in console
    console.log('\n⚠️  ADMIN_PASSWORD_HASH not set. Run: node hash-password.js <your-password>\n');
    return res.status(401).json({ error: 'Admin password not configured. See server console.' });
  }

  const valid = await bcrypt.compare(password, adminHash);
  if (!valid) return res.status(401).json({ error: 'Incorrect password.' });

  req.session.admin = true;
  res.json({ success: true });
});

// Logout
app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Check auth status
app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ admin: true });
});

// Get all bookings
app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const bookings = db.getAllBookings().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(bookings);
});

// Accept a booking
app.post('/api/admin/bookings/:id/accept', requireAdmin, async (req, res) => {
  const booking = db.updateBookingStatus(req.params.id, 'accepted');
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  // Send notifications
  let emailError = null;
  try {
    await emailService.sendConfirmationToCustomer(booking);
    console.log(`[Email] Confirmation sent to ${booking.email}`);
  } catch (e) {
    emailError = e.message;
    console.error('[Email] Confirmation FAILED:', e.message, e.code || '');
  }

  try {
    await smsService.sendConfirmationSMS(booking);
  } catch (e) {
    console.error('[SMS] Confirmation FAILED:', e.message);
  }

  res.json({ success: true, booking, emailError });
});

// Cancel a booking
app.post('/api/admin/bookings/:id/cancel', requireAdmin, async (req, res) => {
  const booking = db.updateBookingStatus(req.params.id, 'cancelled');
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  try {
    await emailService.sendCancellationToCustomer(booking);
    console.log(`[Email] Cancellation sent to ${booking.email}`);
  } catch (e) {
    console.error('[Email] Cancellation FAILED:', e.message, e.code || '');
  }

  try {
    await smsService.sendCancellationSMS(booking);
  } catch (e) {
    console.error('[SMS] Cancellation FAILED:', e.message);
  }

  res.json({ success: true, booking });
});

// Test email (admin only — use to verify Railway env vars are working)
app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  const to = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
  console.log('[Email] Test requested. GMAIL_USER set:', !!process.env.GMAIL_USER, '| GMAIL_APP_PASSWORD set:', !!process.env.GMAIL_APP_PASSWORD);
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      },
      connectionTimeout: 10000,
      greetingTimeout:   10000,
      socketTimeout:     15000
    });
    await transporter.sendMail({
      from: `"Motowarehouse Bookings" <${process.env.GMAIL_USER}>`,
      to,
      subject: 'Motowarehouse – Email Test ✓',
      html: '<h2 style="color:#009BB4">Email is working!</h2><p>This test was sent from Railway.</p>'
    });
    res.json({ success: true, message: `Test email sent to ${to}` });
  } catch (e) {
    console.error('[Email] Test FAILED:', e.message, e.code || '');
    res.status(500).json({ success: false, error: e.message, code: e.code });
  }
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// ==================== Start ====================
app.listen(PORT, () => {
  console.log(`\n🏍️  Motowarehouse Service Booking Portal`);
  console.log(`   Running at: http://localhost:${PORT}`);
  console.log(`   Admin panel: http://localhost:${PORT}/admin\n`);
  startReminderCron();
});
