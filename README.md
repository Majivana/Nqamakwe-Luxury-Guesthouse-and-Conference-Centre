# Ngqamakwe Luxury Guest House

Guesthouse website with a Node.js/Express API, SQLite storage, Google/Facebook customer accounts, a staff operations console, booking and inventory management, workforce tools, guest notifications, and Yoco hosted checkout.

## Run locally

1. Install Node.js 20 or newer, then run `npm install`.
2. Copy `.env.example` to `.env`; set a random `SESSION_SECRET` and configure OAuth credentials (see [backend setup](docs/backend-api.md)).
3. Configure `YOCO_SECRET_KEY` and `YOCO_WEBHOOK_SECRET`; register `https://YOUR_HOST/api/payments/yoco/webhook` in Yoco Checkout API settings.
4. For staff attendance, set the actual property `BUSINESS_LATITUDE`, `BUSINESS_LONGITUDE`, and `ATTENDANCE_RADIUS_METERS`.
5. Start the service with `npm start` and visit `http://localhost:3000`.
6. Sign in with a configured admin Google account and open `/staff.html`; assign each staff account a business position and configure accommodation, conference, dining, and leisure inventory.
7. Run `npm test` for API, customer self-service, Yoco, attendance, role permissions, scheduling, and email workflow tests.

The server creates `server/data/guesthouse.sqlite` and `server/data/sessions.sqlite` automatically. They contain personal information and must not be committed or served publicly. Guests can request and change reservations across accommodation, conference, dining, and activities; select breakfast from the staff-managed menu; check in/out online; cancel eligible unpaid reservations; and view announcements, reminders, stay calendars, and Yoco payment history. Staff tools cover guest service, housekeeping, finance, role-based operations, on-site attendance, leave requests, weekly schedules, upcoming bookings/events, and breakfast order fulfilment.

All reservation requests remain pending until staff confirm availability; automatic confirmation defaults off. Configure accurate capacity and rates before enabling it. Yoco card/payment details stay on Yoco's hosted checkout; signed Yoco webhooks (not the browser success redirect) confirm payment. In-account reminders are created by the application; email requires configured SMTP.

For production, use HTTPS, set `NODE_ENV=production`, configure the correct proxy hop count, restrict OAuth callback URLs to the deployed HTTPS host, configure SMTP and Yoco live credentials, register and verify the Yoco webhook, set `BASE_URL` to the deployed HTTPS origin, configure the on-premises attendance geofence, and back up SQLite files securely. Read [backend operations and API setup](docs/backend-api.md) first.

## Audit and delivery notes

- [Website audit](docs/website-audit.md)
- [API and provider setup](docs/backend-api.md)
- [Issue board](docs/ISSUE_BOARD.md)

The website and API are served from one origin by default. If the frontend is hosted separately, configure a same-origin reverse proxy for `/api/*` and `/auth/*`; the API intentionally does not enable permissive cross-origin access.
