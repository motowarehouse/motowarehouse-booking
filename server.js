require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const path = require('path');
const multer = require('multer');
const { Pool } = require('pg');
const db = require('./db');
const emailService = require('./emailService');
const smsService = require('./smsService');
const r2Service = require('./r2Service');
const { startReminderCron } = require('./reminderCron');
const { startBackupCron } = require('./backupCron');
const pushService = require('./pushService');

// Multer — memory storage, 100 MB per file, up to 20 files
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 20 }
});

// Separate pool for the session store (connect-pg-simple manages its own connection)
const sessionPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' || (process.env.DATABASE_URL || '').includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

const app = express();
const PORT = process.env.PORT || 3001;

// --- Generic in-memory rate limiter factory ---
function makeRateLimiter(maxAttempts, windowMs, errorMsg) {
  const attempts = new Map();
  // Hourly cleanup
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of attempts.entries()) {
      if (now > entry.resetAt) attempts.delete(ip);
    }
  }, 60 * 60 * 1000);

  return function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      attempts.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= maxAttempts) {
      return res.status(429).json({ error: errorMsg });
    }
    entry.count++;
    next();
  };
}

// Public booking: max 5 submissions / IP / hour
const bookingRateLimit = makeRateLimiter(
  5, 60 * 60 * 1000,
  'Too many booking attempts. Please try again later or call us on 22 328 788.'
);

// Admin login: max 5 failed attempts / IP / hour (brute force protection)
const adminLoginRateLimit = makeRateLimiter(
  5, 60 * 60 * 1000,
  'Too many login attempts. Please wait 1 hour or contact support.'
);

// Partner login: max 10 attempts / IP / hour (partners may share a device / café WiFi)
const partnerLoginRateLimit = makeRateLimiter(
  10, 60 * 60 * 1000,
  'Too many login attempts. Please wait 1 hour.'
);

// ── Phone normalisation (shared by OTP routes + /api/book) ───────────────────
function normalisePhone(raw) {
  if (!raw) return '';
  let s = raw.trim();
  // Already international with + prefix
  if (s.startsWith('+')) return s;
  // 00-prefixed international
  if (s.startsWith('00')) return '+' + s.slice(2);
  // Digits only — strip formatting first
  const digits = s.replace(/\D/g, '');
  // 8-digit Cyprus local (mobile 9xxxxxxx, landline 2xxxxxxx)
  if (/^[92]\d{7}$/.test(digits)) return '+357' + digits;
  // Anything else: prepend + and trust the user
  return '+' + digits;
}

// ── OTP store — keyed by normalised phone ────────────────────────────────────
// Entry shape: { code, expiresAt, attempts, verified, verifiedAt, sendCount, sendWindowStart }
const otpStore = new Map();

// Purge stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  const VERIFIED_GRACE = 15 * 60 * 1000; // keep verified entries 15 min so /api/book can check
  for (const [phone, e] of otpStore.entries()) {
    const stale = now > e.expiresAt && !(e.verified && now < (e.verifiedAt || 0) + VERIFIED_GRACE);
    if (stale) otpStore.delete(phone);
  }
}, 10 * 60 * 1000);

// --- Middleware ---
app.set('trust proxy', 1); // Required for Railway/Heroku HTTPS proxy
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
if (!process.env.SESSION_SECRET) {
  console.warn('\n⚠️  SESSION_SECRET is not set. Using insecure default. Set SESSION_SECRET in Railway environment variables.\n');
}
app.use(session({
  store: new pgSession({
    pool:               sessionPool,
    tableName:          'session',
    createTableIfMissing: true  // safety net — also created in initDB()
  }),
  secret: process.env.SESSION_SECRET || 'mw-secret-2024-CHANGE-ME',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days (survives across deployments)
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  }
}));

// --- Auth middleware ---
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ error: 'Unauthorised' });
}

function requirePartner(req, res, next) {
  if (req.session && req.session.partner) return next();
  res.status(401).json({ error: 'Unauthorised' });
}

function requireAdminOrPartner(req, res, next) {
  if ((req.session && req.session.admin) || (req.session && req.session.partner)) return next();
  res.status(401).json({ error: 'Unauthorised' });
}

// ==================== PUBLIC API ====================

// Get available time slots for a date
// Accepts optional ?model=&serviceType= to do duration-aware slot filtering.
app.get('/api/slots', async (req, res) => {
  try {
    const { date, model, serviceType } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });

    const d = new Date(date + 'T12:00:00');
    const day = d.getDay();

    const hours = await db.getHours();
    const dayConfig = hours[day];

    if (!dayConfig || dayConfig.closed) {
      return res.json({ slots: [], closed: true });
    }

    // Duration for this service type + model (defaults to 60 if not provided)
    const durationMins = db.getDurationMins(model || '', serviceType || 'small-service');

    // Latest closing time for the day (max across all ranges)
    let lastClosingMins = 0;
    const slots = [];
    for (const [start, end] of dayConfig.ranges) {
      let [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);
      lastClosingMins = Math.max(lastClosingMins, eh * 60 + em);
      while (sh * 60 + sm < eh * 60 + em) {
        slots.push(`${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`);
        sm += 30;
        if (sm >= 60) { sh++; sm -= 60; }
      }
    }

    const booked = await db.getBookedSlots(date, durationMins);

    const todayStr = new Date().toISOString().split('T')[0];
    let available = slots.filter(s => {
      if (booked.includes(s)) return false;
      // A job must fit entirely within ONE continuous open range.
      // This prevents booking a slot that spans across a closed period (e.g. lunch break).
      const [sh, sm] = s.split(':').map(Number);
      const slotStart = sh * 60 + sm;
      const slotEnd   = slotStart + durationMins;
      return dayConfig.ranges.some(([rs, re]) => {
        const [rsh, rsm] = rs.split(':').map(Number);
        const [reh, rem] = re.split(':').map(Number);
        return slotStart >= rsh * 60 + rsm && slotEnd <= reh * 60 + rem;
      });
    });

    if (date === todayStr) {
      const nowCyprus = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Nicosia' }));
      const nowMins = nowCyprus.getHours() * 60 + nowCyprus.getMinutes() + 30;
      available = available.filter(s => {
        const [h, m] = s.split(':').map(Number);
        return h * 60 + m > nowMins;
      });
    }

    res.json({ slots: available, booked, durationMins });
  } catch (err) {
    console.error('[Slots error]', err);
    res.status(500).json({ error: 'Failed to load slots.' });
  }
});

