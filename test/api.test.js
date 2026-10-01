const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const cookieSignature = require("cookie-signature");
const session = require("express-session");
const { Passport } = require("passport");
const request = require("supertest");
const { createApp } = require("../server/app");
const { buildVerifyCallback } = require("../server/auth");
const { createDatabase } = require("../server/db");
const { enqueueEmail, flushEmailOutbox } = require("../server/email");
const { SQLiteSessionStore } = require("../server/sqlite-session-store");
const { verifyYocoWebhook } = require("../server/yoco");

let app;
let db;
let temporaryDirectory;
let sessionStore;
const sessionSecret = "test-session-secret-that-is-long-enough";
const env = {
  NODE_ENV: "test",
  SESSION_SECRET: sessionSecret,
  BASE_URL: "http://localhost:3000",
  YOCO_SECRET_KEY: "sk_test_unit-test",
  YOCO_WEBHOOK_SECRET: `whsec_${Buffer.from("yoco-webhook-test-secret").toString("base64")}`,
  BUSINESS_LATITUDE: "-32.15",
  BUSINESS_LONGITUDE: "27.28",
  ATTENDANCE_RADIUS_METERS: "150",
  STAFF_EMAIL: "staff@example.com"
};

before(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ngqamakwe-api-"));
  const authenticator = new Passport();
  sessionStore = new session.MemoryStore();
  app = createApp({
    databasePath: path.join(temporaryDirectory, "test.sqlite"),
    sessionDbDir: temporaryDirectory,
    sessionSecret,
    sessionStore,
    passport: authenticator,
    env,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://payments.yoco.com/api/checkouts");
      const body = JSON.parse(options.body);
      return Response.json({
        id: `checkout-${body.clientReferenceId}`,
        amount: body.amount,
        currency: body.currency,
        redirectUrl: `https://c.yoco.com/checkout/${body.clientReferenceId}`
      });
    }
  });
  db = app.locals.db;
});

after(() => {
  db.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function makeUser(role = "customer", staffRole = "general_worker") {
  return Number(db.prepare("INSERT INTO users (name, email, role, staff_role) VALUES (?, ?, ?, ?)")
    .run(`${role} user`, `${role}-${crypto.randomUUID()}@example.com`, role, staffRole).lastInsertRowid);
}

function businessToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

function authenticatedRequestFor(application, store, secret, userId) {
  const id = crypto.randomBytes(24).toString("hex");
  const expires = new Date(Date.now() + 60 * 60 * 1000);
  store.set(id, {
    cookie: { originalMaxAge: 3600000, expires, secure: false, httpOnly: true, path: "/", sameSite: "lax" },
    passport: { user: userId },
    authenticatedAt: Date.now()
  }, (error) => assert.ifError(error));
  const cookie = `ngqamakwe.sid=${encodeURIComponent(`s:${cookieSignature.sign(id, secret)}`)}`;
  return {
    get: (url) => request(application).get(url).set("Cookie", cookie),
    post: (url) => request(application).post(url).set("Cookie", cookie),
    patch: (url) => request(application).patch(url).set("Cookie", cookie),
    delete: (url) => request(application).delete(url).set("Cookie", cookie)
  };
}

function authenticatedRequest(userId) {
  return authenticatedRequestFor(app, sessionStore, sessionSecret, userId);
}

test("health endpoint reports ready", async () => {
  const response = await request(app).get("/api/health");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: "ok" });
});

test("director can access workforce directory immediately after startup", async () => {
  const directorId = makeUser("staff", "director");
  const response = await authenticatedRequest(directorId).get("/api/staff/workforce");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.staff));
  assert.ok(response.body.staff.some((member) => member.id === directorId));
});

test("SQLite session store writes, reads, and destroys sessions", () => {
  const store = new SQLiteSessionStore({ dir: temporaryDirectory, db: "session-test.sqlite" });
  const value = { cookie: { maxAge: 60000 }, passport: { user: 7 } };
  store.set("session-id", value, (error) => assert.ifError(error));
  store.get("session-id", (error, result) => {
    assert.ifError(error);
    assert.deepEqual(result, value);
  });
  store.destroy("session-id", (error) => assert.ifError(error));
  store.get("session-id", (error, result) => {
    assert.ifError(error);
    assert.equal(result, null);
  });
  store.close();
});

test("SQLite startup migration is safe to rerun and preserves existing users", () => {
  const filename = path.join(temporaryDirectory, "upgrade.sqlite");
  const first = createDatabase(filename);
  const id = first.prepare("INSERT INTO users (name, email) VALUES (?, ?)").run("Existing guest", "existing@example.com").lastInsertRowid;
  first.close();
  const migrated = createDatabase(filename);
  assert.equal(migrated.prepare("SELECT name FROM users WHERE id = ?").get(id).name, "Existing guest");
  assert.ok(migrated.prepare("PRAGMA table_info(bookings)").all().some((column) => column.name === "resource_id"));
  assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'email_outbox'").get());
  migrated.close();
});

