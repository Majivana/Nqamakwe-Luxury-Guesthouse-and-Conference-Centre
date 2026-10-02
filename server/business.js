const crypto = require("node:crypto");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { enqueueEmail, flushEmailOutbox } = require("./email");
const { createYocoCheckout, verifyYocoWebhook } = require("./yoco");

class ValidationError extends Error {}
class IntegrationError extends Error {}

function registerBusinessRoutes(app, { db, env, requireAuth, mailer, fetchImpl }) {
  const requireDirector = (req, res, next) => {
    if (req.user?.role !== "admin" && req.user?.staff_role !== "director") {
      return res.status(403).json({ error: "Director or administrator access required." });
    }
    next();
  };
  const staffRoles = {
    director: ["all"],
    guest_relations_manager: ["guest", "reservation", "announcement", "calendar", "leave", "schedule"],
    conference_coordinator: ["reservation", "conference", "inventory", "catalogue", "task", "calendar", "announcement", "schedule"],
    general_worker: ["task", "attendance", "schedule", "leave", "calendar"],
    housekeeping: ["task", "attendance", "schedule", "leave", "calendar"]
  };
  const requirePermission = (permission) => (req, res, next) => {
    if (!["staff", "admin"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Staff access required." });
    }
    const permissions = staffRoles[req.user.staff_role] || staffRoles.general_worker;
    if (req.user.role !== "admin" && !permissions.includes("all") && !permissions.includes(permission)) {
      return res.status(403).json({ error: `Your staff role cannot access ${permission} tools.` });
    }
    next();
  };
  const handle = (handler) => (req, res, next) => {
    const reject = (error) => {
      if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
      if (error instanceof IntegrationError) return res.status(503).json({ error: error.message });
      next(error);
    };
    try {
      const result = handler(req, res, next);
      if (result && typeof result.catch === "function") result.catch(reject);
    } catch (error) {
      reject(error);
    }
  };
  const text = (value, label, max, optional = false) => {
    if (optional && (value === undefined || value === null || value === "")) return "";
    if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
      throw new ValidationError(`${label} is required and must be at most ${max} characters.`);
    }
    return value.trim();
  };
  const email = (value) => {
    const result = text(value, "Email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new ValidationError("A valid email address is required.");
    return result;
  };
  const positiveId = (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid record ID." });
    req.recordId = id;
    next();
  };
  const validDate = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  const today = () => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: env.BUSINESS_TIME_ZONE || "Africa/Johannesburg",
      year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date());
    return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}-${parts.find((part) => part.type === "day").value}`;
  };
  const dayCount = (start, end) => Math.max(1, Math.ceil((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000));
  const guestTimes = () => {
    const settings = Object.fromEntries(db.prepare(`
      SELECT key, value FROM business_settings
      WHERE key IN ('checkin_time', 'checkout_time', 'breakfast_start', 'breakfast_end')
    `).all().map((row) => [row.key, row.value]));
    return {
      checkin_time: settings.checkin_time || "14:00",
      checkout_time: settings.checkout_time || "10:00",
      breakfast_start: settings.breakfast_start || "07:00",
      breakfast_end: settings.breakfast_end || "09:00"
    };
  };
  const audit = (actorId, action, type, id, details = {}) => {
    db.prepare(`
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(actorId || null, action, type, id || null, JSON.stringify(details));
  };
  const notifyStaff = (subject, textBody) => {
    if (env.STAFF_EMAIL) enqueueEmail(db, { recipient: env.STAFF_EMAIL, subject, text: textBody });
  };
  const notifyGuest = (recipient, subject, textBody) =>
    enqueueEmail(db, { recipient, subject, text: textBody });
  const scheduleMailFlush = () => {
    if (mailer) setImmediate(() => flushEmailOutbox(db, mailer).catch((error) => console.error("Email delivery failed:", error)));
  };
  const sendGuestMessage = (booking, subject, message) => {
    notifyGuest(booking.email, subject, message);
    scheduleMailFlush();
  };
  const businessLocalTime = (date, time) => {
    const [year, month, day] = date.split("-").map(Number);
    const [hour, minute] = time.split(":").map(Number);
    let timestamp = Date.UTC(year, month - 1, day, hour, minute);
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: env.BUSINESS_TIME_ZONE || "Africa/Johannesburg",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
      minute: "2-digit", hourCycle: "h23"
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
      const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
      const desired = Date.UTC(year, month - 1, day, hour, minute);
      const difference = desired - represented;
      if (!difference) break;
      timestamp += difference;
    }
    return new Date(timestamp).toISOString().slice(0, 19).replace("T", " ");
  };
  app.get("/api/staff/workforce", requireAuth, requirePermission("schedule"), (req, res) => {
    if (req.user.role !== "admin" && req.user.staff_role !== "director") {
      return res.status(403).json({ error: "Only the director can manage the staff directory." });
    }
    res.json({ staff: db.prepare(`
      SELECT id, name, email, staff_role FROM users
      WHERE role IN ('staff', 'admin') AND status = 'active'
      ORDER BY name
    `).all() });
  });
  const addDays = (date, count) => {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + count);
    return value.toISOString().slice(0, 10);
  };
  const scheduleStayNotifications = (booking) => {
    if (!booking.user_id || booking.status !== "confirmed") return;
    const times = guestTimes();
    const checkinTime = times.checkin_time;
    const checkoutTime = times.checkout_time;
    const breakfastStart = times.breakfast_start;
    const breakfastEnd = times.breakfast_end;
    const reminders = [
      {
        type: "checkin", date: addDays(booking.checkin_date, -1), time: "15:00",
        title: `Check-in tomorrow · reservation ${booking.id}`,
        message: `Check-in is from ${checkinTime}. Breakfast is served ${breakfastStart}–${breakfastEnd}.`
      },
      {
        type: "checkout", date: addDays(booking.checkout_date, -1), time: "18:00",
        title: `Checkout tomorrow · reservation ${booking.id}`,
        message: `Checkout is by ${checkoutTime}. Please let reception know if you need assistance.`
      }
    ];
    for (let date = booking.checkin_date; date < booking.checkout_date; date = addDays(date, 1)) {
      reminders.push({
        type: "breakfast", date: addDays(date, -1), time: "18:00",
        title: `Breakfast tomorrow · reservation ${booking.id}`,
        message: `Breakfast is served ${breakfastStart}–${breakfastEnd}. Choose from the breakfast menu in your account.`
      });
    }
    const insert = db.prepare(`
      INSERT INTO guest_notifications (user_id, booking_id, notification_type, title, message, scheduled_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const reminder of reminders) {
      insert.run(booking.user_id, booking.id, reminder.type, reminder.title, reminder.message,
        businessLocalTime(reminder.date, reminder.time));
    }
  };
  const hoursToHold = Number(env.PENDING_HOLD_HOURS || 24);
  if (!Number.isFinite(hoursToHold) || hoursToHold < 1 || hoursToHold > 168) {
    throw new Error("PENDING_HOLD_HOURS must be between 1 and 168.");
  }

  function unitsAvailable(resourceId, checkin, checkout, guests, units, excludeBookingId) {
    const resource = db.prepare(`
      SELECT id, slug, name, units, max_guests, price_per_unit_cents, currency
      FROM inventory_resources WHERE id = ? AND active = 1
    `).get(resourceId);
    if (!resource) return { resource: null, available_units: 0, available: false };
    const occupied = db.prepare(`
      SELECT COALESCE(SUM(units_requested), 0) AS units,
        COALESCE(SUM(guests), 0) AS guests
      FROM bookings
      WHERE resource_id = ?
        AND id != COALESCE(?, 0)
        AND checkin_date < ? AND checkout_date > ?
        AND (status = 'confirmed' OR
          (status = 'pending' AND (hold_expires_at IS NULL OR hold_expires_at > datetime('now'))))
    `).get(resourceId, excludeBookingId || null, checkout, checkin);
    const free = Math.max(0, resource.units - occupied.units);
    const capacityFree = Math.max(0, resource.units * resource.max_guests - occupied.guests);
    return {
      resource,
      available_units: free,
      available: free >= units && guests <= resource.max_guests * units && guests <= capacityFree
    };
  }

  function priceQuote(resource, start, end, units) {
    if (resource.price_per_unit_cents === null) return null;
    return resource.price_per_unit_cents * units * dayCount(start, end);
  }

  function enqueueBookingReceived(booking) {
    notifyGuest(booking.email, `Booking request ${booking.id} received`,
      `Hello ${booking.name},\n\nWe received your request for ${booking.booking_option} from ${booking.checkin_date} to ${booking.checkout_date}. It is ${booking.status}. We will contact you to confirm the arrangements.`);
    notifyStaff(`New booking request ${booking.id}`,
      `${booking.name} (${booking.email}) requested ${booking.booking_option}, ${booking.checkin_date} to ${booking.checkout_date}. Status: ${booking.status}.`);
    scheduleMailFlush();
  }

  const insertBooking = db.transaction((data, user) => {
    const resource = db.prepare("SELECT * FROM inventory_resources WHERE slug = ? COLLATE NOCASE AND active = 1")
      .get(data.booking_option);
    const units = data.units_requested;
    let status = "pending";
    let resourceId = null;
    let quotedTotal = null;
    let holdExpires = null;
    if (resource) {
      const availability = unitsAvailable(resource.id, data.checkin_date, data.checkout_date, data.guests + data.children, units);
      if (!availability.available) {
        return { unavailable: true, available_units: availability.available_units };
      }
      resourceId = resource.id;
      quotedTotal = priceQuote(resource, data.checkin_date, data.checkout_date, units);
      const autoConfirm = db.prepare("SELECT value FROM business_settings WHERE key = 'automatic_booking_confirmation'").get()?.value === "1";
      if (autoConfirm) status = "confirmed";
    }
    if (status === "pending") {
      holdExpires = new Date(Date.now() + hoursToHold * 3600000).toISOString().slice(0, 19).replace("T", " ");
    }
    const result = db.prepare(`
      INSERT INTO bookings (
        user_id, booking_type, booking_option, checkin_date, checkout_date,
        guests, children, name, email, phone, company, special_requests,
        status, resource_id, units_requested, quoted_total_cents, currency,
        hold_expires_at, confirmed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user?.status === "active" ? user.id : null, data.booking_type, data.booking_option,
      data.checkin_date, data.checkout_date, data.guests, data.children, data.name,
      data.email, data.phone, data.company, data.special_requests, status, resourceId,
      units, quotedTotal, resource?.currency || "ZAR", holdExpires,
      status === "confirmed" ? new Date().toISOString() : null
    );
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(result.lastInsertRowid);
    if (status === "confirmed") {
      scheduleStayNotifications(booking);
      const times = guestTimes();
      sendGuestMessage(booking, `Booking ${booking.id} confirmed`,
        `Hello ${booking.name},\n\nYour reservation for ${booking.booking_option} from ${booking.checkin_date} to ${booking.checkout_date} is confirmed. Check-in is from ${times.checkin_time}; checkout is by ${times.checkout_time}. Breakfast is served ${times.breakfast_start}–${times.breakfast_end}.`);
      notifyStaff(`Booking ${booking.id} automatically confirmed`, `${booking.name}: ${booking.booking_option}, ${booking.checkin_date} to ${booking.checkout_date}.`);
      scheduleMailFlush();
    } else {
      enqueueBookingReceived(booking);
    }
    audit(user?.id, "booking.created", "booking", booking.id, { status, resourceId });
    return { booking };
  });

  app.get("/api/availability", handle((req, res) => {
    const slug = text(req.query.resource, "Resource", 120);
    const { checkin, checkout } = req.query;
    const guests = Number(req.query.guests || 1);
    const units = Number(req.query.units || 1);
    if (!validDate(checkin) || !validDate(checkout) || checkout <= checkin || checkin < today()) {
      throw new ValidationError("Valid future check-in and later check-out dates are required.");
    }
    if (!Number.isInteger(guests) || guests < 1 || !Number.isInteger(units) || units < 1 || units > 20) {
      throw new ValidationError("Guest and unit counts must be positive whole numbers.");
    }
    const resource = db.prepare("SELECT id FROM inventory_resources WHERE slug = ? COLLATE NOCASE AND active = 1").get(slug);
    if (!resource) return res.status(404).json({ error: "This option is not configured in the property inventory." });
    const result = unitsAvailable(resource.id, checkin, checkout, guests, units);
    res.json({ resource: result.resource.name, available: result.available, available_units: result.available_units });
  }));
  app.get("/api/booking-options", (req, res) => {
    res.json({ options: db.prepare(`
      SELECT slug, category, name, description, price_per_unit_cents AS price_cents, currency
      FROM inventory_resources WHERE active = 1 ORDER BY category, name
    `).all() });
  });

  app.post("/api/bookings", rateLimit({
    windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false
  }), (req, res, next) => {
    try {
      const data = req.body || {};
      const bookingType = text(data.booking_type, "Booking type", 40);
      const bookingOption = text(data.booking_option, "Booking option", 120);
      const checkin = text(data.checkin_date, "Check-in date", 10);
      const checkout = text(data.checkout_date, "Check-out date", 10);
      if (!validDate(checkin) || !validDate(checkout) || checkout <= checkin || checkin < today()) {
        throw new ValidationError("Valid future check-in and later check-out dates are required.");
      }
      const guests = Number(data.guests);
      const children = Number(data.children || 0);
      const units = Number(data.units_requested || 1);
      if (!Number.isInteger(guests) || guests < 1 || guests > 200 ||
          !Number.isInteger(children) || children < 0 || children > 200 ||
          !Number.isInteger(units) || units < 1 || units > 20) {
        throw new ValidationError("Guest and unit counts must be whole numbers within the allowed range.");
      }
      const result = insertBooking({
        booking_type: bookingType, booking_option: bookingOption, checkin_date: checkin,
        checkout_date: checkout, guests, children, units_requested: units,
        name: text(data.name, "Name", 120), email: email(data.email),
        phone: text(data.phone, "Phone", 40), company: text(data.company, "Company", 160, true),
        special_requests: text(data.special_requests, "Special requests", 2000, true)
      }, req.user);
      if (result.unavailable) {
        return res.status(409).json({ error: "The selected option is not available for these dates.", available_units: result.available_units });
      }
      res.status(201).json({
        success: true, booking_id: result.booking.id, status: result.booking.status,
        total_cents: result.booking.quoted_total_cents, currency: result.booking.currency
      });
    } catch (error) {
      if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  app.post("/api/inquiries", rateLimit({
    windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false
  }), (req, res, next) => {
    try {
      const data = req.body || {};
      const subject = text(data.subject, "Subject", 40);
      if (!["accommodation", "conference", "dining", "general", "feedback"].includes(subject)) {
        throw new ValidationError("Select a valid inquiry subject.");
      }
      const name = text(data.name, "Name", 120);
      const guestEmail = email(data.email);
      const phone = text(data.phone, "Phone", 40, true);
      const message = text(data.message, "Message", 4000);
      const result = db.prepare(`
        INSERT INTO inquiries (user_id, name, email, phone, subject, message)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(req.user?.status === "active" ? req.user.id : null, name, guestEmail, phone, subject, message);
      notifyGuest(guestEmail, "We received your enquiry",
        `Hello ${name},\n\nThank you for contacting Ngqamakwe Luxury Guest House. Our team will respond as soon as possible.`);
      notifyStaff(`New guest enquiry: ${subject}`, `${name} (${guestEmail})\n${message}`);
      scheduleMailFlush();
      audit(req.user?.id, "inquiry.created", "inquiry", result.lastInsertRowid, { subject });
      res.status(201).json({ success: true, inquiry_id: Number(result.lastInsertRowid) });
    } catch (error) {
      if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  app.get("/api/breakfast/menu", (req, res) => {
    res.json({ menu: db.prepare(`
      SELECT id, name, description, price_cents, dietary_tags
      FROM breakfast_menu_items WHERE available = 1 ORDER BY name
    `).all() });
  });
  app.get("/api/property-info", (req, res) => {
    res.json({ times: guestTimes(), time_zone: env.BUSINESS_TIME_ZONE || "Africa/Johannesburg" });
  });
  app.get("/api/account/payments", requireAuth, (req, res) => {
    res.json({ payments: db.prepare(`
      SELECT p.id, p.booking_id, p.purpose, p.provider, p.amount_cents, p.currency,
        p.status, p.provider_reference, p.created_at, p.updated_at,
        b.booking_option, b.checkin_date, b.checkout_date
      FROM payments p JOIN bookings b ON b.id = p.booking_id
      WHERE p.user_id = ? ORDER BY p.created_at DESC LIMIT 200
    `).all(req.user.id) });
  });
  app.get("/api/account/notifications", requireAuth, (req, res) => {
    res.json({
      notifications: db.prepare(`
        SELECT id, booking_id, notification_type, title, message, scheduled_at, read_at
        FROM guest_notifications
        WHERE user_id = ? AND scheduled_at <= datetime('now')
        ORDER BY scheduled_at DESC LIMIT 100
      `).all(req.user.id),
      announcements: db.prepare(`
        SELECT id, title, message, starts_at, ends_at FROM announcements
        WHERE audience IN ('guests', 'all') AND starts_at <= datetime('now')
          AND (ends_at IS NULL OR ends_at >= datetime('now'))
        ORDER BY starts_at DESC LIMIT 50
      `).all()
    });
  });
  app.patch("/api/account/notifications/:id/read", requireAuth, positiveId, (req, res) => {
    const result = db.prepare(`
      UPDATE guest_notifications SET read_at = COALESCE(read_at, datetime('now'))
      WHERE id = ? AND user_id = ? AND scheduled_at <= datetime('now')
    `).run(req.recordId, req.user.id);
    if (!result.changes) return res.status(404).json({ error: "Notification not found." });
    res.json({ success: true });
  });
  app.get("/api/account/breakfast-orders", requireAuth, (req, res) => {
    res.json({ orders: db.prepare(`
      SELECT o.id, o.booking_id, o.service_date, o.quantity, o.unit_price_cents,
        o.currency, o.notes, o.payment_status, o.status, m.name AS item_name
      FROM breakfast_orders o JOIN breakfast_menu_items m ON m.id = o.menu_item_id
      WHERE o.user_id = ? ORDER BY o.service_date DESC, o.id DESC LIMIT 200
    `).all(req.user.id) });
  });
  app.post("/api/account/breakfast-orders", requireAuth, handle((req, res) => {
    const bookingId = Number(req.body?.booking_id);
    const menuItemId = Number(req.body?.menu_item_id);
    const quantity = Number(req.body?.quantity);
    const serviceDate = text(req.body?.service_date, "Breakfast date", 10);
    if (!Number.isSafeInteger(bookingId) || bookingId < 1 ||
        !Number.isSafeInteger(menuItemId) || menuItemId < 1 ||
        !Number.isInteger(quantity) || quantity < 1 || quantity > 20 ||
        !validDate(serviceDate) || serviceDate < today()) {
      throw new ValidationError("Select a valid stay, menu item, date, and quantity.");
    }
    const booking = db.prepare(`
      SELECT b.*, r.category AS resource_category
      FROM bookings b LEFT JOIN inventory_resources r ON r.id = b.resource_id
      WHERE b.id = ? AND b.user_id = ? AND b.status = 'confirmed'
    `).get(bookingId, req.user.id);
    if (!booking || serviceDate < booking.checkin_date || serviceDate >= booking.checkout_date) {
      throw new ValidationError("Breakfast orders are available only during a confirmed stay.");
    }
    if (booking.resource_category !== "accommodation") {
      throw new ValidationError("Breakfast orders require a confirmed accommodation reservation.");
    }
    const item = db.prepare("SELECT * FROM breakfast_menu_items WHERE id = ? AND available = 1").get(menuItemId);
    if (!item) return res.status(404).json({ error: "Breakfast menu item is unavailable." });
    const result = db.prepare(`
      INSERT INTO breakfast_orders
        (booking_id, user_id, menu_item_id, service_date, quantity, unit_price_cents, currency, notes, payment_status)
      VALUES (?, ?, ?, ?, ?, ?, 'ZAR', ?, ?)
    `).run(booking.id, req.user.id, item.id, serviceDate, quantity, item.price_cents,
      text(req.body?.notes, "Notes", 500, true), item.price_cents === 0 ? "not_required" : "unpaid");
    audit(req.user.id, "breakfast_order.created", "breakfast_order", result.lastInsertRowid, { booking_id: booking.id });
    res.status(201).json({
      order: db.prepare("SELECT * FROM breakfast_orders WHERE id = ?").get(result.lastInsertRowid),
      total_cents: item.price_cents * quantity,
      currency: "ZAR"
    });
  }));
  app.post("/api/account/breakfast-orders/:id/cancel", requireAuth, positiveId, handle((req, res) => {
    const checkout = db.prepare(`
      SELECT id FROM payments WHERE purpose = ? AND status IN ('created', 'pending') LIMIT 1
    `).get(`breakfast:${req.recordId}`);
    if (checkout) return res.status(409).json({ error: "A secure payment checkout is in progress. Contact the guest house before cancelling." });
    const result = db.prepare(`
      UPDATE breakfast_orders SET status = 'cancelled', updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND status = 'requested'
        AND payment_status IN ('unpaid', 'not_required') AND service_date > ?
    `).run(req.recordId, req.user.id, today());
    if (!result.changes) return res.status(409).json({ error: "This breakfast order can no longer be cancelled online." });
    audit(req.user.id, "breakfast_order.guest_cancelled", "breakfast_order", req.recordId);
    res.json({ success: true });
  }));
  app.post("/api/account/breakfast-orders/:id/payment", requireAuth, positiveId, handle(async (req, res, next) => {
    const order = db.prepare(`
      SELECT o.*, b.status AS booking_status, b.user_id AS booking_owner
      FROM breakfast_orders o JOIN bookings b ON b.id = o.booking_id
      WHERE o.id = ? AND o.user_id = ?
    `).get(req.recordId, req.user.id);
    if (!order) return res.status(404).json({ error: "Breakfast order not found." });
    if (order.status === "cancelled") throw new ValidationError("Cancelled breakfast orders cannot be paid.");
    const result = createPaymentHandler(false, {
      id: order.id,
      booking_id: order.booking_id,
      payment_status: order.payment_status,
      amount_cents: order.unit_price_cents * order.quantity
    });
    return result(req, res, next);
  }));
  app.post("/api/account/bookings/:id/change", requireAuth, positiveId, handle((req, res) => {
    const current = db.prepare("SELECT * FROM bookings WHERE id = ? AND user_id = ?").get(req.recordId, req.user.id);
    if (!current) return res.status(404).json({ error: "Booking not found." });
    if (!["pending", "confirmed"].includes(current.status) || current.payment_status === "paid" ||
        current.checked_in_at || current.checkin_date < today()) {
      return res.status(409).json({ error: "This reservation needs staff assistance to change." });
    }
    if (db.prepare(`
      SELECT id FROM payments WHERE booking_id = ? AND purpose = 'accommodation'
        AND status IN ('created', 'pending') LIMIT 1
    `).get(current.id)) {
      return res.status(409).json({ error: "A secure payment checkout is in progress. Contact the guest house before changing this reservation." });
    }
    const checkin = req.body?.checkin_date === undefined ? current.checkin_date : text(req.body.checkin_date, "Check-in date", 10);
    const checkout = req.body?.checkout_date === undefined ? current.checkout_date : text(req.body.checkout_date, "Check-out date", 10);
    const bookingOption = req.body?.booking_option === undefined ? current.booking_option : text(req.body.booking_option, "Booking option", 120);
    const guests = req.body?.guests === undefined ? current.guests : Number(req.body.guests);
    const children = req.body?.children === undefined ? current.children : Number(req.body.children);
    if (!validDate(checkin) || !validDate(checkout) || checkin < today() || checkout <= checkin ||
        !Number.isInteger(guests) || guests < 1 || guests > 200 ||
        !Number.isInteger(children) || children < 0 || children > 200) {
      throw new ValidationError("Choose valid future dates and guest counts.");
    }
    const mealOutsideStay = db.prepare(`
      SELECT id FROM breakfast_orders WHERE booking_id = ? AND status != 'cancelled'
        AND (service_date < ? OR service_date >= ?) LIMIT 1
    `).get(current.id, checkin, checkout);
    if (mealOutsideStay) throw new ValidationError("Cancel or reschedule breakfast orders before changing these stay dates.");
    const resource = db.prepare("SELECT * FROM inventory_resources WHERE slug = ? COLLATE NOCASE AND active = 1")
      .get(bookingOption);
    if (!resource) throw new ValidationError("Select an active accommodation, conference, dining, or activity option.");
    const changed = db.transaction(() => {
      const availability = unitsAvailable(resource.id, checkin, checkout, guests + children,
        current.units_requested, current.id);
      if (!availability.available) throw new ValidationError("The new dates or option do not have enough availability.");
      const quote = priceQuote(resource, checkin, checkout, current.units_requested);
      const hold = current.status === "pending"
        ? new Date(Date.now() + hoursToHold * 3600000).toISOString().slice(0, 19).replace("T", " ") : null;
      db.prepare(`
        UPDATE bookings SET booking_type = ?, booking_option = ?, resource_id = ?, checkin_date = ?, checkout_date = ?,
          guests = ?, children = ?, quoted_total_cents = ?, currency = ?, hold_expires_at = ?,
          updated_at = datetime('now') WHERE id = ?
      `).run(resource.category, bookingOption, resource.id, checkin, checkout, guests, children, quote, resource.currency, hold, current.id);
      db.prepare("DELETE FROM guest_notifications WHERE booking_id = ? AND scheduled_at > datetime('now')").run(current.id);
      const updated = db.prepare("SELECT * FROM bookings WHERE id = ?").get(current.id);
      scheduleStayNotifications(updated);
      return updated;
    })();
    audit(req.user.id, "booking.guest_changed", "booking", current.id, { booking_option: bookingOption, checkin, checkout });
    notifyStaff(`Guest changed reservation ${current.id}`, `${current.name} updated reservation ${current.id}. Review the new dates and option.`);
    sendGuestMessage(changed, `Reservation ${current.id} updated`, `Your reservation is now ${changed.booking_option}, ${checkin} to ${checkout}. Status: ${changed.status}.`);
    res.json({ booking: changed });
  }));
  app.post("/api/account/bookings/:id/check-in", requireAuth, positiveId, handle((req, res) => {
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ? AND user_id = ?").get(req.recordId, req.user.id);
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (booking.status !== "confirmed" || booking.checkin_date !== today() || booking.checked_in_at) {
      return res.status(409).json({ error: "Online check-in is available on your confirmed arrival date." });
    }
    db.prepare("UPDATE bookings SET checked_in_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(booking.id);
    audit(req.user.id, "booking.guest_checked_in", "booking", booking.id);
    notifyStaff(`Guest checked in for booking ${booking.id}`, `${booking.name} completed online check-in.`);
    res.json({ success: true, checked_in_at: db.prepare("SELECT checked_in_at FROM bookings WHERE id = ?").get(booking.id).checked_in_at });
  }));
  app.post("/api/account/bookings/:id/check-out", requireAuth, positiveId, handle((req, res) => {
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ? AND user_id = ?").get(req.recordId, req.user.id);
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (booking.status !== "confirmed" || !booking.checked_in_at || booking.checkout_date > today() || booking.checked_out_at) {
      return res.status(409).json({ error: "Online checkout is available after check-in on or after your checkout date." });
    }
    db.prepare(`
      UPDATE bookings SET checked_out_at = datetime('now'), status = 'completed', updated_at = datetime('now')
      WHERE id = ?
    `).run(booking.id);
    audit(req.user.id, "booking.guest_checked_out", "booking", booking.id);
    notifyStaff(`Guest checked out for booking ${booking.id}`, `${booking.name} completed online checkout. Please schedule room turnover.`);
    res.json({ success: true, status: "completed" });
  }));

  const siteCoordinates = () => {
    const latitude = Number(env.BUSINESS_LATITUDE);
    const longitude = Number(env.BUSINESS_LONGITUDE);
    const radius = Number(env.ATTENDANCE_RADIUS_METERS || 150);
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
        !Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
        !Number.isFinite(radius) || radius < 20 || radius > 2000) {
      throw new IntegrationError("On-site attendance location is not configured.");
    }
    return { latitude, longitude, radius };
  };
  const checkOnPremises = (body) => {
    const latitude = Number(body?.latitude);
    const longitude = Number(body?.longitude);
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
        !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
      throw new ValidationError("Allow precise location access to record on-site attendance.");
    }
    const site = siteCoordinates();
    const radians = (degrees) => degrees * Math.PI / 180;
    const deltaLatitude = radians(latitude - site.latitude);
    const deltaLongitude = radians(longitude - site.longitude);
    const angle = Math.sin(deltaLatitude / 2) ** 2 +
      Math.cos(radians(site.latitude)) * Math.cos(radians(latitude)) *
      Math.sin(deltaLongitude / 2) ** 2;
    const distance = 6371000 * 2 * Math.atan2(Math.sqrt(angle), Math.sqrt(1 - angle));
    if (distance > site.radius) throw new ValidationError("You must be on the guest-house premises to clock in or out.");
    return { latitude, longitude, distance: Math.round(distance) };
  };

  app.get("/api/staff/attendance", requireAuth, requirePermission("attendance"), (req, res) => {
    const open = db.prepare(`
      SELECT id, clock_in_at FROM staff_attendance
      WHERE user_id = ? AND clock_out_at IS NULL ORDER BY id DESC LIMIT 1
    `).get(req.user.id) || null;
    const history = db.prepare(`
      SELECT id, clock_in_at, clock_out_at FROM staff_attendance
      WHERE user_id = ? ORDER BY clock_in_at DESC LIMIT 30
    `).all(req.user.id);
    res.json({ open, history, site_configured: Boolean(env.BUSINESS_LATITUDE && env.BUSINESS_LONGITUDE) });
  });
  app.post("/api/staff/attendance/clock-in", requireAuth, requirePermission("attendance"), handle((req, res) => {
    const location = checkOnPremises(req.body);
    const open = db.prepare("SELECT id FROM staff_attendance WHERE user_id = ? AND clock_out_at IS NULL")
      .get(req.user.id);
    if (open) return res.status(409).json({ error: "You are already clocked in." });
    const result = db.prepare(`
      INSERT INTO staff_attendance (user_id, clock_in_latitude, clock_in_longitude)
      VALUES (?, ?, ?)
    `).run(req.user.id, location.latitude, location.longitude);
    audit(req.user.id, "attendance.clocked_in", "attendance", result.lastInsertRowid, { distance_meters: location.distance });
    res.status(201).json({ attendance_id: result.lastInsertRowid });
  }));
  app.post("/api/staff/attendance/clock-out", requireAuth, requirePermission("attendance"), handle((req, res) => {
    const location = checkOnPremises(req.body);
    const open = db.prepare(`
      SELECT id FROM staff_attendance WHERE user_id = ? AND clock_out_at IS NULL ORDER BY id DESC LIMIT 1
    `).get(req.user.id);
    if (!open) return res.status(409).json({ error: "You are not currently clocked in." });
    db.prepare(`
      UPDATE staff_attendance SET clock_out_at = datetime('now'),
        clock_out_latitude = ?, clock_out_longitude = ? WHERE id = ?
    `).run(location.latitude, location.longitude, open.id);
    audit(req.user.id, "attendance.clocked_out", "attendance", open.id, { distance_meters: location.distance });
    res.json({ success: true });
  }));
  app.get("/api/staff/leave", requireAuth, requirePermission("leave"), (req, res) => {
    const managers = req.user.role === "admin" || ["director", "guest_relations_manager"].includes(req.user.staff_role);
    const requests = db.prepare(`
      SELECT l.*, u.name AS staff_name FROM leave_requests l
      JOIN users u ON u.id = l.user_id
      WHERE (? = 1 OR l.user_id = ?)
      ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.start_date LIMIT 300
    `).all(managers ? 1 : 0, req.user.id);
    res.json({ requests, can_review: managers });
  });
  app.post("/api/staff/leave", requireAuth, requirePermission("leave"), handle((req, res) => {
    const start = text(req.body?.start_date, "Start date", 10);
    const end = text(req.body?.end_date, "End date", 10);
    const reason = text(req.body?.reason, "Reason", 1000);
    if (!validDate(start) || !validDate(end) || end < start || start < today()) {
      throw new ValidationError("Leave must have valid future dates.");
    }
    const result = db.prepare(`
      INSERT INTO leave_requests (user_id, start_date, end_date, reason)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, start, end, reason);
    audit(req.user.id, "leave.requested", "leave_request", result.lastInsertRowid, { start, end });
    notifyStaff(`Leave request from ${req.user.name}`, `${start} to ${end}: ${reason}`);
    res.status(201).json({ request_id: result.lastInsertRowid, status: "pending" });
  }));
  app.patch("/api/staff/leave/:id", requireAuth,
    requirePermission("leave"), positiveId, handle((req, res) => {
      if (req.user.role !== "admin" && !["director", "guest_relations_manager"].includes(req.user.staff_role)) {
        return res.status(403).json({ error: "Only management can review leave requests." });
      }
      const status = text(req.body?.status, "Status", 20);
      if (!["approved", "declined"].includes(status)) throw new ValidationError("Choose approved or declined.");
      const updated = db.prepare(`
        UPDATE leave_requests SET status = ?, review_note = ?, reviewed_by = ?,
          updated_at = datetime('now') WHERE id = ? AND status = 'pending'
      `).run(status, text(req.body?.review_note, "Review note", 500, true), req.user.id, req.recordId);
      if (!updated.changes) return res.status(404).json({ error: "Pending leave request not found." });
      const leave = db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(req.recordId);
      audit(req.user.id, `leave.${status}`, "leave_request", leave.id, { user_id: leave.user_id });
      const staff = db.prepare("SELECT email, name FROM users WHERE id = ?").get(leave.user_id);
      if (staff.email) {
        enqueueEmail(db, { recipient: staff.email, subject: `Leave request ${status}`, text: `Your leave request for ${leave.start_date} to ${leave.end_date} was ${status}.${leave.review_note ? ` Note: ${leave.review_note}` : ""}` });
        scheduleMailFlush();
      }
      res.json({ request: leave });
    }));
  app.get("/api/staff/schedule", requireAuth, requirePermission("schedule"), (req, res) => {
    const monday = req.query.from || addDays(today(), -((new Date(`${today()}T00:00:00Z`).getUTCDay() + 6) % 7));
    const sunday = addDays(monday, 7);
    if (!validDate(monday)) throw new ValidationError("Schedule start must be a valid date.");
    const canManage = req.user.role === "admin" || req.user.staff_role === "director";
    const userId = canManage && req.query.user_id ? Number(req.query.user_id) : req.user.id;
    if (!Number.isSafeInteger(userId) || userId < 1) throw new ValidationError("Invalid staff member.");
    const shifts = db.prepare(`
      SELECT s.*, u.name AS staff_name, u.staff_role FROM staff_schedules s
      JOIN users u ON u.id = s.user_id
      WHERE s.user_id = ? AND s.starts_at >= ? AND s.starts_at < ?
      ORDER BY s.starts_at
    `).all(userId, `${monday} 00:00:00`, `${sunday} 00:00:00`);
    res.json({ week_of: monday, shifts, can_manage: canManage });
  });
  app.post("/api/staff/schedule", requireAuth, requirePermission("schedule"), handle((req, res) => {
    if (req.user.role !== "admin" && req.user.staff_role !== "director") {
      return res.status(403).json({ error: "Only the director can publish staff schedules." });
    }
    const userId = Number(req.body?.user_id);
    const startsAt = text(req.body?.starts_at, "Shift start", 25);
    const endsAt = text(req.body?.ends_at, "Shift end", 25);
    if (!Number.isSafeInteger(userId) || !db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('staff', 'admin') AND status = 'active'").get(userId) ||
        !Number.isFinite(Date.parse(startsAt)) || !Number.isFinite(Date.parse(endsAt)) || endsAt <= startsAt) {
      throw new ValidationError("Select an active staff member and a valid shift range.");
    }
    const result = db.prepare(`
      INSERT INTO staff_schedules (user_id, starts_at, ends_at, assignment, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, startsAt, endsAt, text(req.body?.assignment, "Assignment", 200, true), req.user.id);
    audit(req.user.id, "schedule.shift_created", "staff_schedule", result.lastInsertRowid, { user_id: userId });
    res.status(201).json({ shift_id: result.lastInsertRowid });
  }));
  app.get("/api/staff/calendar", requireAuth, requirePermission("calendar"), (req, res) => {
    const from = req.query.from || today();
    const to = req.query.to || addDays(from, 30);
    if (!validDate(from) || !validDate(to) || to < from || dayCount(from, to) > 367) {
      throw new ValidationError("Calendar dates must span no more than one year.");
    }
    const bookings = db.prepare(`
      SELECT id, booking_option AS title, booking_type AS category, checkin_date AS starts_at,
        checkout_date AS ends_at, status, id AS booking_id
      FROM bookings WHERE status IN ('confirmed', 'pending') AND checkin_date <= ?
        AND checkout_date >= ? ORDER BY checkin_date LIMIT 500
    `).all(to, from);
    const events = db.prepare(`
      SELECT id, title, description, category, starts_at, ends_at, visibility, booking_id
      FROM business_events WHERE starts_at < ? AND ends_at >= ? ORDER BY starts_at LIMIT 500
    `).all(`${addDays(to, 1)} 00:00:00`, `${from} 00:00:00`);
    res.json({ bookings, events });
  });
  app.post("/api/staff/events", requireAuth, requirePermission("conference"), handle((req, res) => {
    const title = text(req.body?.title, "Event title", 120);
    const startsAt = text(req.body?.starts_at, "Event start", 25);
    const endsAt = text(req.body?.ends_at, "Event end", 25);
    if (!Number.isFinite(Date.parse(startsAt)) || !Number.isFinite(Date.parse(endsAt)) || endsAt <= startsAt) {
      throw new ValidationError("Event must have a valid start and end time.");
    }
    const visibility = req.body?.visibility || "staff";
    if (!["staff", "guests", "all"].includes(visibility)) throw new ValidationError("Invalid event visibility.");
    const result = db.prepare(`
      INSERT INTO business_events (title, description, category, starts_at, ends_at, visibility, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(title, text(req.body?.description, "Description", 2000, true),
      text(req.body?.category || "business", "Category", 40), startsAt, endsAt, visibility, req.user.id);
    audit(req.user.id, "business_event.created", "business_event", result.lastInsertRowid, { visibility });
    res.status(201).json({ event_id: result.lastInsertRowid });
  }));
  app.get("/api/staff/announcements", requireAuth, requirePermission("announcement"), (req, res) => {
    res.json({ announcements: db.prepare("SELECT * FROM announcements ORDER BY starts_at DESC LIMIT 200").all() });
  });
  app.post("/api/staff/announcements", requireAuth, requirePermission("announcement"), handle((req, res) => {
    const title = text(req.body?.title, "Announcement title", 120);
    const message = text(req.body?.message, "Message", 2000);
    const rawStart = req.body?.starts_at ? text(req.body.starts_at, "Start time", 25) : new Date().toISOString();
    const rawEnd = req.body?.ends_at ? text(req.body.ends_at, "End time", 25) : null;
    const startsAt = Number.isFinite(Date.parse(rawStart)) ? new Date(rawStart).toISOString().slice(0, 19).replace("T", " ") : rawStart;
    const endsAt = rawEnd && Number.isFinite(Date.parse(rawEnd)) ? new Date(rawEnd).toISOString().slice(0, 19).replace("T", " ") : rawEnd;
    const audience = req.body?.audience || "guests";
    if (!Number.isFinite(Date.parse(startsAt)) || (endsAt && (!Number.isFinite(Date.parse(endsAt)) || endsAt <= startsAt)) ||
        !["guests", "staff", "all"].includes(audience)) throw new ValidationError("Announcement times or audience are invalid.");
    const created = db.prepare(`
      INSERT INTO announcements (title, message, starts_at, ends_at, audience, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(title, message, startsAt, endsAt, audience, req.user.id);
    const recipients = audience === "all"
      ? db.prepare("SELECT id, email, role FROM users WHERE role IN ('customer', 'staff', 'admin') AND status = 'active'").all()
      : db.prepare("SELECT id, email, role FROM users WHERE role = ? AND status = 'active'").all(audience === "guests" ? "customer" : "staff");
    const notificationInsert = db.prepare(`
      INSERT INTO guest_notifications (user_id, notification_type, title, message, scheduled_at)
      VALUES (?, 'announcement', ?, ?, ?)
    `);
    const announcement = db.prepare("SELECT * FROM announcements WHERE id = ?").get(created.lastInsertRowid);
    for (const recipient of recipients) {
      notificationInsert.run(recipient.id, title, message, startsAt);
      if (recipient.email && recipient.role === "customer" && Date.parse(startsAt) <= Date.now()) {
        notifyGuest(recipient.email, title, message);
      }
    }
    audit(req.user.id, "announcement.created", "announcement", announcement.id, { audience });
    scheduleMailFlush();
    res.status(201).json({ announcement });
  }));
  app.get("/api/staff/breakfast-orders", requireAuth, requirePermission("guest"), (req, res) => {
    const date = req.query.date || today();
    if (!validDate(date)) throw new ValidationError("Breakfast date must use YYYY-MM-DD.");
    res.json({ orders: db.prepare(`
      SELECT o.*, m.name AS item_name, b.name AS guest_name, b.phone AS guest_phone
      FROM breakfast_orders o JOIN breakfast_menu_items m ON m.id = o.menu_item_id
      JOIN bookings b ON b.id = o.booking_id
      WHERE o.service_date = ? ORDER BY o.status, b.name
    `).all(date) });
  });
  app.get("/api/staff/breakfast-menu", requireAuth, requirePermission("guest"), (req, res) => {
    res.json({ menu: db.prepare("SELECT * FROM breakfast_menu_items ORDER BY available DESC, name").all() });
  });
  app.post("/api/staff/breakfast-menu", requireAuth, requirePermission("guest"), handle((req, res) => {
    const name = text(req.body?.name, "Menu item name", 120);
    const description = text(req.body?.description, "Description", 1000, true);
    const price = Number(req.body?.price_cents);
    if (!Number.isSafeInteger(price) || price < 0) throw new ValidationError("Menu price must be a non-negative amount in cents.");
    const result = db.prepare(`
      INSERT INTO breakfast_menu_items (name, description, price_cents, dietary_tags)
      VALUES (?, ?, ?, ?)
    `).run(name, description, price, text(req.body?.dietary_tags, "Dietary tags", 160, true));
    audit(req.user.id, "breakfast_menu.created", "breakfast_menu_item", result.lastInsertRowid);
    res.status(201).json({ item: db.prepare("SELECT * FROM breakfast_menu_items WHERE id = ?").get(result.lastInsertRowid) });
  }));
  app.patch("/api/staff/breakfast-menu/:id", requireAuth, requirePermission("guest"), positiveId, handle((req, res) => {
    const current = db.prepare("SELECT * FROM breakfast_menu_items WHERE id = ?").get(req.recordId);
    if (!current) return res.status(404).json({ error: "Breakfast menu item not found." });
    const active = req.body?.available === undefined ? current.available :
      (req.body.available === true || req.body.available === 1 ? 1 : req.body.available === false || req.body.available === 0 ? 0 : -1);
    if (active < 0) throw new ValidationError("Invalid menu availability.");
    const price = req.body?.price_cents === undefined ? current.price_cents : Number(req.body.price_cents);
    if (!Number.isSafeInteger(price) || price < 0) throw new ValidationError("Menu price must be a non-negative amount in cents.");
    db.prepare(`
      UPDATE breakfast_menu_items SET available = ?, price_cents = ?, updated_at = datetime('now') WHERE id = ?
    `).run(active, price, req.recordId);
    audit(req.user.id, "breakfast_menu.updated", "breakfast_menu_item", req.recordId, { available: active });
    res.json({ item: db.prepare("SELECT * FROM breakfast_menu_items WHERE id = ?").get(req.recordId) });
  }));
  app.patch("/api/staff/breakfast-orders/:id", requireAuth, requirePermission("guest"), positiveId, handle((req, res) => {
    const status = text(req.body?.status, "Status", 20);
    if (!["accepted", "prepared", "served", "cancelled"].includes(status)) {
      throw new ValidationError("Invalid breakfast order status.");
    }
    if (status === "cancelled" && db.prepare(`
      SELECT id FROM payments WHERE purpose = ? AND status IN ('created', 'pending') LIMIT 1
    `).get(`breakfast:${req.recordId}`)) {
      return res.status(409).json({ error: "A Yoco checkout is in progress. Wait for its result before cancelling this order." });
    }
    const result = db.prepare("UPDATE breakfast_orders SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, req.recordId);
    if (!result.changes) return res.status(404).json({ error: "Breakfast order not found." });
    audit(req.user.id, `breakfast_order.${status}`, "breakfast_order", req.recordId);
    res.json({ order: db.prepare("SELECT * FROM breakfast_orders WHERE id = ?").get(req.recordId) });
  }));
  app.get("/api/account/calendar", requireAuth, (req, res) => {
    const from = req.query.from || today();
    const to = req.query.to || addDays(from, 90);
    if (!validDate(from) || !validDate(to) || to < from || dayCount(from, to) > 367) {
      throw new ValidationError("Calendar dates must span no more than one year.");
    }
    res.json({
      bookings: db.prepare(`
        SELECT id, booking_option AS title, checkin_date AS starts_at, checkout_date AS ends_at, status
        FROM bookings WHERE user_id = ? AND checkin_date <= ? AND checkout_date >= ?
          AND status IN ('pending', 'confirmed') ORDER BY checkin_date
      `).all(req.user.id, to, from),
      events: db.prepare(`
        SELECT id, title, description, starts_at, ends_at FROM business_events
        WHERE visibility IN ('guests', 'all') AND starts_at < ? AND ends_at >= ?
        ORDER BY starts_at LIMIT 100
      `).all(`${addDays(to, 1)} 00:00:00`, `${from} 00:00:00`)
    });
  });

  app.get("/api/staff/session", requireAuth, (req, res) => {
    if (!["staff", "admin"].includes(req.user.role)) return res.status(403).json({ error: "Staff access required." });
    res.json({ user: req.user });
  });
  app.get("/api/staff/dashboard", requireAuth, requirePermission("calendar"), (req, res) => {
    const todayValue = today();
    const summary = {
      pending_bookings: db.prepare("SELECT COUNT(*) AS count FROM bookings WHERE status = 'pending'").get().count,
      arrivals_today: db.prepare("SELECT COUNT(*) AS count FROM bookings WHERE status = 'confirmed' AND checkin_date = ?").get(todayValue).count,
      departures_today: db.prepare("SELECT COUNT(*) AS count FROM bookings WHERE status = 'confirmed' AND checkout_date = ?").get(todayValue).count,
      new_inquiries: db.prepare("SELECT COUNT(*) AS count FROM inquiries WHERE status = 'new'").get().count,
      open_tasks: db.prepare("SELECT COUNT(*) AS count FROM housekeeping_tasks WHERE status IN ('open', 'in_progress')").get().count,
      queued_emails: db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE status IN ('queued', 'sending', 'failed')").get().count,
      upcoming_arrivals: db.prepare(`
        SELECT id, booking_option, checkin_date, checkout_date, guests, status
        FROM bookings WHERE status = 'confirmed' AND checkin_date >= ?
        ORDER BY checkin_date LIMIT 10
      `).all(todayValue)
    };
    res.json({ summary });
  });

  app.get("/api/staff/bookings", requireAuth, requirePermission("reservation"), (req, res) => {
    const status = req.query.status;
    const list = db.prepare(`
      SELECT b.*, r.name AS resource_name
      FROM bookings b LEFT JOIN inventory_resources r ON r.id = b.resource_id
      WHERE (? IS NULL OR b.status = ?)
      ORDER BY CASE b.status WHEN 'pending' THEN 0 ELSE 1 END, b.checkin_date DESC, b.id DESC
      LIMIT 500
    `).all(status || null, status || null);
    res.json({ bookings: list });
  });
  app.get("/api/admin/bookings", requireAuth, (req, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Administrator access required." });
    res.json({ bookings: db.prepare("SELECT * FROM bookings ORDER BY created_at DESC LIMIT 500").all() });
  });
  app.patch("/api/staff/bookings/:id", requireAuth, requirePermission("reservation"), positiveId, handle((req, res) => {
    const status = text(req.body?.status, "Status", 20);
    if (!["pending", "confirmed", "cancelled", "completed"].includes(status)) throw new ValidationError("Invalid booking status.");
    const update = db.transaction(() => {
      const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.recordId);
      if (!booking) return { missing: true };
      if (booking.status === status) return { booking };
      const allowedTransitions = {
        pending: ["confirmed", "cancelled"],
        confirmed: ["cancelled", "completed"],
        cancelled: [],
        completed: []
      };
      if (!allowedTransitions[booking.status]?.includes(status)) {
        throw new ValidationError(`A ${booking.status} reservation cannot be changed to ${status}.`);
      }
      if (status === "cancelled" && booking.payment_status === "paid") {
        throw new ValidationError("Paid reservations require refund review before staff can cancel them.");
      }
      if (status === "cancelled" && db.prepare(`
        SELECT id FROM payments WHERE booking_id = ? AND purpose = 'accommodation'
          AND status IN ('created', 'pending') LIMIT 1
      `).get(booking.id)) {
        throw new ValidationError("A Yoco checkout is in progress. Wait for its result before cancelling.");
      }
      if (status === "completed" && booking.checkout_date > today()) {
        throw new ValidationError("A reservation can only be completed after its checkout date.");
      }
      if (status === "cancelled" || status === "completed") {
        db.prepare("DELETE FROM guest_notifications WHERE booking_id = ? AND scheduled_at > datetime('now')").run(booking.id);
      }
      let resourceId = req.body?.resource_id === undefined ? booking.resource_id : Number(req.body.resource_id);
      if (status === "confirmed") {
        if (!resourceId || !Number.isSafeInteger(resourceId)) throw new ValidationError("Assign an active inventory resource before confirming.");
        const check = unitsAvailable(resourceId, booking.checkin_date, booking.checkout_date,
          booking.guests + booking.children, booking.units_requested, booking.id);
        if (!check.available) throw new ValidationError("Insufficient inventory or guest capacity for these dates.");
      }
      const resource = resourceId ? db.prepare("SELECT * FROM inventory_resources WHERE id = ? AND active = 1").get(resourceId) : null;
      if (status === "confirmed" && !resource) throw new ValidationError("The assigned inventory resource is not active.");
      const quote = status === "confirmed" && resource && resource.price_per_unit_cents !== null
        ? priceQuote(resource, booking.checkin_date, booking.checkout_date, booking.units_requested)
        : booking.quoted_total_cents;
      db.prepare(`
        UPDATE bookings SET status = ?, resource_id = ?, quoted_total_cents = ?,
          currency = COALESCE(?, currency),
          hold_expires_at = CASE WHEN ? = 'pending' THEN hold_expires_at ELSE NULL END,
          confirmed_at = CASE WHEN ? = 'confirmed' THEN datetime('now') ELSE confirmed_at END,
          updated_at = datetime('now') WHERE id = ?
      `).run(status, resourceId || null, quote, resource?.currency || null, status, status, booking.id);
      const updated = db.prepare("SELECT * FROM bookings WHERE id = ?").get(booking.id);
      audit(req.user.id, `booking.${status}`, "booking", booking.id, { from: booking.status, to: status, resourceId });
      if (status === "confirmed" && booking.status !== "confirmed") {
        scheduleStayNotifications(updated);
        const times = guestTimes();
        sendGuestMessage(updated, `Booking ${booking.id} confirmed`,
          `Hello ${updated.name},\n\nYour reservation for ${updated.booking_option} from ${updated.checkin_date} to ${updated.checkout_date} is confirmed. Check-in is from ${times.checkin_time}; checkout is by ${times.checkout_time}. Breakfast is served ${times.breakfast_start}–${times.breakfast_end}.${quote ? ` Total: ${(quote / 100).toFixed(2)} ${updated.currency}.` : ""}`);
      } else if (status === "cancelled" && booking.status !== "cancelled") {
        sendGuestMessage(updated, `Booking ${booking.id} cancelled`,
          `Hello ${updated.name},\n\nYour reservation request ${booking.id} for ${updated.checkin_date} to ${updated.checkout_date} has been cancelled.`);
      }
      return { booking: updated };
    });
    const result = update();
    if (result.missing) return res.status(404).json({ error: "Booking not found." });
    res.json({ booking: result.booking });
  }));

  app.get("/api/staff/inquiries", requireAuth, requirePermission("guest"), (req, res) => {
    const status = req.query.status;
    res.json({ inquiries: db.prepare(`
      SELECT * FROM inquiries WHERE (? IS NULL OR status = ?)
      ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, created_at DESC LIMIT 500
    `).all(status || null, status || null) });
  });
  app.patch("/api/staff/inquiries/:id", requireAuth, requirePermission("guest"), positiveId, handle((req, res) => {
    const status = text(req.body?.status, "Status", 20);
    if (!["new", "in_progress", "resolved"].includes(status)) throw new ValidationError("Invalid inquiry status.");
    const result = db.prepare("UPDATE inquiries SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, req.recordId);
    if (!result.changes) return res.status(404).json({ error: "Inquiry not found." });
    audit(req.user.id, `inquiry.${status}`, "inquiry", req.recordId, { status });
    res.json({ inquiry: db.prepare("SELECT * FROM inquiries WHERE id = ?").get(req.recordId) });
  }));

  app.get("/api/staff/inventory", requireAuth, requirePermission("inventory"), (req, res) => {
    res.json({ resources: db.prepare("SELECT * FROM inventory_resources ORDER BY category, name").all() });
  });
  app.post("/api/staff/inventory", requireAuth, requirePermission("inventory"), handle((req, res) => {
    const data = req.body || {};
    const slug = text(data.slug, "Slug", 120).toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new ValidationError("Slug must contain lowercase letters, numbers, and hyphens.");
    const units = Number(data.units);
    const maxGuests = Number(data.max_guests);
    const price = data.price_per_unit_cents === undefined || data.price_per_unit_cents === null || data.price_per_unit_cents === ""
      ? null : Number(data.price_per_unit_cents);
    if (!Number.isInteger(units) || units < 1 || units > 500 ||
        !Number.isInteger(maxGuests) || maxGuests < 1 || maxGuests > 500 ||
        (price !== null && (!Number.isSafeInteger(price) || price < 0))) {
      throw new ValidationError("Units, per-unit guest capacity, or price is invalid.");
    }
    const currency = text(data.currency || "ZAR", "Currency", 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError("Currency must be a three-letter code.");
    const result = db.prepare(`
      INSERT INTO inventory_resources (slug, category, name, description, units, max_guests, price_per_unit_cents, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(slug, text(data.category, "Category", 40), text(data.name, "Name", 120),
      text(data.description, "Description", 1000, true), units, maxGuests, price, currency);
    audit(req.user.id, "inventory.created", "inventory_resource", result.lastInsertRowid, { slug });
    res.status(201).json({ resource: db.prepare("SELECT * FROM inventory_resources WHERE id = ?").get(result.lastInsertRowid) });
  }));
  app.patch("/api/staff/inventory/:id", requireAuth, requirePermission("inventory"), positiveId, handle((req, res) => {
    const current = db.prepare("SELECT * FROM inventory_resources WHERE id = ?").get(req.recordId);
    if (!current) return res.status(404).json({ error: "Inventory resource not found." });
    const data = req.body || {};
    const slug = data.slug === undefined ? current.slug : text(data.slug, "Slug", 120).toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new ValidationError("Invalid inventory slug.");
    const units = data.units === undefined ? current.units : Number(data.units);
    const maxGuests = data.max_guests === undefined ? current.max_guests : Number(data.max_guests);
    const price = data.price_per_unit_cents === undefined ? current.price_per_unit_cents :
      (data.price_per_unit_cents === null || data.price_per_unit_cents === "" ? null : Number(data.price_per_unit_cents));
    if (!Number.isInteger(units) || units < 1 || units > 500 || !Number.isInteger(maxGuests) || maxGuests < 1 || maxGuests > 500 ||
        (price !== null && (!Number.isSafeInteger(price) || price < 0))) throw new ValidationError("Invalid capacity or price.");
    const active = data.active === undefined ? current.active : (data.active === true || data.active === 1 ? 1 : data.active === false || data.active === 0 ? 0 : -1);
    if (active < 0) throw new ValidationError("Invalid active value.");
    const currency = data.currency === undefined ? current.currency : text(data.currency, "Currency", 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError("Currency must be a three-letter code.");
    const committedBookings = db.prepare(`
      SELECT checkin_date FROM bookings
      WHERE resource_id = ? AND status = 'confirmed' AND checkout_date > date('now')
      ORDER BY checkin_date
    `).all(req.recordId);
    for (const booking of committedBookings) {
      const peak = db.prepare(`
        SELECT COALESCE(SUM(units_requested), 0) AS units,
          COALESCE(SUM(guests + children), 0) AS guests
        FROM bookings WHERE resource_id = ? AND status = 'confirmed'
          AND checkin_date <= ? AND checkout_date > ?
      `).get(req.recordId, booking.checkin_date, booking.checkin_date);
      if (peak.units > units || peak.guests > units * maxGuests) {
        throw new ValidationError("Capacity cannot be reduced below existing confirmed reservations.");
      }
    }
    db.prepare(`
      UPDATE inventory_resources SET slug = ?, category = ?, name = ?, description = ?,
        units = ?, max_guests = ?, price_per_unit_cents = ?, currency = ?, active = ?,
        updated_at = datetime('now') WHERE id = ?
    `).run(slug, data.category === undefined ? current.category : text(data.category, "Category", 40),
      data.name === undefined ? current.name : text(data.name, "Name", 120),
      data.description === undefined ? current.description : text(data.description, "Description", 1000, true),
      units, maxGuests, price,
      currency, active, req.recordId);
    audit(req.user.id, "inventory.updated", "inventory_resource", req.recordId, { slug });
    res.json({ resource: db.prepare("SELECT * FROM inventory_resources WHERE id = ?").get(req.recordId) });
  }));

  app.get("/api/staff/catalogue", requireAuth, requirePermission("catalogue"), (req, res) => {
    res.json({ offerings: db.prepare("SELECT * FROM offerings ORDER BY category, name").all() });
  });
  app.post("/api/staff/catalogue", requireAuth, requirePermission("catalogue"), handle((req, res) => {
    const data = req.body || {};
    const price = data.price_cents === undefined || data.price_cents === null || data.price_cents === ""
      ? null : Number(data.price_cents);
    if (price !== null && (!Number.isSafeInteger(price) || price < 0)) {
      throw new ValidationError("Price must be a non-negative integer number of cents.");
    }
    const currency = text(data.currency || "ZAR", "Currency", 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError("Currency must be a three-letter code.");
    const result = db.prepare(`
      INSERT INTO offerings (category, name, description, price_cents, currency)
      VALUES (?, ?, ?, ?, ?)
    `).run(text(data.category, "Category", 40), text(data.name, "Name", 120),
      text(data.description, "Description", 2000, true), price, currency);
    audit(req.user.id, "catalogue.created", "offering", result.lastInsertRowid);
    res.status(201).json({ offering: db.prepare("SELECT * FROM offerings WHERE id = ?").get(result.lastInsertRowid) });
  }));
  app.patch("/api/staff/catalogue/:id", requireAuth, requirePermission("catalogue"), positiveId, handle((req, res) => {
    const current = db.prepare("SELECT * FROM offerings WHERE id = ?").get(req.recordId);
    if (!current) return res.status(404).json({ error: "Catalogue item not found." });
    const data = req.body || {};
    const price = data.price_cents === undefined ? current.price_cents :
      (data.price_cents === null || data.price_cents === "" ? null : Number(data.price_cents));
    if (price !== null && (!Number.isSafeInteger(price) || price < 0)) {
      throw new ValidationError("Price must be a non-negative integer number of cents.");
    }
    const currency = data.currency === undefined ? current.currency : text(data.currency, "Currency", 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError("Currency must be a three-letter code.");
    const active = data.active === undefined ? current.active :
      (data.active === true || data.active === 1 ? 1 : data.active === false || data.active === 0 ? 0 : -1);
    if (active < 0) throw new ValidationError("Invalid active value.");
    db.prepare(`
      UPDATE offerings SET category = ?, name = ?, description = ?, price_cents = ?,
        currency = ?, active = ?, updated_at = datetime('now') WHERE id = ?
    `).run(data.category === undefined ? current.category : text(data.category, "Category", 40),
      data.name === undefined ? current.name : text(data.name, "Name", 120),
      data.description === undefined ? current.description : text(data.description, "Description", 2000, true),
      price, currency, active, req.recordId);
    audit(req.user.id, "catalogue.updated", "offering", req.recordId);
    res.json({ offering: db.prepare("SELECT * FROM offerings WHERE id = ?").get(req.recordId) });
  }));
  app.delete("/api/staff/catalogue/:id", requireAuth, requirePermission("catalogue"), positiveId, (req, res) => {
    const result = db.prepare("UPDATE offerings SET active = 0, updated_at = datetime('now') WHERE id = ?").run(req.recordId);
    if (!result.changes) return res.status(404).json({ error: "Catalogue item not found." });
    audit(req.user.id, "catalogue.deactivated", "offering", req.recordId);
    res.status(204).end();
  });

  app.get("/api/staff/guests", requireAuth, requirePermission("guest"), (req, res) => {
    const query = typeof req.query.q === "string" ? `%${req.query.q.trim().slice(0, 100)}%` : null;
    const guests = db.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.status, u.created_at,
        COUNT(DISTINCT b.id) AS booking_count,
        MAX(b.checkin_date) AS last_checkin
      FROM users u LEFT JOIN bookings b ON b.user_id = u.id
      WHERE u.role = 'customer' AND
        (? IS NULL OR u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)
      GROUP BY u.id ORDER BY u.created_at DESC LIMIT 300
    `).all(query, query, query, query);
    res.json({ guests });
  });
  app.get("/api/staff/guests/:id", requireAuth, requirePermission("guest"), positiveId, (req, res) => {
    const guest = db.prepare("SELECT id, name, email, phone, status, created_at FROM users WHERE id = ? AND role = 'customer'").get(req.recordId);
    if (!guest) return res.status(404).json({ error: "Guest not found." });
    res.json({
      guest,
      bookings: db.prepare("SELECT id, booking_option, checkin_date, checkout_date, status, quoted_total_cents, payment_status FROM bookings WHERE user_id = ? ORDER BY created_at DESC").all(req.recordId),
      notes: db.prepare("SELECT id, note, created_by, created_at FROM guest_notes WHERE user_id = ? ORDER BY created_at DESC").all(req.recordId)
    });
  });
  app.post("/api/staff/guests/:id/notes", requireAuth, requirePermission("guest"), positiveId, handle((req, res) => {
    const note = text(req.body?.note, "Note", 2000);
    const guest = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'customer'").get(req.recordId);
    if (!guest) return res.status(404).json({ error: "Guest not found." });
    const result = db.prepare("INSERT INTO guest_notes (user_id, note, created_by) VALUES (?, ?, ?)").run(req.recordId, note, req.user.id);
    audit(req.user.id, "guest.note_added", "guest", req.recordId);
    res.status(201).json({ note: db.prepare("SELECT * FROM guest_notes WHERE id = ?").get(result.lastInsertRowid) });
  }));
  app.patch("/api/staff/guests/:id", requireAuth, requirePermission("guest"), positiveId, handle((req, res) => {
    const current = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'customer'").get(req.recordId);
    if (!current) return res.status(404).json({ error: "Guest not found." });
    const name = req.body?.name === undefined ? current.name : text(req.body.name, "Name", 120);
    const phone = req.body?.phone === undefined ? current.phone : text(req.body.phone, "Phone", 40, true);
    if (req.body?.status !== undefined && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only administrators can disable guest accounts." });
    }
    const status = req.body?.status === undefined ? current.status : req.body.status;
    if (!["active", "disabled"].includes(status)) throw new ValidationError("Invalid guest status.");
    db.prepare("UPDATE users SET name = ?, phone = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, phone, status, req.recordId);
    audit(req.user.id, "guest.updated", "guest", req.recordId);
    res.json({ guest: db.prepare("SELECT id, name, email, phone, status FROM users WHERE id = ?").get(req.recordId) });
  }));

  app.get("/api/staff/tasks", requireAuth, requirePermission("task"), (req, res) => {
    res.json({ tasks: db.prepare(`
      SELECT t.*, u.name AS assigned_name, r.name AS resource_name
      FROM housekeeping_tasks t LEFT JOIN users u ON u.id = t.assigned_to
      LEFT JOIN inventory_resources r ON r.id = t.resource_id
      ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, t.due_date LIMIT 500
    `).all() });
  });
  app.post("/api/staff/tasks", requireAuth, requirePermission("task"), handle((req, res) => {
    const data = req.body || {};
    const due = text(data.due_date, "Due date", 10);
    if (!validDate(due)) throw new ValidationError("Due date must use YYYY-MM-DD.");
    const assigned = data.assigned_to == null || data.assigned_to === "" ? null : Number(data.assigned_to);
    if (assigned !== null && (!Number.isSafeInteger(assigned) || !db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('staff', 'admin') AND status = 'active'").get(assigned))) {
      throw new ValidationError("Select an active staff member.");
    }
    const result = db.prepare(`
      INSERT INTO housekeeping_tasks (booking_id, resource_id, title, description, due_date, assigned_to, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(data.booking_id ? Number(data.booking_id) : null, data.resource_id ? Number(data.resource_id) : null,
      text(data.title, "Task title", 120), text(data.description, "Description", 1000, true), due, assigned, req.user.id);
    audit(req.user.id, "task.created", "housekeeping_task", result.lastInsertRowid);
    res.status(201).json({ task: db.prepare("SELECT * FROM housekeeping_tasks WHERE id = ?").get(result.lastInsertRowid) });
  }));
  app.patch("/api/staff/tasks/:id", requireAuth, requirePermission("task"), positiveId, handle((req, res) => {
    const status = text(req.body?.status, "Status", 20);
    if (!["open", "in_progress", "done", "cancelled"].includes(status)) throw new ValidationError("Invalid task status.");
    const result = db.prepare("UPDATE housekeeping_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, req.recordId);
    if (!result.changes) return res.status(404).json({ error: "Task not found." });
    audit(req.user.id, `task.${status}`, "housekeeping_task", req.recordId);
    res.json({ task: db.prepare("SELECT * FROM housekeeping_tasks WHERE id = ?").get(req.recordId) });
  }));

  const reportRange = (req) => {
    const start = req.query.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const end = req.query.to || today();
    if (!validDate(start) || !validDate(end) || end < start || dayCount(start, end) > 367) {
      throw new ValidationError("Report dates must be valid and span no more than 367 days.");
    }
    return { start, end };
  };
  app.get("/api/staff/reports/summary", requireAuth, requirePermission("finance"), handle((req, res) => {
    const { start, end } = reportRange(req);
    const finance = db.prepare(`
      SELECT currency,
        SUM(CASE WHEN entry_type = 'income' THEN amount_cents ELSE 0 END) AS income_cents,
        SUM(CASE WHEN entry_type = 'expense' THEN amount_cents ELSE 0 END) AS expense_cents
      FROM ledger_entries WHERE transaction_date BETWEEN ? AND ? GROUP BY currency
    `).all(start, end).map((row) => ({ ...row, net_cents: row.income_cents - row.expense_cents }));
    const bookings = db.prepare(`
      SELECT status, COUNT(*) AS count FROM bookings
      WHERE date(created_at) BETWEEN ? AND ? GROUP BY status
    `).all(start, end);
    const outstanding = db.prepare(`
      SELECT currency, SUM(quoted_total_cents) AS amount_cents, COUNT(*) AS count
      FROM bookings WHERE status IN ('confirmed', 'completed') AND payment_status != 'paid'
        AND quoted_total_cents IS NOT NULL GROUP BY currency
    `).all();
    const occupancy = db.prepare(`
      SELECT r.id, r.name, r.units,
        COALESCE(SUM(b.units_requested * (
          julianday(MIN(b.checkout_date, date(?, '+1 day'))) -
          julianday(MAX(b.checkin_date, ?))
        )), 0) AS reserved_unit_nights,
        r.units * (julianday(date(?, '+1 day')) - julianday(?)) AS capacity_unit_nights
      FROM inventory_resources r LEFT JOIN bookings b ON b.resource_id = r.id
        AND b.status = 'confirmed' AND b.checkin_date <= ? AND b.checkout_date > ?
      WHERE r.active = 1 GROUP BY r.id ORDER BY r.name
    `).all(end, start, end, start, end, start);
    res.json({ range: { from: start, to: end }, finance, bookings, outstanding, occupancy });
  }));
  app.get("/api/staff/reports/financials", requireAuth, requirePermission("finance"), handle((req, res) => {
    const { start, end } = reportRange(req);
    const entries = db.prepare(`
      SELECT id, entry_type, category, description, amount_cents, currency, transaction_date,
        receipt_reference, booking_id, payment_id
      FROM ledger_entries WHERE transaction_date BETWEEN ? AND ?
      ORDER BY transaction_date DESC, id DESC LIMIT 1000
    `).all(start, end);
    res.json({ range: { from: start, to: end }, entries });
  }));
  app.get("/api/staff/reports/financials.csv", requireAuth, requirePermission("finance"), handle((req, res) => {
    const { start, end } = reportRange(req);
    const rows = db.prepare(`
      SELECT transaction_date, entry_type, category, description, amount_cents, currency, receipt_reference
      FROM ledger_entries WHERE transaction_date BETWEEN ? AND ? ORDER BY transaction_date DESC, id DESC
    `).all(start, end);
    const csv = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    res.type("text/csv").attachment(`financials-${start}-to-${end}.csv`)
      .send(["date,type,category,description,amount_cents,currency,reference",
        ...rows.map((row) => [row.transaction_date, row.entry_type, row.category, row.description,
          row.amount_cents, row.currency, row.receipt_reference].map(csv).join(","))].join("\r\n"));
  }));
  app.get("/api/staff/ledger", requireAuth, requirePermission("finance"), (req, res) => {
    res.json({ entries: db.prepare("SELECT * FROM ledger_entries ORDER BY transaction_date DESC, id DESC LIMIT 500").all() });
  });
  app.post("/api/staff/ledger", requireAuth, requirePermission("finance"), handle((req, res) => {
    const data = req.body || {};
    const entryType = text(data.entry_type, "Entry type", 20);
    if (!["income", "expense"].includes(entryType)) throw new ValidationError("Entry type must be income or expense.");
    const amount = Number(data.amount_cents);
    if (!Number.isSafeInteger(amount) || amount < 1) throw new ValidationError("Amount must be a positive integer number of cents.");
    const transactionDate = data.transaction_date || today();
    if (!validDate(transactionDate)) throw new ValidationError("Transaction date must use YYYY-MM-DD.");
    const currency = text(data.currency || "ZAR", "Currency", 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError("Invalid currency.");
    const result = db.prepare(`
      INSERT INTO ledger_entries (entry_type, category, description, amount_cents, currency, transaction_date, receipt_reference, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entryType, text(data.category, "Category", 80), text(data.description, "Description", 300),
      amount, currency, transactionDate, text(data.receipt_reference, "Reference", 120, true), req.user.id);
    audit(req.user.id, `ledger.${entryType}_recorded`, "ledger_entry", result.lastInsertRowid);
    res.status(201).json({ entry: db.prepare("SELECT * FROM ledger_entries WHERE id = ?").get(result.lastInsertRowid) });
  }));

  app.get("/api/staff/settings", requireAuth, requirePermission("finance"), (req, res) => {
    const settings = Object.fromEntries(db.prepare("SELECT key, value FROM business_settings").all().map((row) => [row.key, row.value]));
    res.json({ settings, integrations: { email: Boolean(mailer), yoco: Boolean(env.YOCO_SECRET_KEY && env.YOCO_WEBHOOK_SECRET) } });
  });
  app.patch("/api/staff/settings", requireAuth, requireDirector, handle((req, res) => {
    const data = req.body || {};
    const supported = ["checkin_time", "checkout_time", "breakfast_start", "breakfast_end"];
    let changed = false;
    if (data.automatic_booking_confirmation !== undefined) {
      if (typeof data.automatic_booking_confirmation !== "boolean") {
        throw new ValidationError("automatic_booking_confirmation must be true or false.");
      }
      const value = data.automatic_booking_confirmation ? "1" : "0";
      db.prepare(`
        INSERT INTO business_settings (key, value, updated_by) VALUES ('automatic_booking_confirmation', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')
      `).run(value, req.user.id);
      audit(req.user.id, "booking.auto_confirmation_changed", "business_setting", null, { enabled: value === "1" });
      changed = true;
    }
    for (const key of supported) {
      if (data[key] === undefined) continue;
      if (typeof data[key] !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(data[key])) {
        throw new ValidationError(`${key} must use 24-hour HH:MM time.`);
      }
      db.prepare(`
        INSERT INTO business_settings (key, value, updated_by) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')
      `).run(key, data[key], req.user.id);
      changed = true;
    }
    if (!changed) throw new ValidationError("Provide a business setting to update.");
    audit(req.user.id, "business.hours_updated", "business_setting", null, Object.fromEntries(supported.filter((key) => data[key] !== undefined).map((key) => [key, data[key]])));
    res.json({ settings: Object.fromEntries(db.prepare("SELECT key, value FROM business_settings").all().map((row) => [row.key, row.value])) });
  }));

  app.get("/api/staff/emails", requireAuth, requirePermission("guest"), (req, res) => {
    const status = ["queued", "sending", "sent", "failed"].includes(req.query.status) ? req.query.status : null;
    res.json({ emails: db.prepare(`
      SELECT id, recipient, subject, status, attempts, next_attempt_at, last_error, created_at, sent_at
      FROM email_outbox WHERE (? IS NULL OR status = ?) ORDER BY id DESC LIMIT 200
    `).all(status, status) });
  });
  app.post("/api/staff/emails/flush", requireAuth, requirePermission("guest"), handle(async (req, res) => {
    if (!mailer) throw new IntegrationError("SMTP email delivery is not configured.");
    const result = await flushEmailOutbox(db, mailer, 100);
    audit(req.user.id, "email_outbox.flushed", "email_outbox", null, result);
    res.json(result);
  }));
  app.post("/api/staff/emails/:id/retry", requireAuth, requirePermission("guest"), positiveId, handle((req, res) => {
    const result = db.prepare(`
      UPDATE email_outbox SET status = 'queued', attempts = 0, next_attempt_at = datetime('now'), last_error = ''
      WHERE id = ? AND status = 'failed'
    `).run(req.recordId);
    if (!result.changes) return res.status(404).json({ error: "Failed email not found." });
    res.json({ success: true });
  }));

  app.post("/api/account/bookings/:id/payment", requireAuth, positiveId, createPaymentHandler(false));
  app.post("/api/staff/bookings/:id/payment", requireAuth, requirePermission("reservation"), positiveId, createPaymentHandler(true));

  function createPaymentHandler(staffAccess, order = null) {
    return handle(async (req, res) => {
      const bookingId = order?.booking_id || req.recordId;
      const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
      if (!booking) return res.status(404).json({ error: "Booking not found." });
      if (!staffAccess && booking.user_id !== req.user.id) return res.status(404).json({ error: "Booking not found." });
      if (!order && booking.payment_status === "paid") throw new ValidationError("This reservation has already been paid.");
      if (order && order.payment_status === "paid") throw new ValidationError("This breakfast order has already been paid.");
      const amount = order?.amount_cents ?? booking.quoted_total_cents;
      if (!["confirmed", "completed"].includes(booking.status) || !amount) {
        throw new ValidationError("A confirmed booking with a quoted total is required to request payment.");
      }
      if (booking.currency !== "ZAR") throw new ValidationError("Yoco currently accepts ZAR payments only.");
      if (!env.YOCO_SECRET_KEY || !env.YOCO_WEBHOOK_SECRET) {
        throw new IntegrationError("Yoco checkout and webhook secrets must both be configured before accepting payment.");
      }
      const purpose = order ? `breakfast:${order.id}` : "accommodation";
      const suppliedKey = req.get("Idempotency-Key");
      let payment = suppliedKey
        ? db.prepare("SELECT * FROM payments WHERE idempotency_key = ?").get(text(suppliedKey, "Idempotency key", 100))
        : db.prepare(`
          SELECT * FROM payments WHERE booking_id = ? AND purpose = ?
            AND status IN ('created', 'pending')
          ORDER BY id DESC LIMIT 1
        `).get(booking.id, purpose);
      const idempotencyKey = suppliedKey ? text(suppliedKey, "Idempotency key", 100) : crypto.randomUUID();
      if (payment && (payment.booking_id !== booking.id || payment.purpose !== purpose ||
          payment.amount_cents !== amount)) throw new ValidationError("Idempotency key was already used.");
      const created = !payment;
      if (!payment) {
        const result = db.prepare(`
          INSERT INTO payments (booking_id, user_id, provider, amount_cents, currency, status, idempotency_key, purpose)
          VALUES (?, ?, 'yoco', ?, ?, 'pending', ?, ?)
        `).run(booking.id, booking.user_id, amount, booking.currency, idempotencyKey, purpose);
        payment = db.prepare("SELECT * FROM payments WHERE id = ?").get(result.lastInsertRowid);
      }
      let checkout;
      try {
        checkout = await createYocoCheckout({ env, payment, booking, fetchImpl });
      } catch (error) {
        if (error.message.includes("not configured") || error.message.includes("BASE_URL") ||
            error.message.includes("supports ZAR")) {
          throw new IntegrationError(error.message);
        }
        console.error("Yoco checkout creation failed:", error.message);
        throw new IntegrationError("Unable to start Yoco checkout. Please retry.");
      }
      db.prepare("UPDATE payments SET provider_reference = ?, checkout_url = ?, updated_at = datetime('now') WHERE id = ?")
        .run(checkout.id, checkout.url, payment.id);
      audit(req.user.id, "payment.checkout_created", "payment", payment.id, { booking_id: booking.id, provider: "yoco" });
      if (created) {
        enqueueEmail(db, {
          recipient: booking.email,
          subject: `Secure payment for booking ${booking.id}`,
          text: `Hello ${booking.name},\n\nUse the secure Yoco checkout to pay ${(payment.amount_cents / 100).toFixed(2)} ${payment.currency}: ${checkout.url}`
        });
        scheduleMailFlush();
      }
      res.status(201).json({
        payment_id: payment.id, amount_cents: payment.amount_cents,
        currency: payment.currency, url: checkout.url
      });
    });
  }

  app.post("/api/payments/yoco/webhook", handle((req, res) => {
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) return res.status(400).send("Invalid webhook body.");
    const eventId = req.get("webhook-id");
    const timestamp = req.get("webhook-timestamp");
    const signature = req.get("webhook-signature");
    if (!verifyYocoWebhook({
      secret: env.YOCO_WEBHOOK_SECRET, id: eventId, timestamp, signature, rawBody
    })) return res.status(400).send("Invalid webhook signature.");
    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid webhook event.");
    }
    if (!eventId || typeof event.id !== "string" || !event.payload ||
        !["payment.succeeded", "payment.failed"].includes(event.type)) {
      return res.status(200).send("Event acknowledged.");
    }
    const checkoutId = event.payload.metadata?.checkoutId;
    if (typeof checkoutId !== "string") return res.status(200).send("Unrelated event acknowledged.");
    const payment = db.prepare("SELECT * FROM payments WHERE provider = 'yoco' AND provider_reference = ?")
      .get(checkoutId);
    if (!payment) return res.status(200).send("Unrelated event acknowledged.");
    if (event.payload.amount !== payment.amount_cents || event.payload.currency !== payment.currency ||
        event.payload.type !== "payment") return res.status(400).send("Payment does not match.");
    const nextStatus = event.type === "payment.succeeded" ? "paid" : "failed";
    const update = db.transaction(() => {
      const inserted = db.prepare("INSERT OR IGNORE INTO webhook_events (id, provider) VALUES (?, 'yoco')").run(eventId);
      if (!inserted.changes) return { changed: false };
      const current = db.prepare("SELECT * FROM payments WHERE id = ?").get(payment.id);
      if (current.status === "paid") return { changed: false };
      db.prepare("UPDATE payments SET status = ?, raw_notification = ?, updated_at = datetime('now') WHERE id = ?")
        .run(nextStatus, rawBody.toString("utf8"), payment.id);
      if (nextStatus === "paid") {
        if (payment.purpose === "accommodation") {
          db.prepare("UPDATE bookings SET payment_status = 'paid', updated_at = datetime('now') WHERE id = ?").run(payment.booking_id);
        } else if (payment.purpose.startsWith("breakfast:")) {
          const orderId = Number(payment.purpose.slice("breakfast:".length));
          db.prepare("UPDATE breakfast_orders SET payment_status = 'paid', updated_at = datetime('now') WHERE id = ? AND booking_id = ?")
            .run(orderId, payment.booking_id);
        }
        const category = payment.purpose.startsWith("breakfast:") ? "dining" : "accommodation";
        db.prepare(`
          INSERT OR IGNORE INTO ledger_entries
            (entry_type, category, description, amount_cents, currency, transaction_date, payment_id, booking_id, receipt_reference)
          VALUES ('income', ?, ?, ?, ?, date('now'), ?, ?, ?)
        `).run(category, `Yoco payment for booking ${payment.booking_id}`, payment.amount_cents, payment.currency,
          payment.id, payment.booking_id, event.payload.id);
      }
      return { payment: db.prepare("SELECT * FROM payments WHERE id = ?").get(payment.id), changed: true };
    });
    const result = update();
    if (result.changed) audit(null, `payment.${nextStatus}`, "payment", payment.id, { booking_id: payment.booking_id });
    if (result.changed && nextStatus === "paid") {
      const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(payment.booking_id);
      sendGuestMessage(booking, `Payment received for booking ${booking.id}`,
        `Hello ${booking.name},\n\nWe received your payment of ${(payment.amount_cents / 100).toFixed(2)} ${payment.currency} for booking ${booking.id}.`);
    }
    res.status(200).send("OK");
  }));

  const dispatchDueNotifications = () => {
    const due = db.prepare(`
      SELECT n.id, n.user_id, n.title, n.message, u.email, u.role
      FROM guest_notifications n JOIN users u ON u.id = n.user_id
      WHERE n.delivered_at IS NULL AND n.scheduled_at <= datetime('now')
      ORDER BY n.scheduled_at LIMIT 100
    `).all();
    if (!due.length) return;
    const dispatch = db.transaction((items) => {
      for (const item of items) {
        const marked = db.prepare(`
          UPDATE guest_notifications SET delivered_at = datetime('now')
          WHERE id = ? AND delivered_at IS NULL
        `).run(item.id);
        if (marked.changes && item.role === "customer" && item.email) {
          enqueueEmail(db, { recipient: item.email, subject: item.title, text: item.message });
        }
      }
    });
    dispatch(due);
    if (mailer) flushEmailOutbox(db, mailer).catch((error) =>
      console.error("Scheduled guest notification delivery failed:", error.message));
  };
  const notificationWorker = setInterval(dispatchDueNotifications, 60000);
  notificationWorker.unref();
}

module.exports = { registerBusinessRoutes };
