const path = require("node:path");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const passport = require("passport");
const { rateLimit } = require("express-rate-limit");
const { configurePassport } = require("./auth");
const { createDatabase } = require("./db");
const { SQLiteSessionStore } = require("./sqlite-session-store");
const { createMailer, enqueueEmail, flushEmailOutbox } = require("./email");
const { registerBusinessRoutes } = require("./business");

class ValidationError extends Error {}

function calendarDateInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}-${parts.find((part) => part.type === "day").value}`;
}

function createApp(options = {}) {
  const env = options.env || process.env;
  if (env.NODE_ENV === "production" && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) {
    throw new Error("SESSION_SECRET must contain at least 32 characters in production.");
  }
  if (env.TRUST_PROXY && env.TRUST_PROXY !== "0") {
    const hops = Number(env.TRUST_PROXY);
    if (!Number.isInteger(hops) || hops < 1) {
      throw new Error("TRUST_PROXY must be 0 or a positive integer.");
    }
  }
  const businessTimeZone = env.BUSINESS_TIME_ZONE || "Africa/Johannesburg";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: businessTimeZone });
  } catch {
    throw new Error("BUSINESS_TIME_ZONE must be a valid IANA time zone.");
  }

  const db = options.db || createDatabase(options.databasePath || env.DATABASE_PATH || "server/data/guesthouse.sqlite");
  const auth = options.passport || passport;
  configurePassport(auth, db, env);
  const mailer = options.mailer === undefined ? createMailer(env) : options.mailer;

  const app = express();
  const sessionDir = path.resolve(options.sessionDbDir || env.SESSION_DB_DIR || "server/data");
  require("node:fs").mkdirSync(sessionDir, { recursive: true });

  if (env.TRUST_PROXY && env.TRUST_PROXY !== "0") {
    app.set("trust proxy", Number(env.TRUST_PROXY));
  }
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://www.googletagmanager.com", "https://maps.googleapis.com", "https://maps.gstatic.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://www.google-analytics.com", "https://*.googleapis.com"],
        fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "data:"],
        frameSrc: ["https://www.google.com"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: env.NODE_ENV === "production" ? [] : null
      }
    }
  }));
  app.use("/api/payments/yoco/webhook", express.raw({ type: "application/json", limit: "32kb" }));
  app.use(express.json({ limit: "32kb" }));
  app.use(session({
    name: "ngqamakwe.sid",
    store: options.sessionStore || new SQLiteSessionStore({
      db: "sessions.sqlite",
      dir: sessionDir
    }),
    secret: options.sessionSecret || env.SESSION_SECRET || "local-development-secret-change-before-deploy",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  }));
  app.use(auth.initialize());
  app.use(auth.session());

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: "draft-8",
    legacyHeaders: false
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false
  });
  app.use("/api", apiLimiter);

  function finishOAuthLogin(req, res, next, error, user, linking = false) {
    if (error) {
      console.error("OAuth callback failed:", error.message);
      delete req.session.identityLinkProvider;
      delete req.session.identityLinkUserId;
      delete req.session.identityLinkStartedAt;
      return res.redirect(linking ? "/login.html?error=link_failed" : "/login.html?error=sign_in_failed");
    }
    if (!user) {
      delete req.session.identityLinkProvider;
      delete req.session.identityLinkUserId;
      delete req.session.identityLinkStartedAt;
      return res.redirect(linking ? "/login.html?error=link_failed" : "/login.html?error=sign_in_failed");
    }
    if (linking) {
      if (req.user?.id !== user.id || req.session.identityLinkUserId !== user.id) {
        return next(new Error("Identity link did not match the signed-in account."));
      }
      delete req.session.identityLinkProvider;
      delete req.session.identityLinkUserId;
      delete req.session.identityLinkStartedAt;
      return req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.redirect("/login.html?account_linked=1");
      });
    }
    req.logIn(user, (loginError) => {
      if (loginError) return next(loginError);
      req.session.authenticatedAt = Date.now();
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.redirect("/login.html?authenticated=1");
      });
    });
  }

  app.get("/api/health", (req, res) => res.json({ status: "ok" }));

  app.get("/auth/google", authLimiter, (req, res, next) => {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return res.status(503).json({ error: "Google sign-in is not configured." });
    }
    if (req.query.intent === "link") {
      if (!req.isAuthenticated?.() || req.user.status !== "active") {
        return res.status(401).send("Sign in before linking an identity.");
      }
      const authenticatedAt = Number(req.session.authenticatedAt);
      if (!Number.isFinite(authenticatedAt) || Date.now() - authenticatedAt > 10 * 60 * 1000) {
        return res.redirect("/login.html?error=reauthentication_required");
      }
      req.session.identityLinkProvider = "google";
      req.session.identityLinkUserId = req.user.id;
      req.session.identityLinkStartedAt = Date.now();
      return req.session.save((error) => {
        if (error) return next(error);
        auth.authenticate("google", { scope: ["profile", "email"], state: true })(req, res, next);
      });
    }
    auth.authenticate("google", { scope: ["profile", "email"], state: true })(req, res, next);
  });
  app.get("/auth/google/callback", authLimiter, (req, res, next) => {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return res.status(503).json({ error: "Google sign-in is not configured." });
    }
    const linking = req.session.identityLinkProvider === "google";
    auth.authenticate("google", {}, (error, user) =>
      finishOAuthLogin(req, res, next, error, user, linking)
    )(req, res, next);
  });
  app.get("/auth/facebook", authLimiter, (req, res, next) => {
    if (!env.FACEBOOK_APP_ID || !env.FACEBOOK_APP_SECRET) {
      return res.status(503).json({ error: "Facebook sign-in is not configured." });
    }
    if (req.query.intent === "link") {
      if (!req.isAuthenticated?.() || req.user.status !== "active") {
        return res.status(401).send("Sign in before linking an identity.");
      }
      const authenticatedAt = Number(req.session.authenticatedAt);
      if (!Number.isFinite(authenticatedAt) || Date.now() - authenticatedAt > 10 * 60 * 1000) {
        return res.redirect("/login.html?error=reauthentication_required");
      }
      req.session.identityLinkProvider = "facebook";
      req.session.identityLinkUserId = req.user.id;
      req.session.identityLinkStartedAt = Date.now();
      return req.session.save((error) => {
        if (error) return next(error);
        auth.authenticate("facebook", { scope: ["email"], state: true })(req, res, next);
      });
    }
    auth.authenticate("facebook", { scope: ["email"], state: true })(req, res, next);
  });
  app.get("/auth/facebook/callback", authLimiter, (req, res, next) => {
    if (!env.FACEBOOK_APP_ID || !env.FACEBOOK_APP_SECRET) {
      return res.status(503).json({ error: "Facebook sign-in is not configured." });
    }
    const linking = req.session.identityLinkProvider === "facebook";
    auth.authenticate("facebook", {}, (error, user) =>
      finishOAuthLogin(req, res, next, error, user, linking)
    )(req, res, next);
  });

  function requireSameOrigin(req, res, next) {
    const origin = req.get("origin");
    if (origin) {
      try {
        if (new URL(origin).origin !== `${req.protocol}://${req.get("host")}`) {
          return res.status(403).json({ error: "Cross-origin request rejected." });
        }
      } catch {
        return res.status(403).json({ error: "Invalid request origin." });
      }
    }
    next();
  }
  app.use("/api", (req, res, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      if (req.path === "/payments/yoco/webhook") return next();
      return requireSameOrigin(req, res, next);
    }
    next();
  });

  function requireAuth(req, res, next) {
    if (!req.isAuthenticated?.()) return res.status(401).json({ error: "Authentication required." });
    if (req.user.status !== "active") return res.status(403).json({ error: "Account is disabled." });
    next();
  }
  function requireAdmin(req, res, next) {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Administrator access required." });
    next();
  }
  function requireRecentAuthentication(req, res, next) {
    const authenticatedAt = Number(req.session?.authenticatedAt);
    if (!Number.isFinite(authenticatedAt) || Date.now() - authenticatedAt > 10 * 60 * 1000) {
      return res.status(403).json({ error: "Sign out and sign in again before changing linked sign-in methods." });
    }
    next();
  }
  function validateText(value, name, max, { optional = false } = {}) {
    if (optional && (value === undefined || value === null || value === "")) return "";
    if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
      throw new ValidationError(`${name} is required and must be at most ${max} characters.`);
    }
    return value.trim();
  }
  function validateEmail(value) {
    const email = validateText(value, "Email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("A valid email address is required.");
    return email;
  }
  function handleValidation(handler) {
    return (req, res, next) => {
      try {
        handler(req, res, next);
      } catch (error) {
        if (error instanceof ValidationError) {
          return res.status(400).json({ error: error.message });
        }
        next(error);
      }
    };
  }
  function requirePositiveId(req, res, next) {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid record ID." });
    req.recordId = id;
    next();
  }

  app.get("/api/me", (req, res) => {
    if (!req.isAuthenticated?.() || req.user.status !== "active") {
      return res.status(401).json({ error: "Authentication required." });
    }
    res.json({ user: req.user });
  });
  app.get("/api/account/identities", requireAuth, (req, res) => {
    const identities = db.prepare("SELECT provider, created_at FROM identities WHERE user_id = ? ORDER BY provider").all(req.user.id);
    res.json({ identities });
  });
  app.delete("/api/account/identities/:provider", requireAuth, requireRecentAuthentication, (req, res) => {
    const provider = req.params.provider;
    if (!["google", "facebook"].includes(provider)) {
      return res.status(400).json({ error: "Unsupported identity provider." });
    }
    const count = db.prepare("SELECT COUNT(*) AS count FROM identities WHERE user_id = ?").get(req.user.id).count;
    if (count <= 1) return res.status(409).json({ error: "Link another sign-in method before removing the last one." });
    const result = db.prepare("DELETE FROM identities WHERE user_id = ? AND provider = ?").run(req.user.id, provider);
    if (!result.changes) return res.status(404).json({ error: "Provider identity not linked." });
    db.prepare(`
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, details)
      VALUES (?, 'identity.unlinked', 'user', ?, ?)
    `).run(req.user.id, req.user.id, JSON.stringify({ provider }));
    res.status(204).end();
  });
  app.post("/api/logout", requireAuth, (req, res, next) => {
    req.logout((error) => {
      if (error) return next(error);
      req.session.destroy((destroyError) => {
        if (destroyError) return next(destroyError);
        res.clearCookie("ngqamakwe.sid", { httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production" });
        res.json({ success: true });
      });
    });
  });
  app.patch("/api/account/profile", requireAuth, handleValidation((req, res) => {
    const name = validateText(req.body.name, "Name", 120);
    const phone = validateText(req.body.phone, "Phone", 40, { optional: true });
    db.prepare("UPDATE users SET name = ?, phone = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, phone, req.user.id);
    res.json({ user: db.prepare("SELECT id, name, email, phone, role, status FROM users WHERE id = ?").get(req.user.id) });
  }));
  app.get("/api/account/bookings", requireAuth, (req, res) => {
    const bookings = db.prepare(`
      SELECT id, booking_type, booking_option, checkin_date, checkout_date,
        guests, children, status, quoted_total_cents, currency, payment_status,
        checked_in_at, checked_out_at, created_at
      FROM bookings WHERE user_id = ? ORDER BY created_at DESC
    `).all(req.user.id);
    res.json({ bookings });
  });
  app.post("/api/account/bookings/:id/cancel", requireAuth, requirePositiveId, (req, res) => {
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ? AND user_id = ?")
      .get(req.recordId, req.user.id);
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (db.prepare(`
      SELECT id FROM payments WHERE booking_id = ? AND purpose = 'accommodation'
        AND status IN ('created', 'pending') LIMIT 1
    `).get(booking.id)) {
      return res.status(409).json({ error: "A secure payment checkout is in progress. Contact the guest house before cancelling." });
    }
    const cancellation = db.transaction(() => {
      const result = db.prepare(`
        UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL, updated_at = datetime('now')
        WHERE id = ? AND user_id = ? AND payment_status != 'paid'
          AND (status = 'pending' OR (status = 'confirmed' AND checkin_date > ?))
      `).run(booking.id, req.user.id, calendarDateInZone(new Date(), businessTimeZone));
      if (!result.changes) return false;
      db.prepare(`
        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, details)
        VALUES (?, 'booking.guest_cancelled', 'booking', ?, '{}')
      `).run(req.user.id, booking.id);
      return true;
    })();
    if (!cancellation) {
      return res.status(409).json({ error: booking.payment_status === "paid"
        ? "Paid reservations require staff to review any cancellation or refund."
        : "This reservation cannot be cancelled online." });
    }
    db.prepare("DELETE FROM guest_notifications WHERE booking_id = ? AND scheduled_at > datetime('now')").run(booking.id);
    enqueueEmail(db, {
      recipient: booking.email,
      subject: `Booking ${booking.id} cancellation received`,
      text: `Hello ${booking.name},\n\nYour cancellation request for booking ${booking.id} has been recorded.`
    });
    if (mailer) flushEmailOutbox(db, mailer).catch((error) => console.error("Email delivery failed:", error));
    res.json({ success: true, status: "cancelled" });
  });

  app.get("/api/offerings", (req, res) => {
    res.json({ offerings: db.prepare(`
      SELECT id, category, name, description, price_cents, currency
      FROM offerings WHERE active = 1 ORDER BY category, name
    `).all() });
  });
  app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
    const users = db.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.role, u.status, u.staff_role, u.created_at,
        GROUP_CONCAT(i.provider) AS providers
      FROM users u LEFT JOIN identities i ON i.user_id = u.id
      GROUP BY u.id ORDER BY u.created_at DESC
    `).all();
    res.json({ users });
  });
  app.patch("/api/admin/users/:id", requireAuth, requireAdmin, requirePositiveId, handleValidation((req, res) => {
    const { role, status, staff_role: staffRole } = req.body || {};
    if (role !== undefined && !["customer", "staff", "admin"].includes(role)) throw new ValidationError("Invalid user role.");
    if (status !== undefined && !["active", "disabled"].includes(status)) throw new ValidationError("Invalid user status.");
    const allowedStaffRoles = ["director", "guest_relations_manager", "conference_coordinator", "general_worker", "housekeeping"];
    if (staffRole !== undefined && !allowedStaffRoles.includes(staffRole)) throw new ValidationError("Invalid staff role.");
    if (role === undefined && status === undefined && staffRole === undefined) throw new ValidationError("Provide a role, staff role, or status to update.");
    const target = db.prepare("SELECT role, status, staff_role FROM users WHERE id = ?").get(req.recordId);
    if (!target) return res.status(404).json({ error: "User not found." });
    const nextRole = role ?? target.role;
    const nextStatus = status ?? target.status;
    if (staffRole !== undefined && !["staff", "admin"].includes(nextRole)) {
      throw new ValidationError("Assign a staff role only to a staff member or administrator.");
    }
    if (target.role === "admin" && target.status === "active" &&
        (nextRole !== "admin" || nextStatus !== "active") &&
        db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'").get().count <= 1) {
      return res.status(409).json({ error: "Promote another active administrator before removing the last administrator." });
    }
    const result = db.prepare(`
      UPDATE users SET role = COALESCE(?, role), status = COALESCE(?, status),
        staff_role = COALESCE(?, staff_role),
        updated_at = datetime('now') WHERE id = ?
    `).run(role ?? null, status ?? null, staffRole ?? null, req.recordId);
    db.prepare(`
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, details)
      VALUES (?, 'user.access_updated', 'user', ?, ?)
    `).run(req.user.id, req.recordId, JSON.stringify({ role: nextRole, staff_role: staffRole ?? target.staff_role, status: nextStatus }));
    res.json({ user: db.prepare("SELECT id, name, email, phone, role, status, staff_role FROM users WHERE id = ?").get(req.recordId) });
  }));

  app.get("/api/admin/offerings", requireAuth, requireAdmin, (req, res) => {
    res.json({ offerings: db.prepare("SELECT * FROM offerings ORDER BY category, name").all() });
  });
  app.post("/api/admin/offerings", requireAuth, requireAdmin, handleValidation((req, res) => {
    const data = req.body || {};
    const category = validateText(data.category, "Category", 40);
    const name = validateText(data.name, "Name", 120);
    const description = validateText(data.description, "Description", 2000, { optional: true });
    const priceCents = data.price_cents == null || data.price_cents === "" ? null : Number(data.price_cents);
    if (priceCents !== null && (!Number.isSafeInteger(priceCents) || priceCents < 0)) {
      throw new ValidationError("Price must be a non-negative integer number of cents.");
    }
    const currency = validateText(data.currency || "ZAR", "Currency", 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError("Currency must be a three-letter code.");
    const result = db.prepare(`
      INSERT INTO offerings (category, name, description, price_cents, currency)
      VALUES (?, ?, ?, ?, ?)
    `).run(category, name, description, priceCents, currency);
    res.status(201).json({ offering: db.prepare("SELECT * FROM offerings WHERE id = ?").get(result.lastInsertRowid) });
  }));
  app.patch("/api/admin/offerings/:id", requireAuth, requireAdmin, requirePositiveId, handleValidation((req, res) => {
    const current = db.prepare("SELECT * FROM offerings WHERE id = ?").get(req.recordId);
    if (!current) return res.status(404).json({ error: "Offering not found." });
    const data = req.body || {};
    const category = data.category === undefined ? current.category : validateText(data.category, "Category", 40);
    const name = data.name === undefined ? current.name : validateText(data.name, "Name", 120);
    const description = data.description === undefined ? current.description : validateText(data.description, "Description", 2000, { optional: true });
    const priceCents = data.price_cents === undefined ? current.price_cents : (data.price_cents === null || data.price_cents === "" ? null : Number(data.price_cents));
    if (priceCents !== null && (!Number.isSafeInteger(priceCents) || priceCents < 0)) throw new ValidationError("Price must be a non-negative integer number of cents.");
    const currency = data.currency === undefined ? current.currency : validateText(data.currency, "Currency", 3).toUpperCase();
    const active = data.active === undefined ? current.active : (data.active === true || data.active === 1 ? 1 : data.active === false || data.active === 0 ? 0 : -1);
    if (!/^[A-Z]{3}$/.test(currency) || active < 0) throw new ValidationError("Invalid currency or active status.");
    db.prepare(`
      UPDATE offerings SET category = ?, name = ?, description = ?, price_cents = ?,
        currency = ?, active = ?, updated_at = datetime('now') WHERE id = ?
    `).run(category, name, description, priceCents, currency, active, req.recordId);
    res.json({ offering: db.prepare("SELECT * FROM offerings WHERE id = ?").get(req.recordId) });
  }));
  app.delete("/api/admin/offerings/:id", requireAuth, requireAdmin, requirePositiveId, (req, res) => {
    const result = db.prepare("UPDATE offerings SET active = 0, updated_at = datetime('now') WHERE id = ?")
      .run(req.recordId);
    if (!result.changes) return res.status(404).json({ error: "Offering not found." });
    res.status(204).end();
  });

  registerBusinessRoutes(app, { db, env, requireAuth, mailer, fetchImpl: options.fetchImpl || fetch });

  const webRoot = path.resolve(options.webRoot || path.join(__dirname, ".."));
  const pagePattern = /^\/(?:index|about|services|gallery|contact|bookings|login|staff)\.html$/;
  app.use((req, res, next) => {
    if (req.path === "/") req.url = "/index.html";
    if (pagePattern.test(req.path) || /^\/(?:css|js|images|assets)\//.test(req.path)) {
      return express.static(webRoot, { dotfiles: "deny", index: false })(req, res, next);
    }
    next();
  });

  app.use((req, res) => res.status(404).json({ error: "Not found." }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
      return res.status(400).json({ error: "Request body must be valid JSON." });
    }
    console.error(error);
    res.status(500).json({ error: "An unexpected server error occurred." });
  });
  app.locals.db = db;
  app.locals.mailer = mailer;
  return app;
}

module.exports = { createApp };