// ── OTP: send verification code ──────────────────────────────────────────────
app.post('/api/verify/send', async (req, res) => {
  const { phone, email } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required.' });

  const norm = normalisePhone(phone);
  if (norm.replace(/\D/g, '').length < 7) {
    return res.status(400).json({ error: 'Invalid phone number.' });
  }

  const now = Date.now();
  const existing = otpStore.get(norm);

  // Rate limit: max 3 SMS per phone per hour
  const HOUR = 60 * 60 * 1000;
  if (existing) {
    const windowAge = now - (existing.sendWindowStart || 0);
    if (windowAge < HOUR && (existing.sendCount || 0) >= 3) {
      return res.status(429).json({ error: 'Too many code requests. Please try again in an hour or call us on 22 328 788.' });
    }
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const prevCount = (existing && (now - (existing.sendWindowStart || 0)) < HOUR) ? (existing.sendCount || 0) : 0;

  otpStore.set(norm, {
    code,
    expiresAt:       now + 5 * 60 * 1000,
    attempts:        0,
    verified:        false,
    verifiedAt:      null,
    sendCount:       prevCount + 1,
    sendWindowStart: (existing && (now - (existing.sendWindowStart || 0)) < HOUR)
                       ? existing.sendWindowStart
                       : now
  });

  // Try SMS first
  try {
    await smsService.sendBrevoSMS(norm, `Motowarehouse: Your verification code is ${code}. Valid for 5 minutes. Do not share this code.`);
    console.log(`[OTP] SMS sent to ${norm}`);
    return res.json({ success: true, via: 'sms' });
  } catch (smsErr) {
    console.warn('[OTP] SMS failed:', smsErr.message);
  }

  // SMS failed — try email fallback if email was provided
  const cleanEmail = (email || '').trim();
  if (cleanEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    try {
      await emailService.sendOTPCodeEmail(cleanEmail, code);
      console.log(`[OTP] Email fallback sent to ${cleanEmail}`);
      return res.json({ success: true, via: 'email' });
    } catch (emailErr) {
      console.error('[OTP] Email fallback also failed:', emailErr.message);
    }
  }

  // Both failed — remove entry so the attempt doesn't count against rate limit
  otpStore.delete(norm);
  res.status(500).json({ error: 'Could not send your verification code. Please check your phone number or call us on 22 328 788 to book directly.' });
});

// ── OTP: confirm code ─────────────────────────────────────────────────────────
app.post('/api/verify/confirm', (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Phone and code required.' });

  const norm  = normalisePhone(phone);
  const entry = otpStore.get(norm);

  if (!entry) {
    return res.status(400).json({ error: 'No code found for this number. Please request a new one.' });
  }

  const now = Date.now();
  if (now > entry.expiresAt) {
    otpStore.delete(norm);
    return res.status(400).json({ error: 'Code has expired. Please request a new one.' });
  }

  if (entry.attempts >= 5) {
    return res.status(429).json({ error: 'Too many incorrect attempts. Please request a new code.' });
  }

  if (entry.code !== String(code).trim()) {
    entry.attempts++;
    const left = 5 - entry.attempts;
    if (left <= 0) {
      return res.status(429).json({ error: 'Too many incorrect attempts. Please request a new code.' });
    }
    return res.status(400).json({
      error: `Incorrect code. ${left} attempt${left !== 1 ? 's' : ''} remaining.`
    });
  }

  // ✓ Correct code
  entry.verified   = true;
  entry.verifiedAt = now;
  console.log(`[OTP] Phone verified: ${norm}`);
  res.json({ success: true });
});

// Submit a new booking
app.post('/api/book', bookingRateLimit, async (req, res) => {
  const { name, phone, email, serviceType, date, time, model, year, plate, km, notes, description } = req.body;

  const isOther = serviceType === 'other';
  const validServices = ['small-service', 'full-service', 'other'];

  if (!name || !phone || !serviceType || !model || !year || !plate || !km) {
    return res.status(400).json({ error: 'All required fields must be filled.' });
  }

  if (!validServices.includes(serviceType)) {
    return res.status(400).json({ error: 'Invalid service type.' });
  }

  // Phone validation: 7–15 digits (after stripping spaces, +, -)
  const phoneDigits = (phone || '').replace(/[\s\+\-]/g, '');
  if (!/^\d{7,15}$/.test(phoneDigits)) {
    return res.status(400).json({ error: 'Please enter a valid phone number (7–15 digits).' });
  }

  // OTP verification check — phone must have been verified within the last 15 minutes
  const normPhone = normalisePhone(phone);
  const otpEntry  = otpStore.get(normPhone);
  const otpNow    = Date.now();
  if (!otpEntry || !otpEntry.verified || (otpNow - (otpEntry.verifiedAt || 0)) > 15 * 60 * 1000) {
    return res.status(403).json({ error: 'Please verify your phone number with the SMS code before booking.' });
  }

  // Duplicate active booking check for this plate
  const existingBooking = await db.getActiveBookingByPlate(plate);
  if (existingBooking) {
    return res.status(409).json({
      error: `There is already an active booking for plate ${plate.toUpperCase()} (Ref: ${existingBooking.ref}). Please cancel it first or call us on 22 328 788.`
    });
  }

  // Word count helper — max 30 words for free-text fields
  const wordCount = s => (s || '').trim().split(/\s+/).filter(Boolean).length;
  if (wordCount(notes) > 30) return res.status(400).json({ error: 'Notes must be 30 words or fewer.' });

  if (isOther) {
    if (!email) return res.status(400).json({ error: 'Email is required so we can confirm your request.' });
    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'Please describe what service you need.' });
    }
    if (wordCount(description) > 30) return res.status(400).json({ error: 'Description must be 30 words or fewer.' });
  } else {
    if (!email || !date || !time) {
      return res.status(400).json({ error: 'All required fields must be filled.' });
    }
    // Duration-aware slot double-check (same logic as the calendar uses)
    const durationMins = db.getDurationMins(model, serviceType);
    const booked = await db.getBookedSlots(date, durationMins);
    if (booked.includes(time)) {
      return res.status(409).json({ error: 'This time slot is no longer available. Please choose another.' });
    }
  }

  try {
    const bookingData = {
      name, phone, email: email || '', serviceType,
      date: date || '', time: time || '',
      model, year, plate, km, notes: notes || '',
      description: description || '',
      ...(isOther && { contactStatus: 'needs-call' })
    };
    const booking = await db.createBooking(bookingData);

    // Consume the verified OTP so it can't be reused
    otpStore.delete(normalisePhone(phone));

    emailService.sendNewBookingAlert(booking).catch(e => console.error('[Email alert error]', e.message));
    pushService.sendPushToAll(pushService.newBookingPayload(booking)).catch(e => console.error('[Push alert error]', e.message));

    if (isOther) {
      emailService.sendOtherRequestAcknowledgement(booking).catch(e => console.error('[Email other ack error]', e.message));
      res.json({ success: true, ref: booking.ref, message: 'Request received. A member of our team will call you to arrange an appointment.' });
    } else {
      res.json({ success: true, ref: booking.ref, message: 'Booking received. We will confirm your appointment shortly.' });
    }
  } catch (err) {
    console.error('[Booking error]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── Public plate lookup (used by booking form for auto-fill) ─────────────────
app.get('/api/booking/vehicle-lookup', async (req, res) => {
  try {
    const plate = (req.query.plate || '').trim().toUpperCase();
    if (!plate) return res.status(400).json({ error: 'plate required' });
    const vehicle = await db.getVehicleByPlate(plate);
    if (!vehicle) return res.status(404).json({ found: false });
    res.json({ found: true, model: vehicle.model, year: vehicle.year, manufacturer: vehicle.manufacturer, description: vehicle.description || '' });
  } catch (err) {
    console.error('[Public vehicle lookup error]', err);
    res.status(500).json({ found: false });
  }
});

// Server time — used by partner/public portals so displayed date always matches what will be recorded
app.get('/api/server-time', (req, res) => {
  const cyprusDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Nicosia' }));
  res.json({
    date:        cyprusDate.toISOString().split('T')[0],          // "2026-05-14"
    displayDate: cyprusDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) // "14 May 2026"
  });
});

// ==================== ADMIN API ====================

// Login
app.post('/api/admin/login', adminLoginRateLimit, async (req, res) => {
  const { password } = req.body;
  const adminHash = process.env.ADMIN_PASSWORD_HASH;

  if (!adminHash) {
    console.log('\n⚠️  ADMIN_PASSWORD_HASH not set. Run: node hash-password.js <your-password>\n');
    return res.status(401).json({ error: 'Admin password not configured. See server console.' });
  }

  const valid = await bcrypt.compare(password, adminHash);
  if (!valid) return res.status(401).json({ error: 'Incorrect password.' });

  req.session.admin = true;
  req.session.save(err => {
    if (err) {
      console.error('[Session save error]', err);
      return res.status(500).json({ error: 'Session could not be saved. Please try again.' });
    }
    res.json({ success: true });
  });
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

// Get bookings — defaults to last 30 days; pass ?from=all to load everything
app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    let fromDate = null;
    if (req.query.from !== 'all') {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      fromDate = d.toISOString().slice(0, 10); // YYYY-MM-DD
    }
    const bookings = await db.getAllBookings({ fromDate });
    res.json(bookings);
  } catch (err) {
    console.error('[Get bookings error]', err);
    res.status(500).json({ error: 'Failed to load bookings.' });
  }
});