test("email outbox records successful delivery and retries temporary failures", async () => {
  const isolated = createDatabase(":memory:");
  const messageId = enqueueEmail(isolated, {
    recipient: "guest@example.com",
    subject: "Reservation update",
    text: "Your request is being processed."
  });
  let delivered = 0;
  const result = await flushEmailOutbox(isolated, {
    mailFrom: "Guest House <bookings@example.com>",
    async sendMail(message) {
      assert.equal(message.to, "guest@example.com");
      delivered += 1;
    }
  });
  assert.equal(result.sent, 1);
  assert.equal(delivered, 1);
  assert.equal(isolated.prepare("SELECT status FROM email_outbox WHERE id = ?").get(messageId).status, "sent");

  const failedId = enqueueEmail(isolated, {
    recipient: "guest@example.com", subject: "Follow up", text: "Please contact us."
  });
  const failed = await flushEmailOutbox(isolated, {
    mailFrom: "Guest House <bookings@example.com>",
    async sendMail() { throw new Error("SMTP temporarily unavailable"); }
  });
  assert.equal(failed.queued, 1);
  const retry = isolated.prepare("SELECT status, attempts, last_error FROM email_outbox WHERE id = ?").get(failedId);
  assert.equal(retry.status, "queued");
  assert.equal(retry.attempts, 1);
  assert.match(retry.last_error, /SMTP temporarily unavailable/);
  isolated.close();
});

test("unconfigured social providers return a clear unavailable response", async () => {
  const google = await request(app).get("/auth/google");
  const facebook = await request(app).get("/auth/facebook");
  assert.equal(google.status, 503);
  assert.equal(facebook.status, 503);
});

test("OAuth callback establishes a persistent authenticated session", async () => {
  const userId = Number(db.prepare("INSERT INTO users (name, email) VALUES (?, ?)")
    .run("OAuth guest", "oauth-guest@example.com").lastInsertRowid);
  const authenticator = new Passport();
  const oauthApp = createApp({
    db,
    passport: authenticator,
    sessionStore: new session.MemoryStore(),
    sessionSecret: "oauth-test-session-secret-long-enough",
    env: {
      NODE_ENV: "test",
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      GOOGLE_CALLBACK_URL: "http://localhost:3000/auth/google/callback"
    }
  });
  const browser = request.agent(oauthApp);
  const start = await browser.get("/auth/google");
  assert.equal(start.status, 302, start.text);
  const state = new URL(start.headers.location).searchParams.get("state");
  assert.ok(state);
  authenticator.use("google", {
    name: "google",
    authenticate() {
      this.success({ id: userId, name: "OAuth guest", email: "oauth-guest@example.com" });
    }
  });
  const callback = await browser.get(`/auth/google/callback?code=test&state=${encodeURIComponent(state)}`);
  const currentUser = await browser.get("/api/me");
  assert.equal(callback.status, 302);
  assert.match(callback.headers.location, /authenticated=1/);
  assert.equal(currentUser.status, 200);
  assert.equal(currentUser.body.user.id, userId);
});

test("production refuses weak session secrets and incomplete OAuth settings", () => {
  assert.throws(() => createApp({
    db,
    passport: new Passport(),
    env: { NODE_ENV: "production", SESSION_SECRET: "short" }
  }), /SESSION_SECRET/);
  assert.throws(() => createApp({
    db,
    passport: new Passport(),
    env: { NODE_ENV: "test", GOOGLE_CLIENT_ID: "client-id" }
  }), /both client ID and client secret/);
});

test("anonymous callers cannot use admin endpoints", async () => {
  const response = await request(app).get("/api/admin/users");
  assert.equal(response.status, 401);
});

test("cross-origin writes are rejected", async () => {
  const response = await request(app)
    .post("/api/inquiries")
    .set("Origin", "https://attacker.example")
    .send({ name: "Guest", email: "guest@example.com", subject: "general", message: "Hello" });
  assert.equal(response.status, 403);
});

test("malformed JSON is reported as a client error", async () => {
  const response = await request(app)
    .post("/api/inquiries")
    .set("Content-Type", "application/json")
    .send("{");
  assert.equal(response.status, 400);
  assert.match(response.body.error, /valid JSON/);
});

test("valid inquiry is persisted and starts as new", async () => {
  const response = await request(app)
    .post("/api/inquiries")
    .send({ name: "Guest", email: "GUEST@example.com", subject: "general", message: "A question" });
  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  const inquiry = db.prepare("SELECT email, status, message FROM inquiries WHERE id = ?")
    .get(response.body.inquiry_id);
  assert.deepEqual(inquiry, { email: "guest@example.com", status: "new", message: "A question" });
});

