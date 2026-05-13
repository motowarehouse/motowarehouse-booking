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
app.get('/api/slots', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });

  const d = new Date(date + 'T12:00:00');
  const day = d.getDay(); // 0=Sun, 6=Sat

  const hours = db.getHours();
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

  const booked = db.getBookedSlots(date);

  // If the requested date is today, filter out slots that are in the past
  const todayStr = new Date().toISOString().split('T')[0];
  let available = slots.filter(s => !booked.includes(s));
  if (date === todayStr) {
    const nowCyprus = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Nicosia' }));
    const nowMins = nowCyprus.getHours() * 60 + nowCyprus.getMinutes() + 30; // 30min buffer
    available = available.filter(s => {
      const [h, m] = s.split(':').map(Number);
      return h * 60 + m > nowMins;
    });
  }

  res.json({ slots: available, booked });
});

// Submit a new booking
app.post('/api/book', async (req, res) => {
  const { name, phone, email, serviceType, date, time, model, year, plate, km, notes, description } = req.body;

  const isOther = serviceType === 'other';
  const validServices = ['small-service', 'full-service', 'other'];

  // Base validation (applies to all service types)
  if (!name || !phone || !serviceType || !model || !year || !plate || !km) {
    return res.status(400).json({ error: 'All required fields must be filled.' });
  }

  if (!validServices.includes(serviceType)) {
    return res.status(400).json({ error: 'Invalid service type.' });
  }

  // For 'other' bookings: description required, no date/time needed
  if (isOther) {
    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'Please describe what service you need.' });
    }
  } else {
    // Normal bookings require date, time, and email
    if (!email || !date || !time) {
      return res.status(400).json({ error: 'All required fields must be filled.' });
    }
    // Check slot still available
    const booked = db.getBookedSlots(date);
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
    const booking = db.createBooking(bookingData);

    // Notify admin for all bookings
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
app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const bookings = db.getAllBookings().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(bookings);
});

// Accept a booking
app.post('/api/admin/bookings/:id/accept', requireAdmin, async (req, res) => {
  const booking = db.updateBookingStatus(req.params.id, 'accepted');
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
});

// Reschedule a booking
app.post('/api/admin/bookings/:id/reschedule', requireAdmin, async (req, res) => {
  const { date, time } = req.body;
  if (!date || !time) return res.status(400).json({ error: 'date and time required' });

  const booking = db.rescheduleBooking(req.params.id, date, time);
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
});

