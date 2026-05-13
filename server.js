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
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
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
app.get('/api/slots', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });

    const d = new Date(date + 'T12:00:00');
    const day = d.getDay();

    const hours = await db.getHours();
    const dayConfig = hours[day];

    if (!dayConfig || dayConfig.closed) {
      return res.json({ slots: [], closed: true });
    }

    const slots = [];
    for (const [start, end] of dayConfig.ranges) {
      let [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);
      while (sh * 60 + sm < eh * 60 + em) {
        slots.push(`${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`);
        sm += 30;
        if (sm >= 60) { sh++; sm -= 60; }
      }
    }

    const booked = await db.getBookedSlots(date);

    const todayStr = new Date().toISOString().split('T')[0];
    let available = slots.filter(s => !booked.includes(s));
    if (date === todayStr) {
      const nowCyprus = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Nicosia' }));
      const nowMins = nowCyprus.getHours() * 60 + nowCyprus.getMinutes() + 30;
      available = available.filter(s => {
        const [h, m] = s.split(':').map(Number);
        return h * 60 + m > nowMins;
      });
    }

    res.json({ slots: available, booked });
  } catch (err) {
    console.error('[Slots error]', err);
    res.status(500).json({ error: 'Failed to load slots.' });
  }
});

// Submit a new booking
app.post('/api/book', async (req, res) => {
  const { name, phone, email, serviceType, date, time, model, year, plate, km, notes, description } = req.body;

  const isOther = serviceType === 'other';
  const validServices = ['small-service', 'full-service', 'other'];

  if (!name || !phone || !serviceType || !model || !year || !plate || !km) {
    return res.status(400).json({ error: 'All required fields must be filled.' });
  }

  if (!validServices.includes(serviceType)) {
    return res.status(400).json({ error: 'Invalid service type.' });
  }

  if (isOther) {
    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'Please describe what service you need.' });
    }
  } else {
    if (!email || !date || !time) {
      return res.status(400).json({ error: 'All required fields must be filled.' });
    }
    const booked = await db.getBookedSlots(date);
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

    emailService.sendNewBookingAlert(booking).catch(e => console.error('[Email alert error]', e.message));

    if (isOther) {
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
    res.json({ found: true, model: vehicle.model, year: vehicle.year, manufacturer: vehicle.manufacturer });
  } catch (err) {
    console.error('[Public vehicle lookup error]', err);
    res.status(500).json({ found: false });
  }
});

// ==================== ADMIN API ====================

// Login
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  const adminHash = process.env.ADMIN_PASSWORD_HASH;

  if (!adminHash) {
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
app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const bookings = await db.getAllBookings();
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

    res.json({ success: true, booking: result.booking, serviceEntry: result.serviceEntry });
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

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// ==================== PARTNER API ====================

// Partner login
app.post('/api/partner/login', async (req, res) => {
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

// Partner changes own password
app.post('/api/partner/change-password', async (req, res) => {
  try {
    const { username, currentPassword, newPassword } = req.body;
    if (!username || !currentPassword || !newPassword) return res.status(400).json({ error: 'All fields are required.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });

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

// Edit a service entry — allowed within 5 min, admin can override lock
app.put('/api/service-entry/:id', requireAdminOrPartner, async (req, res) => {
  try {
    const { km, items, notes, adminOverride } = req.body;
    const isAdmin = !!(req.session && req.session.admin);
    const result = await db.updateServiceEntry(req.params.id, {
      km, items, notes,
      adminOverride: isAdmin && adminOverride
    });
    if (result.notFound) return res.status(404).json({ error: 'Entry not found.' });
    if (result.locked)   return res.status(403).json({ error: 'Edit window has expired (5 minutes).', locked: true });
    res.json({ success: true, entry: result.entry });
  } catch (err) {
    console.error('[Update service entry error]', err);
    res.status(500).json({ error: 'Failed to update service entry.' });
  }
});

// Delete a service entry — within 5 min or admin override
app.delete('/api/service-entry/:id', requireAdminOrPartner, async (req, res) => {
  try {
    const isAdmin = !!(req.session && req.session.admin);
    const adminOverride = isAdmin && req.query.force === 'true';
    const result = await db.deleteServiceEntry(req.params.id, adminOverride);
    if (result.notFound) return res.status(404).json({ error: 'Entry not found.' });
    if (result.locked)   return res.status(403).json({ error: 'Edit window has expired.', locked: true });
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
    const { username, password, workshopName, phone } = req.body;
    if (!username || !password || !workshopName) {
      return res.status(400).json({ error: 'username, password, and workshopName are required.' });
    }
    if (await db.getPartnerByUsername(username)) {
      return res.status(409).json({ error: 'Username already exists.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const partner = await db.createPartner({ username, passwordHash, workshopName, phone });
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

// ==================== WARRANTY ====================

// Log a warranty claim (partner or admin)
app.post('/api/warranty-claim', requireAdminOrPartner, async (req, res) => {
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

// Get all warranty claims (admin inbox)
app.get('/api/admin/warranties', requireAdmin, async (req, res) => {
  try {
    res.json(await db.getAllWarranties());
  } catch (err) {
    console.error('[Get warranties error]', err);
    res.status(500).json({ error: 'Failed to load warranties.' });
  }
});

// Update warranty claim status
app.post('/api/admin/warranties/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status, adminNotes } = req.body;
    const valid = ['open', 'approved', 'rejected', 'closed'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    const claim = await db.updateWarrantyStatus(req.params.id, status, adminNotes);
    if (!claim) return res.status(404).json({ error: 'Claim not found.' });
    res.json({ success: true, claim });
  } catch (err) {
    console.error('[Update warranty error]', err);
    res.status(500).json({ error: 'Failed to update warranty.' });
  }
});

// Get service history by plate (partner + admin)
app.get('/api/service-history', requireAdminOrPartner, async (req, res) =