// Accept a booking
app.post('/api/admin/bookings/:id/accept', requireAdmin, async (req, res) => {
  try {
    const booking = await db.updateBookingStatus(req.params.id, 'accepted');
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    let emailError = null;
    try {
      await emailService.sendConfirmationToCustomer(booking);
      console.log('[Email] Confirmation sent to ' + booking.email);
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
  } catch (err) {
    console.error('[Accept error]', err);
    res.status(500).json({ error: 'Failed to accept booking.' });
  }
});

// Reschedule a booking
app.post('/api/admin/bookings/:id/reschedule', requireAdmin, async (req, res) => {
  try {
    const { date, time } = req.body;
    if (!date || !time) return res.status(400).json({ error: 'date and time required' });

    const booking = await db.rescheduleBooking(req.params.id, date, time);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    try {
      await emailService.sendRescheduleToCustomer(booking);
      console.log('[Email] Reschedule sent to ' + booking.email);
    } catch (e) {
      console.error('[Email] Reschedule FAILED:', e.message);
    }

    try {
      await smsService.sendRescheduleSMS(booking);
    } catch (e) {
      console.error('[SMS] Reschedule FAILED:', e.message);
    }

    res.json({ success: true, booking });
  } catch (err) {
    console.error('[Reschedule error]', err);
    res.status(500).json({ error: 'Failed to reschedule booking.' });
  }
});

// Update contact status for cancelled / needs-call bookings
app.post('/api/admin/bookings/:id/contact-status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['needs-contact', 'needs-call', 'contacted', 'closed'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const booking = await db.updateContactStatus(req.params.id, status);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    res.json({ success: true, booking });
  } catch (err) {
    console.error('[Contact status error]', err);
    res.status(500).json({ error: 'Failed to update contact status.' });
  }
});