test("booking input is validated before persistence", async () => {
  const response = await request(app)
    .post("/api/bookings")
    .send({
      booking_type: "accommodation",
      booking_option: "double-room",
      checkin_date: "2030-02-31",
      checkout_date: "2030-03-01",
      guests: 2,
      children: 0,
      name: "Guest",
      email: "guest@example.com",
      phone: "+27640000000"
    });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /dates/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM bookings").get().total, 0);
});

test("valid booking is saved as a pending reservation", async () => {
  const checkin = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const checkout = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
  const response = await request(app)
    .post("/api/bookings")
    .send({
      booking_type: "accommodation",
      booking_option: "double-room",
      checkin_date: checkin,
      checkout_date: checkout,
      guests: 2,
      children: 0,
      name: "Guest",
      email: "guest@example.com",
      phone: "+27640000000",
      company: "",
      special_requests: ""
    });
  assert.equal(response.status, 201);
  assert.equal(response.body.status, "pending");
  assert.equal(db.prepare("SELECT status FROM bookings WHERE id = ?")
    .get(response.body.booking_id).status, "pending");
});

test("website is served without exposing backend files", async () => {
  const login = await request(app).get("/login.html");
  const backendManifest = await request(app).get("/package.json");
  assert.equal(login.status, 200);
  assert.match(login.text, /Sign in or create an account/);
  assert.equal(backendManifest.status, 404);
});

test("staff console routes are served but staff APIs remain role protected", async () => {
  const page = await request(app).get("/staff.html");
  const anonymous = await request(app).get("/api/staff/dashboard");
  const customer = await authenticatedRequest(makeUser()).get("/api/staff/dashboard");
  assert.equal(page.status, 200);
  assert.equal(anonymous.status, 401);
  assert.equal(customer.status, 403);
});

test("staff inventory prevents overlapping requests and confirmations over capacity", async () => {
  const guestId = makeUser();
  const guest = authenticatedRequest(guestId);
  const staff = authenticatedRequest(makeUser("admin"));
  const inventoryResponse = await staff.post("/api/staff/inventory").send({
    slug: "test-double-room", category: "accommodation", name: "Test Double Room",
    units: 1, max_guests: 2, price_per_unit_cents: 25000, currency: "ZAR"
  });
  assert.equal(inventoryResponse.status, 201, JSON.stringify(inventoryResponse.body));
  const resource = inventoryResponse.body.resource;
  const checkin = "2040-04-10";
  const checkout = "2040-04-11";
  const bookingData = {
    booking_type: "accommodation", booking_option: "test-double-room",
    checkin_date: checkin, checkout_date: checkout, guests: 2, children: 0,
    name: "Guest One", email: "guest-one@example.com", phone: "+27640000000"
  };
  const first = await guest.post("/api/bookings").send(bookingData);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.status, "pending");
  assert.equal(first.body.total_cents, 25000);
  const conflict = await request(app).post("/api/bookings").send({
    ...bookingData, name: "Guest Two", email: "guest-two@example.com"
  });
  assert.equal(conflict.status, 409);

  const confirmed = await staff.patch(`/api/staff/bookings/${first.body.booking_id}`)
    .send({ status: "confirmed", resource_id: resource.id });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.booking.status, "confirmed");
  const stillFull = await request(app).post("/api/bookings").send({
    ...bookingData, name: "Guest Two", email: "guest-two@example.com"
  });
  assert.equal(stillFull.status, 409);

  const availability = await request(app).get("/api/availability")
    .query({ resource: "test-double-room", checkin, checkout, guests: 2 });
  assert.equal(availability.status, 200);
  assert.equal(availability.body.available, false);

  const lowerCapacity = await staff.patch(`/api/staff/inventory/${resource.id}`)
    .send({ units: 0 });
  assert.equal(lowerCapacity.status, 400);
  const belowConfirmed = await staff.patch(`/api/staff/inventory/${resource.id}`)
    .send({ units: 1, max_guests: 1 });
  assert.equal(belowConfirmed.status, 400);
  const terminal = await staff.patch(`/api/staff/bookings/${first.body.booking_id}`).send({ status: "completed" });
  assert.equal(terminal.status, 400);
});