// Update contact status for cancelled / needs-call bookings
app.post('/api/admin/bookings/:id/contact-status', requireAdmin, (req, res) => {
  const { status } = req.body;
  const valid = ['needs-contact', 'needs-call', 'contacted', 'closed'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const booking = db.updateContactStatus(req.params.id, status);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  res.json({ success: true, booking });
});

// Cancel a booking
app.post('/api/admin/bookings/:id/cancel', requireAdmin, async (req, res) => {
  const booking = db.updateBookingStatus(req.params.id, 'cancelled');
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
});

// Complete a booking and write service history
app.post('/api/admin/bookings/:id/complete', requireAdmin, (req, res) => {
  const { regNo, km, items, notes, date } = req.body;
  if (!km) return res.status(400).json({ error: 'KM reading is required.' });

  const result = db.completeBooking(req.params.id, { regNo, km, items, notes, date });
  if (!result) return res.status(404).json({ error: 'Booking not found' });

  res.json({ success: true, booking: result.booking, serviceEntry: result.serviceEntry });
});

// Mark booking as no-show
app.post('/api/admin/bookings/:id/no-show', requireAdmin, (req, res) => {
  const booking = db.markNoShow(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  res.json({ success: true, booking });
});

// Get all blocks
app.get('/api/admin/blocks', requireAdmin, (req, res) => {
  const blocks = db.getAllBlocks().sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  res.json(blocks);
});

// Create a block
app.post('/api/admin/blocks', requireAdmin, (req, res) => {
  const { date, startTime, endTime, reason, customerName, customerPhone, vehicleModel, notes } = req.body;
  if (!date || !startTime || !endTime) {
    return res.status(400).json({ error: 'date, startTime, and endTime are required.' });
  }
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  if (sh * 60 + sm >= eh * 60 + em) {
    return res.status(400).json({ error: 'End time must be after start time.' });
  }
  const block = db.createBlock({ date, startTime, endTime, reason, customerName, customerPhone, vehicleModel, notes });
  res.json({ success: true, block });
});

// Delete a block
app.delete('/api/admin/blocks/:id', requireAdmin, (req, res) => {
  const ok = db.deleteBlock(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Block not found.' });
  res.json({ success: true });
});

// Get hours
app.get('/api/admin/hours', requireAdmin, (req, res) => {
  res.json(db.getHours());
});

// Save hours
app.post('/api/admin/hours', requireAdmin, (req, res) => {
  const { hours } = req.body;
  if (!hours) return res.status(400).json({ error: 'hours object required.' });
  db.saveHours(hours);
  res.json({ success: true });
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
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const partner = db.getPartnerByUsername(username);
  if (!partner || !partner.active) return res.status(401).json({ error: 'Invalid credentials.' });

  const valid = await bcrypt.compare(password, partner.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });

  req.session.partner = { id: partner.id, username: partner.username, workshopName: partner.workshopName };
  res.json({ success: true, workshopName: partner.workshopName });
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

// Look up vehicle by plate (partner + admin)
app.get('/api/vehicle', requireAdminOrPartner, (req, res) => {
  const { plate } = req.query;
  if (!plate) return res.status(400).json({ error: 'plate required' });
  const vehicle = db.getVehicleByPlate(plate);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found in our records.' });
  res.json(vehicle);
});

// Get service checklist items
app.get('/api/service-items', requireAdminOrPartner, (req, res) => {
  res.json(db.DEFAULT_SERVICE_ITEMS);
});

// Log a service entry (partner or admin)
app.post('/api/service-entry', requireAdminOrPartner, (req, res) => {
  const { regNo, km, items, notes, date } = req.body;
  if (!regNo || !km || !items || items.length === 0) {
    return res.status(400).json({ error: 'Plate, KM, and at least one service item are required.' });
  }
  if (!db.getVehicleByPlate(regNo)) {
    return res.status(404).json({ error: 'Vehicle not found in our records.' });
  }

  const isAdmin = !!(req.session && req.session.admin);
  const partnerInfo = req.session.partner || null;

  const entry = db.createServiceEntry({
    regNo, km, items, notes, date,
    partnerId:    partnerInfo ? partnerInfo.id : null,
    partnerName:  partnerInfo ? partnerInfo.workshopName : 'Motowarehouse',
    loggedByAdmin: isAdmin
  });

  res.json({ success: true, entry });
});

// Edit a service entry — allowed within 5 min, admin can override lock
app.put('/api/service-entry/:id', requireAdminOrPartner, (req, res) => {
  const { km, items, notes, adminOverride } = req.body;
  const isAdmin = !!(req.session && req.session.admin);
  const result = db.updateServiceEntry(req.params.id, {
    km, items, notes,
    adminOverride: isAdmin && adminOverride
  });
  if (result.notFound) return res.status(404).json({ error: 'Entry not found.' });
  if (result.locked)   return res.status(403).json({ error: 'Edit window has expired (5 minutes).', locked: true });
  res.json({ success: true, entry: result.entry });
});

// Delete a service entry — within 5 min or admin override
app.delete('/api/service-entry/:id', requireAdminOrPartner, (req, res) => {
  const isAdmin = !!(req.session && req.session.admin);
  const adminOverride = isAdmin && req.query.force === 'true';
  const result = db.deleteServiceEntry(req.params.id, adminOverride);
  if (result.notFound) return res.status(404).json({ error: 'Entry not found.' });
  if (result.locked)   return res.status(403).json({ error: 'Edit window has expired.', locked: true });
  res.json({ success: true });
});

// ==================== ADMIN - VEHICLES ====================

// Get all vehicles (paginated search)
app.get('/api/admin/vehicles', requireAdmin, (req, res) => {
  const { q } = req.query;
  let vehicles = db.getAllVehicles();
  if (q) {
    const search = q.toUpperCase().trim();
    vehicles = vehicles.filter(v =>
      v.regNo.includes(search) ||
      v.model.toUpperCase().includes(search) ||
      v.frameNo.toUpperCase().includes(search)
    );
  }
  res.json(vehicles.slice(0, 50));
});

// Get vehicle + full service + warranty history (admin only)
app.get('/api/admin/vehicles/:plate', requireAdmin, (req, res) => {
  const vehicle = db.getVehicleByPlate(req.params.plate);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });
  const history = db.getServiceHistoryByPlate(req.params.plate);
  const warranty = db.getWarrantyByPlate(req.params.plate);
  res.json({ vehicle, history, warranty });
});

// Import vehicles from JSON array (parsed from CSV/Excel by frontend)
app.post('/api/admin/vehicles/import', requireAdmin, (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows array required.' });
  }
  const result = db.importVehicles(rows);
  db.setSetting('lastVehicleImport', new Date().toISOString());
  res.json({ success: true, ...result });
});

app.get('/api/admin/vehicles/import-status', requireAdmin, (req, res) => {
  res.json({ lastImportAt: db.getSetting('lastVehicleImport') });
});

// ==================== ADMIN - PARTNERS ====================

// List all partners
app.get('/api/admin/partners', requireAdmin, (req, res) => {
  const partners = db.getAllPartners().map(p => ({ ...p, passwordHash: undefined }));
  res.json(partners);
});

// Create a partner
app.post('/api/admin/partners', requireAdmin, async (req, res) => {
  const { username, password, workshopName, phone } = req.body;
  if (!username || !password || !workshopName) {
    return res.status(400).json({ error: 'username, password, and workshopName are required.' });
  }
  if (db.getPartnerByUsername(username)) {
    return res.status(409).json({ error: 'Username already exists.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const partner = db.createPartner({ username, passwordHash, workshopName, phone });
  res.json({ success: true, partner: { ...partner, passwordHash: undefined } });
});

// Toggle partner active/inactive
app.post('/api/admin/partners/:id/toggle', requireAdmin, (req, res) => {
  const partner = db.togglePartnerActive(req.params.id);
  if (!partner) return res.status(404).json({ error: 'Partner not found.' });
  res.json({ success: true, partner: { ...partner, passwordHash: undefined } });
});

// Reset a partner's password (admin only)
app.post('/api/admin/partners/:id/reset-password', requireAdmin, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const passwordHash = await bcrypt.hash(newPassword, 10);
  const partner = db.updatePartnerPassword(req.params.id, passwordHash);
  if (!partner) return res.status(404).json({ error: 'Partner not found.' });
  res.json({ success: true });
});

// Partner changes their own password
// Partner changes own password (no session required — uses username + current password to authenticate)
app.post('/api/partner/change-password', async (req, res) => {
  const { username, currentPassword, newPassword } = req.body;
  if (!username || !currentPassword || !newPassword) return res.status(400).json({ error: 'All fields are required.' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const partner = db.getPartnerByUsername(username);
  if (!partner) return res.status(404).json({ error: 'Partner not found.' });
  const valid = await bcrypt.compare(currentPassword, partner.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });
  const passwordHash = await bcrypt.hash(newPassword, 10);
  db.updatePartnerPassword(partner.id, passwordHash);
  res.json({ success: true });
});

// Serve partner portal
app.get('/partner', (req, res) => {
  res.sendFile(path.join(__dirname, 'partner', 'index.html'));
});

// ==================== WARRANTY ====================

// Log a warranty claim (partner or admin)
app.post('/api/warranty-claim', requireAdminOrPartner, (req, res) => {
  const { regNo, frameNo, km, symptom, priority, engineDisassembly, defectAgreed, courtesyVehicle, notes, photos, mediaTypes } = req.body;
  if (!regNo || !symptom) {
    return res.status(400).json({ error: 'Registration number and symptom are required.' });
  }
  const isAdmin = !!(req.session && req.session.admin);
  const partnerInfo = req.session.partner || null;
  const claim = db.createWarrantyClaim({
    regNo, frameNo, km, symptom, priority,
    engineDisassembly, defectAgreed, courtesyVehicle, notes,
    photos:     Array.isArray(photos)     ? photos     : [],
    mediaTypes: Array.isArray(mediaTypes) ? mediaTypes : [],
    partnerId:    partnerInfo ? partnerInfo.id : null,
    partnerName:  partnerInfo ? partnerInfo.workshopName : 'Motowarehouse',
    loggedBy:     partnerInfo ? partnerInfo.workshopName : 'Motowarehouse',
    loggedByAdmin: isAdmin
  });
  // Notify admin by email (fire and forget)
  emailService.sendWarrantyAlert(claim).catch(e => console.error('[Email] Warranty alert failed:', e));
  res.json({ success: true, claim });
});

// Get all warranty claims (admin inbox)
app.get('/api/admin/warranties', requireAdmin, (req, res) => {
  res.json(db.getAllWarranties());
});

// Update warranty claim status
app.post('/api/admin/warranties/:id/status', requireAdmin, (req, res) => {
  const { status, adminNotes } = req.body;
  const valid = ['open', 'approved', 'rejected', 'closed'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const claim = db.updateWarrantyStatus(req.params.id, status, adminNotes);
  if (!claim) return res.status(404).json({ error: 'Claim not found.' });
  res.json({ success: true, claim });
});

// Get service history by plate (partner + admin)
app.get('/api/service-history', requireAdminOrPartner, (req, res) => {
  const { plate } = req.query;
  if (!plate) return res.status(400).json({ error: 'plate required' });
  const history = db.getServiceHistoryByPlate(plate);
  res.json(history);
});

// ==================== START ====================

startReminderCron();

app.listen(PORT, () => {
  console.log(`\n✅ Motowarehouse Service Portal running on http://localhost:${PORT}`);
  console.log(`   Admin panel: http://localhost:${PORT}/admin`);
  console.log(`   Partner portal: http://localhost:${PORT}/partner\n`);
});