// Cancel a booking
app.post('/api/admin/bookings/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const booking = await db.updateBookingStatus(req.params.id, 'cancelled');
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    try {
      await emailService.sendCancellationToCustomer(booking);
      console.log('[Email] Cancellation sent to ' + booking.email);
    } catch (e) {
      console.error('[Email] Cancellation FAILED:', e.message, e.code || '');
    }

    try {
      await smsService.sendCancellationSMS(booking);
    } catch (e) {
      console.error('[SMS] Cancellation FAILED:', e.message);
    }

    res.json({ success: true, booking });
  } catch (err) {
    console.error('[Cancel error]', err);
    res.status(500).json({ error: 'Failed to cancel booking.' });
  }
});

// Complete a booking and write service history
app.post('/api/admin/bookings/:id/complete', requireAdmin, async (req, res) => {
  try {
    const { regNo, km, items, notes, date } = req.body;
    if (!km) return res.status(400).json({ error: 'KM reading is required.' });

    const result = await db.completeBooking(req.params.id, { regNo, km, items, notes, date });
    if (!result) return res.status(404).json({ error: 'Booking not found' });

    // Notify customer their vehicle is ready
    const booking = result.booking;
    if (booking.email) {
      emailService.sendVehicleReadyToCustomer(booking).catch(e => console.error('[Email ready error]', e.message));
    }
    smsService.sendVehicleReadySMS(booking).catch(e => console.error('[SMS ready error]', e.message));

    res.json({ success: true, booking, serviceEntry: result.serviceEntry });
  } catch (err) {
    console.error('[Complete error]', err);
    res.status(500).json({ error: 'Failed to complete booking.' });
  }
});