test("staff can confirm mapped inventory automatically and receive business reports", async () => {
  const staff = authenticatedRequest(makeUser("admin"));
  const guestId = makeUser();
  const guest = authenticatedRequest(guestId);
  const resourceResponse = await staff.post("/api/staff/inventory").send({
    slug: "test-conference-suite", category: "conference", name: "Test Conference Suite",
    units: 3, max_guests: 40, price_per_unit_cents: 125000
  });
  assert.equal(resourceResponse.status, 201, JSON.stringify(resourceResponse.body));
  const setting = await staff.patch("/api/staff/settings")
    .send({ automatic_booking_confirmation: true });
  assert.equal(setting.status, 200);
  const booking = await guest.post("/api/bookings").send({
    booking_type: "conference", booking_option: "test-conference-suite",
    checkin_date: "2041-03-01", checkout_date: "2041-03-02", guests: 20,
    children: 0, name: "Conference host", email: "host@example.com", phone: "123"
  });
  assert.equal(booking.status, 201, JSON.stringify(booking.body));
  assert.equal(booking.body.status, "confirmed");

  const expense = await staff.post("/api/staff/ledger").send({
    entry_type: "expense", category: "supplies", description: "Guest supplies",
    amount_cents: 15000, currency: "ZAR", transaction_date: new Date().toISOString().slice(0, 10),
    receipt_reference: "R-101"
  });
  assert.equal(expense.status, 201, JSON.stringify(expense.body));
  const today = new Date().toISOString().slice(0, 10);
  const report = await staff.get("/api/staff/reports/summary").query({ from: today, to: today });
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.ok(report.body.finance.some((entry) => entry.expense_cents === 15000));
  const csv = await staff.get("/api/staff/reports/financials.csv").query({ from: today, to: today });
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Guest supplies/);
  const activity = await staff.get("/api/staff/dashboard");
  assert.equal(activity.status, 200);
});

