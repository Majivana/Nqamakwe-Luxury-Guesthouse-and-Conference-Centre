const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

function createDatabase(filename) {
  if (filename !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  }

  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'staff', 'admin')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('google', 'facebook')),
      provider_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (provider, provider_id)
    );
  `);

  db.exec(`

    CREATE TABLE IF NOT EXISTS offerings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER,
      currency TEXT NOT NULL DEFAULT 'ZAR',
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      booking_type TEXT NOT NULL,
      booking_option TEXT NOT NULL,
      checkin_date TEXT NOT NULL,
      checkout_date TEXT NOT NULL,
      guests INTEGER NOT NULL CHECK (guests BETWEEN 1 AND 20),
      children INTEGER NOT NULL DEFAULT 0 CHECK (children BETWEEN 0 AND 20),
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      special_requests TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'in_progress', 'resolved')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inventory_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      units INTEGER NOT NULL CHECK (units > 0),
      max_guests INTEGER NOT NULL CHECK (max_guests > 0),
      price_per_unit_cents INTEGER CHECK (price_per_unit_cents IS NULL OR price_per_unit_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'ZAR',
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL DEFAULT 'ZAR',
      status TEXT NOT NULL DEFAULT 'created'
        CHECK (status IN ('created', 'pending', 'paid', 'failed', 'refunded', 'cancelled')),
      provider_reference TEXT UNIQUE,
      checkout_url TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      raw_notification TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_type TEXT NOT NULL CHECK (entry_type IN ('income', 'expense')),
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL DEFAULT 'ZAR',
      transaction_date TEXT NOT NULL,
      payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
      booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
      receipt_reference TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      text_body TEXT NOT NULL,
      html_body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS housekeeping_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
      resource_id INTEGER REFERENCES inventory_resources(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      due_date TEXT NOT NULL,
      assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS guest_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS business_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS breakfast_menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      dietary_tags TEXT NOT NULL DEFAULT '',
      available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS breakfast_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      menu_item_id INTEGER NOT NULL REFERENCES breakfast_menu_items(id) ON DELETE RESTRICT,
      service_date TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'ZAR',
      notes TEXT NOT NULL DEFAULT '',
      payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid', 'not_required')),
      status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'prepared', 'served', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS guest_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
      notification_type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT,
      audience TEXT NOT NULL DEFAULT 'guests' CHECK (audience IN ('guests', 'staff', 'all')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS staff_attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      clock_in_at TEXT NOT NULL DEFAULT (datetime('now')),
      clock_in_latitude REAL NOT NULL,
      clock_in_longitude REAL NOT NULL,
      clock_out_at TEXT,
      clock_out_latitude REAL,
      clock_out_longitude REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      review_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS staff_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      assignment TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS business_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'business',
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'staff' CHECK (visibility IN ('staff', 'guests', 'all')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
  if (!userColumns.has("notes")) db.exec("ALTER TABLE users ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
  if (!userColumns.has("marketing_consent")) {
    db.exec("ALTER TABLE users ADD COLUMN marketing_consent INTEGER NOT NULL DEFAULT 0 CHECK (marketing_consent IN (0, 1))");
  }
  if (!userColumns.has("staff_role")) {
    db.exec("ALTER TABLE users ADD COLUMN staff_role TEXT NOT NULL DEFAULT 'general_worker'");
  }
  const bookingColumns = new Set(db.prepare("PRAGMA table_info(bookings)").all().map((column) => column.name));
  if (!bookingColumns.has("resource_id")) db.exec("ALTER TABLE bookings ADD COLUMN resource_id INTEGER REFERENCES inventory_resources(id)");
  if (!bookingColumns.has("units_requested")) db.exec("ALTER TABLE bookings ADD COLUMN units_requested INTEGER NOT NULL DEFAULT 1");
  if (!bookingColumns.has("quoted_total_cents")) db.exec("ALTER TABLE bookings ADD COLUMN quoted_total_cents INTEGER");
  if (!bookingColumns.has("currency")) db.exec("ALTER TABLE bookings ADD COLUMN currency TEXT NOT NULL DEFAULT 'ZAR'");
  if (!bookingColumns.has("payment_status")) db.exec("ALTER TABLE bookings ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'");
  if (!bookingColumns.has("hold_expires_at")) db.exec("ALTER TABLE bookings ADD COLUMN hold_expires_at TEXT");
  if (!bookingColumns.has("confirmed_at")) db.exec("ALTER TABLE bookings ADD COLUMN confirmed_at TEXT");
  if (!bookingColumns.has("checked_in_at")) db.exec("ALTER TABLE bookings ADD COLUMN checked_in_at TEXT");
  if (!bookingColumns.has("checked_out_at")) db.exec("ALTER TABLE bookings ADD COLUMN checked_out_at TEXT");
  const paymentColumns = new Set(db.prepare("PRAGMA table_info(payments)").all().map((column) => column.name));
  if (!paymentColumns.has("purpose")) db.exec("ALTER TABLE payments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'accommodation'");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bookings_user_created
      ON bookings(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bookings_status_created
      ON bookings(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inquiries_status_created
      ON inquiries(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_offerings_active
      ON offerings(active, category);
    CREATE INDEX IF NOT EXISTS idx_bookings_resource_dates_status
      ON bookings(resource_id, checkin_date, checkout_date, status);
    CREATE INDEX IF NOT EXISTS idx_payments_booking_status
      ON payments(booking_id, status);
    CREATE INDEX IF NOT EXISTS idx_ledger_date_type
      ON ledger_entries(transaction_date, entry_type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_payment_unique
      ON ledger_entries(payment_id) WHERE payment_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_email_queue
      ON email_outbox(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_housekeeping_due
      ON housekeeping_tasks(due_date, status);
    CREATE INDEX IF NOT EXISTS idx_breakfast_date_status
      ON breakfast_orders(service_date, status);
    CREATE INDEX IF NOT EXISTS idx_guest_notifications_due
      ON guest_notifications(user_id, scheduled_at, read_at);
    CREATE INDEX IF NOT EXISTS idx_staff_attendance_user_open
      ON staff_attendance(user_id, clock_out_at);
    CREATE INDEX IF NOT EXISTS idx_leave_requests_dates
      ON leave_requests(start_date, end_date, status);
    CREATE INDEX IF NOT EXISTS idx_staff_schedules_dates
      ON staff_schedules(user_id, starts_at, ends_at);
    CREATE INDEX IF NOT EXISTS idx_business_events_dates
      ON business_events(starts_at, visibility);
  `);

  db.exec(`
    INSERT OR IGNORE INTO business_settings (key, value)
    VALUES ('automatic_booking_confirmation', '0');
    INSERT OR IGNORE INTO business_settings (key, value)
    VALUES ('checkin_time', '14:00'), ('checkout_time', '10:00'),
      ('breakfast_start', '07:00'), ('breakfast_end', '09:00');
  `);
  return db;
}

module.exports = { createDatabase };