// Mark booking as no-show
app.post('/api/admin/bookings/:id/no-show', requireAdmin, async (req, res) => {
  try {
    const booking = await db.markNoShow(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json({ success: true, booking });
  } catch (err) {
    console.error('[No-show error]', err);
    res.status(500).json({ error: 'Failed to mark no-show.' });
  }
});

// Save mechanic notes on an accepted booking
app.post('/api/admin/bookings/:id/mechanic-notes', requireAdmin, async (req, res) => {
  try {
    const { notes } = req.body;
    const booking = await db.updateMechanicNotes(req.params.id, notes);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json({ success: true, booking });
  } catch (err) {
    console.error('[Mechanic notes error]', err);
    res.status(500).json({ error: 'Failed to save notes.' });
  }
});

// Get all blocks
app.get('/api/admin/blocks', requireAdmin, async (req, res) => {
  try {
    const blocks = await db.getAllBlocks();
    res.json(blocks);
  } catch (err) {
    console.error('[Get blocks error]', err);
    res.status(500).json({ error: 'Failed to load blocks.' });
  }
});

// Create a block
app.post('/api/admin/blocks', requireAdmin, async (req, res) => {
  try {
    const { date, startTime, endTime, reason, customerName, customerPhone, vehicleModel, notes } = req.body;
    if (!date || !startTime || !endTime) {
      return res.status(400).json({ error: 'date, startTime, and endTime are required.' });
    }
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    if (sh * 60 + sm >= eh * 60 + em) {
      return res.status(400).json({ error: 'End time must be after start time.' });
    }
    const block = await db.createBlock({ date, startTime, endTime, reason, customerName, customerPhone, vehicleModel, notes });
    res.json({ success: true, block });
  } catch (err) {
    console.error('[Create block error]', err);
    res.status(500).json({ error: 'Failed to create block.' });
  }
});

// Delete a block
app.delete('/api/admin/blocks/:id', requireAdmin, async (req, res) => {
  try {
    const ok = await db.deleteBlock(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Block not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Delete block error]', err);
    res.status(500).json({ error: 'Failed to delete block.' });
  }
});

// Get hours
app.get('/api/admin/hours', requireAdmin, async (req, res) => {
  try {
    res.json(await db.getHours());
  } catch (err) {
    console.error('[Get hours error]', err);
    res.status(500).json({ error: 'Failed to load hours.' });
  }
});

// Save hours
app.post('/api/admin/hours', requireAdmin, async (req, res) => {
  try {
    const { hours } = req.body;
    if (!hours) return res.status(400).json({ error: 'hours object required.' });
    await db.saveHours(hours);
    res.json({ success: true });
  } catch (err) {
    console.error('[Save hours error]', err);
    res.status(500).json({ error: 'Failed to save hours.' });
  }
});

// Test email (admin only)
app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  const to = process.env.ADMIN_EMAIL;
  console.log('[Email] Test requested via Brevo. API key set:', !!process.env.BREVO_API_KEY, '| To:', to);
  try {
    await emailService.sendNewBookingAlert({
      ref: 'TEST-001', name: 'Test User', phone: '99000000',
      email: to, serviceType: 'small-service',
      date: new Date().toISOString().split('T')[0], time: '09:00',
      model: 'CFMOTO 450NK', year: '2024', plate: 'ABC123', km: '1000', notes: 'This is a test email.'
    });
    console.log('[Email] Test sent successfully via Brevo');
    res.json({ success: true, message: 'Test email sent to ' + to });
  } catch (e) {
    console.error('[Email] Test FAILED:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── PWA Push Subscriptions ────────────────────────────────────────────────────

// Save or update a push subscription (admin only)
app.post('/api/push/subscribe', requireAdmin, async (req, res) => {
  try {
    const sub = req.body;
    if (!sub || !sub.endpoint || !sub.keys) return res.status(400).json({ error: 'Invalid subscription object.' });
    await pushService.saveSubscription(sub);
    res.json({ success: true });
  } catch (err) {
    console.error('[Push] Subscribe error:', err.message);
    res.status(500).json({ error: 'Failed to save subscription.' });
  }
});

// Remove a push subscription
app.post('/api/push/unsubscribe', requireAdmin, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint required.' });
    await pushService.removeSubscription(endpoint);
    res.json({ success: true });
  } catch (err) {
    console.error('[Push] Unsubscribe error:', err.message);
    res.status(500).json({ error: 'Failed to remove subscription.' });
  }
});

// Return the VAPID public key so the browser can subscribe
app.get('/api/push/vapid-key', requireAdmin, (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Test push notification
app.post('/api/push/test', requireAdmin, async (req, res) => {
  try {
    await pushService.sendPushToAll({
      title: '🔔 Test Notification',
      body:  'Push notifications are working correctly!',
      tag:   'test',
      url:   '/admin/',
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Mechanic off-days ─────────────────────────────────────────────────────────

// Get which mechanics are off on a given date
app.get('/api/admin/mechanic-off-days', requireAdmin, async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });
    const offMechanics = await db.getMechanicOffDays(date);
    res.json({ date, offMechanics });
  } catch (err) {
    console.error('[Mechanic off-days GET error]', err);
    res.status(500).json({ error: 'Failed to load mechanic availability.' });
  }
});

// Mark a mechanic as off for a date
app.post('/api/admin/mechanic-off-days', requireAdmin, async (req, res) => {
  try {
    const { mechanicId, date } = req.body;
    if (!mechanicId || !date) return res.status(400).json({ error: 'mechanicId and date are required.' });
    await db.addMechanicOffDay(mechanicId, date);
    res.json({ success: true });
  } catch (err) {
    console.error('[Mechanic off-days POST error]', err);
    res.status(500).json({ error: 'Failed to mark mechanic as off.' });
  }
});

// Unmark a mechanic as off for a date (restore to available)
app.delete('/api/admin/mechanic-off-days', requireAdmin, async (req, res) => {
  try {
    const { mechanicId, date } = req.body;
    if (!mechanicId || !date) return res.status(400).json({ error: 'mechanicId and date are required.' });
    await db.removeMechanicOffDay(mechanicId, date);
    res.json({ success: true });
  } catch (err) {
    console.error('[Mechanic off-days DELETE error]', err);
    res.status(500).json({ error: 'Failed to restore mechanic availability.' });
  }
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// ==================== PARTNER API ====================

// Partner login
app.post('/api/partner/login', partnerLoginRateLimit, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

    const partner = await db.getPartnerByUsername(username);
    if (!partner || !partner.active) return res.status(401).json({ error: 'Invalid credentials.' });

    const valid = await bcrypt.compare(password, partner.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });

    req.session.partner = { id: partner.id, username: partner.username, workshopName: partner.workshopName };
    res.json({ success: true, workshopName: partner.workshopName });
  } catch (err) {
    console.error('[Partner login error]', err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// Partner logout
app.post('/api/partner/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Partner auth check
app.get('/api/partner/me', requirePartner, (req, res) => {
  res.json({ partner: req.session.partner });
});

// Partner changes own password — must be logged in, can only change their own
app.post('/api/partner/change-password', requirePartner, async (req, res) => {
  try {
    const { username, currentPassword, newPassword } = req.body;
    if (!username || !currentPassword || !newPassword) return res.status(400).json({ error: 'All fields are required.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });

    // Prevent a partner from changing another partner's password
    if (username.toLowerCase().trim() !== req.session.partner.username.toLowerCase()) {
      return res.status(403).json({ error: 'You can only change your own password.' });
    }

    const partner = await db.getPartnerByUsername(username);
    if (!partner) return res.status(404).json({ error: 'Partner not found.' });

    const valid = await bcrypt.compare(currentPassword, partner.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.updatePartnerPassword(partner.id, passwordHash);
    res.json({ success: true });
  } catch (err) {
    console.error('[Change password error]', err);
    res.status(500).json({ error: 'Failed to change password.' });
  }
});

// Look up vehicle by plate (partner + admin)
app.get('/api/vehicle', requireAdminOrPartner, async (req, res) => {
  try {
    const { plate } = req.query;
    if (!plate) return res.status(400).json({ error: 'plate required' });
    const vehicle = await db.getVehicleByPlate(plate);
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found in our records.' });
    res.json(vehicle);
  } catch (err) {
    console.error('[Vehicle lookup error]', err);
    res.status(500).json({ error: 'Failed to look up vehicle.' });
  }
});

// Get service checklist items
app.get('/api/service-items', requireAdminOrPartner, (req, res) => {
  res.json(db.DEFAULT_SERVICE_ITEMS);
});

// Log a service entry (partner or admin)
app.post('/api/service-entry', requireAdminOrPartner, async (req, res) => {
  try {
    const { regNo, km, items, notes, date } = req.body;
    if (!regNo || !km || !items || items.length === 0) {
      return res.status(400).json({ error: 'Plate, KM, and at least one service item are required.' });
    }
    if (!await db.getVehicleByPlate(regNo)) {
      return res.status(404).json({ error: 'Vehicle not found in our records.' });
    }

    const isAdmin = !!(req.session && req.session.admin);
    const partnerInfo = req.session.partner || null;

    const entry = await db.createServiceEntry({
      regNo, km, items, notes, date,
      partnerId:    partnerInfo ? partnerInfo.id : null,
      partnerName:  partnerInfo ? partnerInfo.workshopName : 'Motowarehouse',
      loggedByAdmin: isAdmin
    });

    res.json({ success: true, entry });
  } catch (err) {
    console.error('[Service entry error]', err);
    res.status(500).json({ error: 'Failed to save service entry.' });
  }
});

// Edit a service entry — partners can only edit their own entries; admin can edit any
app.put('/api/service-entry/:id', requireAdminOrPartner, async (req, res) => {
  try {
    const { km, items, notes } = req.body;

    // Ownership check for partners
    if (req.session.partner && !req.session.admin) {
      const entry = await db.getServiceEntryById(req.params.id);
      if (!entry) return res.status(404).json({ error: 'Entry not found.' });
      if (String(entry.partnerId) !== String(req.session.partner.id)) {
        return res.status(403).json({ error: 'You can only edit your own service entries.' });
      }
    }

    const result = await db.updateServiceEntry(req.params.id, { km, items, notes });
    if (result.notFound) return res.status(404).json({ error: 'Entry not found.' });
    res.json({ success: true, entry: result.entry });
  } catch (err) {
    console.error('[Update service entry error]', err);
    res.status(500).json({ error: 'Failed to update service entry.' });
  }
});

// Delete a service entry — admin only
app.delete('/api/service-entry/:id', requireAdmin, async (req, res) => {
  try {
    const result = await db.deleteServiceEntry(req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Entry not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Delete service entry error]', err);
    res.status(500).json({ error: 'Failed to delete service entry.' });
  }
});

// ==================== ADMIN - VEHICLES ====================

// Vehicle import status — must be defined BEFORE /:plate to avoid route collision
app.get('/api/admin/vehicles/import-status', requireAdmin, async (req, res) => {
  try {
    res.json({ lastImportAt: await db.getSetting('lastVehicleImport') });
  } catch (err) {
    console.error('[Import status error]', err);
    res.status(500).json({ error: 'Failed to get import status.' });
  }
});

// Import vehicles from JSON array (parsed from CSV/Excel by frontend)
app.post('/api/admin/vehicles/import', requireAdmin, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows array required.' });
    }
    const result = await db.importVehicles(rows);
    await db.setSetting('lastVehicleImport', new Date().toISOString());
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Import vehicles error]', err);
    res.status(500).json({ error: 'Failed to import vehicles.' });
  }
});

// Get all vehicles (paginated search)
app.get('/api/admin/vehicles', requireAdmin, async (req, res) => {
  try {
    const { q } = req.query;
    let vehicles = await db.getAllVehicles();
    if (q) {
      const search = q.toUpperCase().trim();
      vehicles = vehicles.filter(v =>
        v.regNo.includes(search) ||
        v.model.toUpperCase().includes(search) ||
        v.frameNo.toUpperCase().includes(search)
      );
    }
    res.json(vehicles.slice(0, 50));
  } catch (err) {
    console.error('[Get vehicles error]', err);
    res.status(500).json({ error: 'Failed to load vehicles.' });
  }
});

// Get vehicle + full service + warranty history (admin only)
app.get('/api/admin/vehicles/:plate', requireAdmin, async (req, res) => {
  try {
    const vehicle = await db.getVehicleByPlate(req.params.plate);
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });
    const history  = await db.getServiceHistoryByPlate(req.params.plate);
    const warranty = await db.getWarrantyByPlate(req.params.plate);
    res.json({ vehicle, history, warranty });
  } catch (err) {
    console.error('[Vehicle detail error]', err);
    res.status(500).json({ error: 'Failed to load vehicle.' });
  }
});

// ==================== ADMIN - PARTNERS ====================

// List all partners
app.get('/api/admin/partners', requireAdmin, async (req, res) => {
  try {
    const partners = (await db.getAllPartners()).map(p => ({ ...p, passwordHash: undefined }));
    res.json(partners);
  } catch (err) {
    console.error('[Get partners error]', err);
    res.status(500).json({ error: 'Failed to load partners.' });
  }
});

// Create a partner
app.post('/api/admin/partners', requireAdmin, async (req, res) => {
  try {
    const { username, password, workshopName, phone, email } = req.body;
    if (!username || !password || !workshopName) {
      return res.status(400).json({ error: 'username, password, and workshopName are required.' });
    }
    if (await db.getPartnerByUsername(username)) {
      return res.status(409).json({ error: 'Username already exists.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const partner = await db.createPartner({ username, passwordHash, workshopName, phone, email });
    res.json({ success: true, partner: { ...partner, passwordHash: undefined } });
  } catch (err) {
    console.error('[Create partner error]', err);
    res.status(500).json({ error: 'Failed to create partner.' });
  }
});

// Toggle partner active/inactive
app.post('/api/admin/partners/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const partner = await db.togglePartnerActive(req.params.id);
    if (!partner) return res.status(404).json({ error: 'Partner not found.' });
    res.json({ success: true, partner: { ...partner, passwordHash: undefined } });
  } catch (err) {
    console.error('[Toggle partner error]', err);
    res.status(500).json({ error: 'Failed to toggle partner.' });
  }
});

// Reset a partner's password (admin only)
app.post('/api/admin/partners/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const partner = await db.updatePartnerPassword(req.params.id, passwordHash);
    if (!partner) return res.status(404).json({ error: 'Partner not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Reset password error]', err);
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// Serve partner portal
app.get('/partner', (req, res) => {
  res.sendFile(path.join(__dirname, 'partner', 'index.html'));
});

// ==================== MEDIA UPLOAD (Cloudflare R2) ====================

// Upload a single file to R2 — returns { url, type }
// Partners and admins only. Called once per file before submitting a warranty claim.
app.post('/api/upload-media', requireAdminOrPartner, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });

    const allowed = ['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/quicktime','video/webm'];
    if (!allowed.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'File type not allowed. Use JPG, PNG, MP4, or MOV.' });
    }

    const url = await r2Service.uploadToR2(req.file.buffer, req.file.originalname, req.file.mimetype);
    const type = req.file.mimetype.startsWith('video') ? 'video' : 'image';
    res.json({ url, type });
  } catch (err) {
    console.error('[R2 upload error]', err.message);
    res.status(500).json({ error: 'Upload failed. Please try again.' });
  }
});

// ==================== WARRANTY ====================

// Log a warranty claim (partner or admin) — higher body limit for photo uploads
app.post('/api/warranty-claim', express.json({ limit: '10mb' }), requireAdminOrPartner, async (req, res) => {
  try {
    const { regNo, frameNo, km, symptom, priority, engineDisassembly, defectAgreed, courtesyVehicle, notes, photos, mediaTypes } = req.body;
    if (!regNo || !symptom) {
      return res.status(400).json({ error: 'Registration number and symptom are required.' });
    }
    const isAdmin = !!(req.session && req.session.admin);
    const partnerInfo = req.session.partner || null;
    const claim = await db.createWarrantyClaim({
      regNo, frameNo, km, symptom, priority,
      engineDisassembly, defectAgreed, courtesyVehicle, notes,
      photos:     Array.isArray(photos)     ? photos     : [],
      mediaTypes: Array.isArray(mediaTypes) ? mediaTypes : [],
      partnerId:    partnerInfo ? partnerInfo.id : null,
      partnerName:  partnerInfo ? partnerInfo.workshopName : 'Motowarehouse',
      loggedBy:     partnerInfo ? partnerInfo.workshopName : 'Motowarehouse',
      loggedByAdmin: isAdmin
    });
    emailService.sendWarrantyAlert(claim).catch(e => console.error('[Email] Warranty alert failed:', e));
    res.json({ success: true, claim });
  } catch (err) {
    console.error('[Warranty claim error]', err);
    res.status(500).json({ error: 'Failed to save warranty claim.' });
  }
});

// Get warranty claims submitted by the logged-in partner (own claims only)
app.get('/api/partner/warranties', requirePartner, async (req, res) => {
  try {
    const partnerId = String(req.session.partner.id);
    const all = await db.getAllWarranties();
    const mine = all.filter(c => String(c.partnerId) === partnerId);
    res.json(mine);
  } catch (err) {
    console.error('[Partner warranties error]', err);
    res.status(500).json({ error: 'Failed to load claims.' });
  }
});

// Get all warranty claims (admin inbox)
app.get('/api/admin/warranties', requireAdmin, async (req, res) => {
  try {
    res.json(await db.getAllWarranties());
  } catch (err) {
    console.error('[Get warranties error]', err);
    res.status(500).json({ error: 'Failed to load warranties.' });
  }
});

// Update warranty claim status — also emails the partner if they have an email on file
app.post('/api/admin/warranties/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status, adminNotes } = req.body;
    const valid = ['open', 'approved', 'rejected', 'closed'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    const claim = await db.updateWarrantyStatus(req.params.id, status, adminNotes);
    if (!claim) return res.status(404).json({ error: 'Claim not found.' });

    // Notify partner by email if they submitted this claim and have an email address
    if (claim.partnerId) {
      try {
        const partner = await db.getPartnerById(claim.partnerId);
        if (partner && partner.email) {
          await emailService.sendWarrantyStatusToPartner(claim, partner.email, partner.workshopName);
          console.log(`[Email] Warranty status notification sent to ${partner.email}`);
        }
      } catch (e) {
        console.error('[Email] Warranty partner notification FAILED:', e.message);
      }
    }

    res.json({ success: true, claim });
  } catch (err) {
    console.error('[Update warranty error]', err);
    res.status(500).json({ error: 'Failed to update warranty.' });
  }
});

// Get service history by plate (admin only — partners cannot browse service history)
app.get('/api/service-history', requireAdmin, async (req, res) => {
  try {
    const { plate } = req.query;
    if (!plate) return res.status(400).json({ error: 'plate required' });
    const history = await db.getServiceHistoryByPlate(plate);
    res.json(history);
  } catch (err) {
    console.error('[Service history error]', err);
    res.status(500).json({ error: 'Failed to load service history.' });
  }
});

// ==================== CUSTOMER BOOKING LOOKUP ====================

// Look up a booking — two modes:
//   Mode A: ref + plate  (customer has their reference)
//   Mode B: phone + plate (customer lost their reference — phone must match)
app.get('/api/booking/lookup', async (req, res) => {
  try {
    const ref   = (req.query.ref   || '').toUpperCase().trim();
    const plate = (req.query.plate || '').toUpperCase().replace(/\s/g, '');
    const phone = (req.query.phone || '').replace(/[\s\+\-]/g, '');

    if (!plate) return res.status(400).json({ error: 'Licence plate is required.' });
    if (!ref && !phone) return res.status(400).json({ error: 'Booking reference or phone number is required.' });

    const serviceLabels = {
      'small-service': 'Small Service',
      'full-service':  'Full Service',
      'other':         'Service Request'
    };

    const safeFields = (booking) => ({
      ref:         booking.ref,
      name:        booking.name,
      status:      booking.status,
      serviceType: serviceLabels[booking.serviceType] || booking.serviceType,
      date:        booking.date,
      time:        booking.time,
      model:       booking.model,
      year:        booking.year,
      plate:       booking.plate
    });

    if (ref) {
      // Mode A: ref + plate
      const booking = await db.getBookingByRef(ref);
      if (!booking) return res.status(404).json({ error: 'No booking found with that reference number.' });
      const storedPlate = (booking.plate || '').toUpperCase().replace(/\s/g, '');
      if (storedPlate !== plate) return res.status(403).json({ error: 'Licence plate does not match this booking.' });
      return res.json(safeFields(booking));
    }

    // Mode B: phone + plate — find most recent booking matching both
    const allBookings = await db.getAllBookings({});
    const storedPhone = phone.startsWith('357') ? phone : phone; // normalised already
    const match = allBookings.find(b => {
      const bPlate = (b.plate || '').toUpperCase().replace(/\s/g, '');
      const bPhone = (b.phone || '').replace(/[\s\+\-]/g, '').replace(/^00357/, '357').replace(/^357/, '');
      const inputPhone = phone.replace(/^00357/, '357').replace(/^357/, '');
      return bPlate === plate && (bPhone === inputPhone || bPhone.endsWith(inputPhone));
    });

    if (!match) return res.status(404).json({ error: 'No booking found matching that plate and phone number.' });
    return res.json(safeFields(match));

  } catch (err) {
    console.error('[Booking lookup error]', err);
    res.status(500).json({ error: 'Failed to look up booking.' });
  }
});

// Serve the customer booking lookup page
app.get('/my-booking', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'my-booking.html'));
});