test("staff can manage the public business catalogue without exposing disabled items", async () => {
  const staff = authenticatedRequest(makeUser("staff", "conference_coordinator"));
  const inventory = await staff.post("/api/staff/inventory").send({
    slug: "published-quad-biking", category: "leisure", name: "Quad biking",
    units: 2, max_guests: 1, price_per_unit_cents: 65000
  });
  assert.equal(inventory.status, 201);
  const bookable = await request(app).get("/api/booking-options");
  assert.ok(bookable.body.options.some(option => option.slug === "published-quad-biking" && option.category === "leisure"));
  const created = await staff.post("/api/staff/catalogue").send({
    category: "dining", name: "Garden breakfast", description: "Breakfast for guests.",
    price_cents: 18000, currency: "ZAR"
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const visible = await request(app).get("/api/offerings");
  assert.ok(visible.body.offerings.some((item) => item.id === created.body.offering.id));
  const deactivated = await staff.delete(`/api/staff/catalogue/${created.body.offering.id}`);
  assert.equal(deactivated.status, 204);
  const hidden = await request(app).get("/api/offerings");
  assert.ok(!hidden.body.offerings.some((item) => item.id === created.body.offering.id));
});

test("staff guest notes and housekeeping tasks are managed and audited", async () => {
  const staff = authenticatedRequest(makeUser("staff", "director"));
  const guestId = makeUser();
  const note = await staff.post(`/api/staff/guests/${guestId}/notes`).send({ note: "Prefers a quiet room." });
  assert.equal(note.status, 201, JSON.stringify(note.body));
  const task = await staff.post("/api/staff/tasks").send({
    title: "Prepare room", description: "Check amenities", due_date: "2042-02-03"
  });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  const completed = await staff.patch(`/api/staff/tasks/${task.body.task.id}`).send({ status: "done" });
  assert.equal(completed.status, 200);
  const detail = await staff.get(`/api/staff/guests/${guestId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.notes[0].note, "Prefers a quiet room.");
});

test("provider identities cannot be removed until another login method is linked", async () => {
  const userId = makeUser();
  db.prepare("INSERT INTO identities (user_id, provider, provider_id) VALUES (?, 'google', ?)").run(userId, "google-subject");
  db.prepare("INSERT INTO identities (user_id, provider, provider_id) VALUES (?, 'facebook', ?)").run(userId, "facebook-subject");
  const account = authenticatedRequest(userId);
  const removed = await account.delete("/api/account/identities/facebook");
  assert.equal(removed.status, 204);
  const last = await account.delete("/api/account/identities/google");
  assert.equal(last.status, 409);
});

test("administrator cannot remove the final active administrator", async () => {
  const isolatedStore = new session.MemoryStore();
  const isolatedSecret = "isolated-admin-session-secret-long-enough";
  const isolatedApp = createApp({
    databasePath: path.join(temporaryDirectory, "last-admin.sqlite"),
    sessionDbDir: temporaryDirectory,
    sessionSecret: isolatedSecret,
    sessionStore: isolatedStore,
    passport: new Passport(),
    env: { NODE_ENV: "test", SESSION_SECRET: isolatedSecret }
  });
  const adminId = Number(isolatedApp.locals.db.prepare("INSERT INTO users (name, email, role) VALUES (?, ?, 'admin')")
    .run("Only admin", "only-admin@example.com").lastInsertRowid);
  const admin = authenticatedRequestFor(isolatedApp, isolatedStore, isolatedSecret, adminId);
  const response = await admin.patch(`/api/admin/users/${adminId}`)
    .send({ role: "staff" });
  assert.equal(response.status, 409);
  assert.equal(isolatedApp.locals.db.prepare("SELECT role FROM users WHERE id = ?").get(adminId).role, "admin");
  isolatedApp.locals.db.close();
});

test("account-link verification attaches only to the freshly authenticated owner", async () => {
  const ownerId = makeUser();
  const otherId = makeUser();
  db.prepare("INSERT INTO identities (user_id, provider, provider_id) VALUES (?, 'google', ?)")
    .run(otherId, "already-owned");
  const verifyGoogle = buildVerifyCallback(db, env, "google");
  const invoke = (providerId, owner = ownerId) => new Promise((resolve) => {
    verifyGoogle({
      session: {
        identityLinkProvider: "google",
        identityLinkUserId: owner,
        identityLinkStartedAt: Date.now()
      }
    }, null, null, { id: providerId, displayName: "Linked Guest" }, (error, user) => resolve({ error, user }));
  });
  const linked = await invoke("new-google-subject");
  assert.ifError(linked.error);
  assert.equal(linked.user.id, ownerId);
  assert.equal(db.prepare("SELECT user_id FROM identities WHERE provider = 'google' AND provider_id = ?")
    .get("new-google-subject").user_id, ownerId);

  const conflict = await invoke("already-owned");
  assert.match(conflict.error.message, /already linked to another account/);
  const expired = await new Promise((resolve) => verifyGoogle({
    session: {
      identityLinkProvider: "google", identityLinkUserId: ownerId,
      identityLinkStartedAt: Date.now() - 11 * 60 * 1000
    }
  }, null, null, { id: "expired-subject" }, (error, user) => resolve({ error, user })));
  assert.match(expired.error.message, /expired/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM identities WHERE provider_id = 'expired-subject'").get().count, 0);
});

test("Yoco hosted checkout verifies signed webhooks and records payment once", async () => {
  const guestId = makeUser();
  const guest = authenticatedRequest(guestId);
  const staff = authenticatedRequest(makeUser("admin"));
  const resource = await staff.post("/api/staff/inventory").send({
    slug: "yoco-room", category: "accommodation", name: "Yoco Room",
    units: 1, max_guests: 2, price_per_unit_cents: 36000
  });
  assert.equal(resource.status, 201);
  const created = await guest.post("/api/bookings").send({
    booking_type: "accommodation", booking_option: "yoco-room",
    checkin_date: "2043-04-10", checkout_date: "2043-04-11", guests: 2, children: 0,
    name: "Pay Guest", email: "pay-guest@example.com", phone: "123"
  });
  assert.equal(created.status, 201);
  const confirmed = await staff.patch(`/api/staff/bookings/${created.body.booking_id}`)
    .send({ status: "confirmed", resource_id: resource.body.resource.id });
  assert.equal(confirmed.status, 200);

  const checkout = await guest.post(`/api/account/bookings/${created.body.booking_id}/payment`);
  assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
  assert.match(checkout.body.url, /^https:\/\/c\.yoco\.com\/checkout\//);
  assert.equal(checkout.body.amount_cents, 36000);
  assert.equal((await guest.post(`/api/account/bookings/${created.body.booking_id}/cancel`)).status, 409);
  const payment = db.prepare("SELECT provider, provider_reference FROM payments WHERE id = ?")
    .get(checkout.body.payment_id);
  assert.equal(payment.provider, "yoco");
  assert.equal(payment.provider_reference, `checkout-${checkout.body.payment_id}`);
  const checkoutRetry = await guest.post(`/api/account/bookings/${created.body.booking_id}/payment`);
  assert.equal(checkoutRetry.body.payment_id, checkout.body.payment_id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM payments WHERE booking_id = ?")
    .get(created.body.booking_id).count, 1);
  assert.equal(db.prepare("SELECT payment_status FROM bookings WHERE id = ?")
    .get(created.body.booking_id).payment_status, "unpaid");

  const eventId = "yoco-event-payment-1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const eventForAmount = JSON.stringify({
    id: "wrong-amount-event",
    type: "payment.succeeded",
    payload: {
      id: "yoco-payment-wrong-amount", type: "payment", status: "succeeded", amount: 35999,
      currency: "ZAR", metadata: { checkoutId: payment.provider_reference }
    }
  });
  const secret = Buffer.from(env.YOCO_WEBHOOK_SECRET.slice("whsec_".length), "base64");
  const badAmountSignature = crypto.createHmac("sha256", secret)
    .update(`yoco-event-wrong-amount.${timestamp}.${eventForAmount}`).digest("base64");
  const badAmount = await request(app).post("/api/payments/yoco/webhook")
    .set("webhook-id", "yoco-event-wrong-amount")
    .set("webhook-timestamp", timestamp)
    .set("webhook-signature", `v1,${badAmountSignature}`)
    .set("Content-Type", "application/json")
    .send(eventForAmount);
  assert.equal(badAmount.status, 400);
  assert.equal(db.prepare("SELECT status FROM payments WHERE id = ?").get(checkout.body.payment_id).status, "pending");

  const payload = JSON.stringify({
    id: "payment-event",
    type: "payment.succeeded",
    payload: {
      id: "yoco-payment-1", type: "payment", status: "succeeded", amount: 36000,
      currency: "ZAR", metadata: { checkoutId: payment.provider_reference }
    }
  });
  const signature = crypto.createHmac("sha256", secret)
    .update(`${eventId}.${timestamp}.${payload}`).digest("base64");
  const notification = (signedValue = `v1,${signature}`) => request(app)
    .post("/api/payments/yoco/webhook")
    .set("webhook-id", eventId)
    .set("webhook-timestamp", timestamp)
    .set("webhook-signature", signedValue)
    .set("Content-Type", "application/json")
    .send(payload);
  const invalid = await notification("v1,invalid");
  assert.equal(invalid.status, 400);
  const paid = await notification();
  const duplicate = await notification();
  assert.equal(paid.status, 200);
  assert.equal(duplicate.status, 200);
  assert.equal(db.prepare("SELECT status FROM payments WHERE id = ?").get(checkout.body.payment_id).status, "paid");
  assert.equal((await guest.post(`/api/account/bookings/${created.body.booking_id}/payment`)).status, 400);
  assert.equal((await guest.post(`/api/account/bookings/${created.body.booking_id}/cancel`)).status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE payment_id = ?").get(checkout.body.payment_id).count, 1);
});

test("returning guests can change reservations, order breakfast, and see their Yoco history", async () => {
  const guestId = makeUser();
  const guest = authenticatedRequest(guestId);
  const admin = authenticatedRequest(makeUser("admin"));
  const manager = authenticatedRequest(makeUser("staff", "guest_relations_manager"));
  const resource = await admin.post("/api/staff/inventory").send({
    slug: "guest-self-service-suite", category: "accommodation", name: "Guest Self-service Suite",
    units: 2, max_guests: 4, price_per_unit_cents: 42000
  });
  assert.equal(resource.status, 201);
  const booking = await guest.post("/api/bookings").send({
    booking_type: "accommodation", booking_option: "guest-self-service-suite",
    checkin_date: "2045-04-10", checkout_date: "2045-04-12", guests: 2, children: 0,
    name: "Returning guest", email: "returning@example.com", phone: "123"
  });
  assert.equal(booking.status, 201);
  const confirmed = await admin.patch(`/api/staff/bookings/${booking.body.booking_id}`)
    .send({ status: "confirmed", resource_id: resource.body.resource.id });
  assert.equal(confirmed.status, 200);

  const changed = await guest.post(`/api/account/bookings/${booking.body.booking_id}/change`).send({
    booking_option: "guest-self-service-suite", checkin_date: "2045-04-11",
    checkout_date: "2045-04-13", guests: 3, children: 1
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.booking.status, "confirmed");
  assert.equal(changed.body.booking.checkin_date, "2045-04-11");
  assert.equal(changed.body.booking.guests, 3);
  assert.ok(db.prepare("SELECT COUNT(*) AS count FROM guest_notifications WHERE booking_id = ?")
    .get(booking.body.booking_id).count >= 3);
  assert.equal((await authenticatedRequest(makeUser()).post(`/api/account/bookings/${booking.body.booking_id}/change`)
    .send({ checkin_date: "2045-04-12" })).status, 404);

  const menu = await manager.post("/api/staff/breakfast-menu").send({
    name: "Farm breakfast", description: "Eggs, toast and fruit.", price_cents: 12500, dietary_tags: "Vegetarian option"
  });
  assert.equal(menu.status, 201, JSON.stringify(menu.body));
  const order = await guest.post("/api/account/breakfast-orders").send({
    booking_id: booking.body.booking_id, menu_item_id: menu.body.item.id,
    service_date: "2045-04-12", quantity: 2, notes: "No tomato"
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.equal(order.body.total_cents, 25000);
  const orderList = await guest.get("/api/account/breakfast-orders");
  assert.equal(orderList.body.orders[0].item_name, "Farm breakfast");
  assert.equal((await authenticatedRequest(makeUser()).post(`/api/account/breakfast-orders/${order.body.order.id}/payment`)).status, 404);

  const checkout = await guest.post(`/api/account/breakfast-orders/${order.body.order.id}/payment`);
  assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
  assert.equal(checkout.body.amount_cents, 25000);
  assert.equal((await guest.post(`/api/account/breakfast-orders/${order.body.order.id}/cancel`)).status, 409);
  const history = await guest.get("/api/account/payments");
  assert.equal(history.status, 200);
  assert.ok(history.body.payments.some(payment => payment.purpose === `breakfast:${order.body.order.id}`));
  const menuPublic = await request(app).get("/api/breakfast/menu");
  assert.ok(menuPublic.body.menu.some(item => item.id === menu.body.item.id));
  assert.equal((await manager.get("/api/staff/breakfast-orders").query({ date: "2045-04-12" })).body.orders.length >= 1, true);
});

test("guests can check in and out only for their own confirmed reservation", async () => {
  const guestId = makeUser();
  const guest = authenticatedRequest(guestId);
  const admin = authenticatedRequest(makeUser("admin"));
  const resource = await admin.post("/api/staff/inventory").send({
    slug: "digital-arrival-room", category: "accommodation", name: "Digital Arrival Room",
    units: 1, max_guests: 2, price_per_unit_cents: 10000
  });
  const today = businessToday();
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const checkoutDate = tomorrow.toISOString().slice(0, 10);
  const created = await guest.post("/api/bookings").send({
    booking_type: "accommodation", booking_option: "digital-arrival-room",
    checkin_date: today, checkout_date: checkoutDate, guests: 1, children: 0,
    name: "Arrival guest", email: "arrival@example.com", phone: "123"
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await admin.patch(`/api/staff/bookings/${created.body.booking_id}`)
    .send({ status: "confirmed", resource_id: resource.body.resource.id });
  const early = await guest.post(`/api/account/bookings/${created.body.booking_id}/check-out`);
  assert.equal(early.status, 409);
  const checkin = await guest.post(`/api/account/bookings/${created.body.booking_id}/check-in`);
  assert.equal(checkin.status, 200, JSON.stringify(checkin.body));
  assert.equal((await guest.post(`/api/account/bookings/${created.body.booking_id}/check-in`)).status, 409);
  db.prepare("UPDATE bookings SET checkout_date = ? WHERE id = ?").run(today, created.body.booking_id);
  const checkout = await guest.post(`/api/account/bookings/${created.body.booking_id}/check-out`);
  assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
  assert.equal(checkout.body.status, "completed");
  const record = db.prepare("SELECT checked_in_at, checked_out_at, status FROM bookings WHERE id = ?")
    .get(created.body.booking_id);
  assert.ok(record.checked_in_at);
  assert.ok(record.checked_out_at);
  assert.equal(record.status, "completed");
});

test("staff roles enforce scoped access and on-site attendance", async () => {
  const workerId = makeUser("staff", "housekeeping");
  const worker = authenticatedRequest(workerId);
  assert.equal((await worker.get("/api/staff/attendance")).status, 200);
  assert.equal((await worker.get("/api/staff/reports/summary")).status, 403);
  assert.equal((await worker.get("/api/staff/guests")).status, 403);
  const remote = await worker.post("/api/staff/attendance/clock-in")
    .send({ latitude: -31, longitude: 27 });
  assert.equal(remote.status, 400);
  const onsite = await worker.post("/api/staff/attendance/clock-in")
    .send({ latitude: -32.15, longitude: 27.28 });
  assert.equal(onsite.status, 201, JSON.stringify(onsite.body));
  assert.equal((await worker.post("/api/staff/attendance/clock-in")
    .send({ latitude: -32.15, longitude: 27.28 })).status, 409);
  const clockout = await worker.post("/api/staff/attendance/clock-out")
    .send({ latitude: -32.15, longitude: 27.28 });
  assert.equal(clockout.status, 200, JSON.stringify(clockout.body));
  assert.ok((await worker.get("/api/staff/attendance")).body.history[0].clock_out_at);
});

test("staff can request leave, management can review it, and directors publish shifts", async () => {
  const manager = authenticatedRequest(makeUser("staff", "director"));
  const hours = await manager.patch("/api/staff/settings").send({
    checkin_time: "15:00", checkout_time: "10:30", breakfast_start: "07:30", breakfast_end: "09:30"
  });
  assert.equal(hours.status, 200, JSON.stringify(hours.body));
  assert.equal((await request(app).get("/api/property-info")).body.times.checkin_time, "15:00");
  const staffId = makeUser("staff", "housekeeping");
  const staff = authenticatedRequest(staffId);
  const leave = await staff.post("/api/staff/leave").send({
    start_date: "2047-03-01", end_date: "2047-03-03", reason: "Family commitment"
  });
  assert.equal(leave.status, 201, JSON.stringify(leave.body));
  assert.equal((await staff.get("/api/staff/leave")).body.requests.length, 1);
  const decision = await manager.patch(`/api/staff/leave/${leave.body.request_id}`)
    .send({ status: "approved", review_note: "Approved" });
  assert.equal(decision.status, 200, JSON.stringify(decision.body));
  assert.equal(decision.body.request.status, "approved");

  const shift = await manager.post("/api/staff/schedule").send({
    user_id: staffId, starts_at: "2047-03-10T08:00:00.000Z",
    ends_at: "2047-03-10T16:00:00.000Z", assignment: "Morning room turnover"
  });
  assert.equal(shift.status, 201, JSON.stringify(shift.body));
  const week = await staff.get("/api/staff/schedule").query({ from: "2047-03-10" });
  assert.equal(week.status, 200, JSON.stringify(week.body));
  assert.equal(week.body.shifts.length, 1);
  assert.equal(week.body.shifts[0].assignment, "Morning room turnover");
  const forbidden = await staff.post("/api/staff/schedule").send({
    user_id: staffId, starts_at: "2047-03-11T08:00:00.000Z", ends_at: "2047-03-11T16:00:00.000Z"
  });
  assert.equal(forbidden.status, 403);
});

test("administrators can assign staff positions but directors cannot administer accounts", async () => {
  const admin = authenticatedRequest(makeUser("admin"));
  const director = authenticatedRequest(makeUser("staff", "director"));
  const guestId = makeUser();
  const promoted = await admin.patch(`/api/admin/users/${guestId}`).send({
    role: "staff", staff_role: "conference_coordinator"
  });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.equal(promoted.body.user.staff_role, "conference_coordinator");
  assert.equal((await director.patch(`/api/admin/users/${guestId}`).send({ role: "admin" })).status, 403);
});

test("announcements reach customer accounts and remain owner-scoped", async () => {
  const manager = authenticatedRequest(makeUser("staff", "guest_relations_manager"));
  const guestId = makeUser();
  const guest = authenticatedRequest(guestId);
  const other = authenticatedRequest(makeUser());
  const created = await manager.post("/api/staff/announcements").send({
    title: "Breakfast service update", message: "Breakfast begins at 7:30 tomorrow.",
    audience: "guests", starts_at: new Date(Date.now() - 60000).toISOString()
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const notifications = await guest.get("/api/account/notifications");
  assert.ok(notifications.body.announcements.some(item => item.id === created.body.announcement.id));
  const inboxItem = db.prepare("SELECT id FROM guest_notifications WHERE user_id = ? AND title = ?")
    .get(guestId, "Breakfast service update");
  assert.ok(inboxItem);
  assert.equal((await guest.patch(`/api/account/notifications/${inboxItem.id}/read`).send({})).status, 200);
  assert.equal((await other.patch(`/api/account/notifications/${inboxItem.id}/read`).send({})).status, 404);
  assert.equal((await other.get("/api/account/notifications")).status, 200);
  assert.equal((await manager.post("/api/staff/events").send({
    title: "Conference day", starts_at: "2048-02-01T09:00:00.000Z", ends_at: "2048-02-01T16:00:00.000Z",
    visibility: "guests"
  })).status, 403);
});

test("guest cancellation is owner-scoped and clears scheduled stay reminders", async () => {
  const guestId = makeUser();
  const guest = authenticatedRequest(guestId);
  const booking = await guest.post("/api/bookings").send({
    booking_type: "leisure", booking_option: "unconfigured-spa-request",
    checkin_date: "2049-05-10", checkout_date: "2049-05-11", guests: 1, children: 0,
    name: "Cancellation guest", email: "cancel@example.com", phone: "123"
  });
  assert.equal(booking.status, 201);
  db.prepare(`
    INSERT INTO guest_notifications (user_id, booking_id, notification_type, title, message, scheduled_at)
    VALUES (?, ?, 'checkout', 'Checkout reminder', 'Reminder', '2049-05-10 18:00:00')
  `).run(guestId, booking.body.booking_id);
  const otherGuest = authenticatedRequest(makeUser());
  assert.equal((await otherGuest.post(`/api/account/bookings/${booking.body.booking_id}/cancel`)).status, 404);
  const cancelled = await guest.post(`/api/account/bookings/${booking.body.booking_id}/cancel`);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(db.prepare("SELECT status FROM bookings WHERE id = ?").get(booking.body.booking_id).status, "cancelled");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM guest_notifications WHERE booking_id = ? AND scheduled_at > datetime('now')")
    .get(booking.body.booking_id).count, 0);
});

test("Yoco webhook signature verifier rejects expired and invalid signatures", () => {
  const rawBody = Buffer.from('{"id":"event"}');
  const eventId = "verifier-event";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = Buffer.from(env.YOCO_WEBHOOK_SECRET.slice("whsec_".length), "base64");
  const signature = crypto.createHmac("sha256", secret)
    .update(`${eventId}.${timestamp}.${rawBody.toString("utf8")}`).digest("base64");
  const args = { secret: env.YOCO_WEBHOOK_SECRET, id: eventId, timestamp, rawBody };
  assert.equal(verifyYocoWebhook({ ...args, signature: `v1,${signature}` }), true);
  assert.equal(verifyYocoWebhook({ ...args, timestamp: String(Number(timestamp) - 181), signature: `v1,${signature}` }), false);
  assert.equal(verifyYocoWebhook({ ...args, signature: "v1,not-a-valid-signature" }), false);
});