// ==================== CUSTOMER SELF-CANCEL ====================

// Serve the cancel page (pre-fills ref from query string in the HTML)
app.get('/cancel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cancel.html'));
});

// Customer submits cancellation
app.post('/api/booking/cancel', bookingRateLimit, async (req, res) => {
  try {
    const { ref, phone } = req.body;
    if (!ref || !phone) {
      return res.status(400).json({ error: 'Booking reference and phone number are required.' });
    }

    const result = await db.cancelBookingByCustomer(ref, phone);

    if (result.error === 'not-found') {
      return res.status(404).json({ error: 'No active booking found with that reference number. It may have already been cancelled or completed.' });
    }
    if (result.error === 'phone-mismatch') {
      return res.status(403).json({ error: 'The phone number does not match our records for this booking.' });
    }

    const booking = result.booking;

    // ── 40-minute cancellation window ─────────────────────────────────────────
    // Accepted bookings with a scheduled time cannot be cancelled within 40 minutes
    if (booking.status === 'accepted' && booking.date && booking.time) {
      const nowCyprus = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Nicosia' }));
      const todayCyprus = nowCyprus.toISOString().split('T')[0];

      // Appointment has already passed
      if (booking.date < todayCyprus) {
        return res.status(403).json({ error: 'This appointment has already passed and cannot be cancelled online.' });
      }

      // Appointment is today — check 40-minute window
      if (booking.date === todayCyprus) {
        const [ah, am] = booking.time.split(':').map(Number);
        const apptMins = ah * 60 + am;
        const nowMins  = nowCyprus.getHours() * 60 + nowCyprus.getMinutes();
        if (apptMins - nowMins < 40) {
          return res.status(403).json({
            error: `Online cancellation is no longer available within 40 minutes of your appointment (${booking.time}). Please call us directly on 22 328 788.`
          });
        }
      }
    }
    console.log(`[Self-Cancel] Booking ${booking.ref} cancelled by customer (phone verified)`);

    // Send confirmation email to customer
    if (booking.email) {
      try {
        await emailService.sendCancellationToCustomer(booking);
        console.log('[Email] Self-cancel confirmation sent to ' + booking.email);
      } catch (e) {
        console.error('[Email] Self-cancel confirmation FAILED:', e.message);
      }
    }

    // Notify admin via email + push
    emailService.sendNewBookingAlert({ ...booking, _selfCancelAlert: true }).catch(() => {});
    pushService.sendPushToAll(pushService.selfCancelPayload(booking)).catch(e => console.error('[Push cancel error]', e.message));

    res.json({ success: true, ref: booking.ref, name: booking.name, date: booking.date, time: booking.time });
  } catch (err) {
    console.error('[Self-cancel error]', err);
    res.status(500).json({ error: 'Something went wrong. Please call us on 22 328 788 to cancel.' });
  }
});

// ==================== START ====================

// Initialise database tables, then start server
db.initDB()
  .then(() => {
    startReminderCron();
    startBackupCron();
    app.listen(PORT, () => {
      console.log(`\n✅ Motowarehouse Service Portal running on http://localhost:${PORT}`);
      console.log(`   Admin panel: http://localhost:${PORT}/admin`);
      console.log(`   Partner portal: http://localhost:${PORT}/partner\n`);
    });
  })
  .catch(err => {
    console.error('\n❌ Could not initialise database. Server will not start.', err.message);
    process.exit(1);
  });
