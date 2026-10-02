# Ngqamakwe Luxury Guest House

Guesthouse website with a Node.js/Express API, SQLite storage, Google/Facebook customer accounts, a staff operations console, booking and inventory management, workforce tools, guest notifications, and Yoco hosted checkout.

## Run locally

1. Install Node.js 20 or newer, then run `npm install`.
2. Copy `.env.example` to `.env` and set a random `SESSION_SECRET`. For the first local administrator, run `npm run create-admin` in an interactive terminal and choose a password of 6–128 characters. The account is created only when the command prints `Administrator account created`; if validation fails, correct the input and run the command again.
3. Configure `YOCO_SECRET_KEY` and `YOCO_WEBHOOK_SECRET`; register `https://YOUR_HOST/api/payments/yoco/webhook` in Yoco Checkout API settings.
4. For staff attendance, set the actual property `BUSINESS_LATITUDE`, `BUSINESS_LONGITUDE`, and `ATTENDANCE_RADIUS_METERS`.
5. Start the service with `npm start` and visit `http://localhost:3000`.
6. Open `/login.html` and sign in with the local administrator username/password, Google, or Facebook. Social sign-in requires its provider credentials in `.env`. New self-registered accounts are guests; use **Team & accounts** to assign staff access.
7. Run `npm test` for API, customer self-service, Yoco, attendance, role permissions, scheduling, and email workflow tests.

The server creates `server/data/guesthouse.sqlite` and `server/data/sessions.sqlite` automatically. They contain personal information and must not be committed or served publicly. Guests can request and change reservations across accommodation, conference, dining, and activities; select breakfast from the staff-managed menu; check in/out online; cancel eligible unpaid reservations; and view announcements, reminders, stay calendars, and Yoco payment history. Staff tools cover guest service, housekeeping, finance, role-based operations, on-site attendance, leave requests, weekly schedules, upcoming bookings/events, and breakfast order fulfilment.

All reservation requests remain pending until staff confirm availability; automatic confirmation defaults off. Configure accurate capacity and rates before enabling it. Yoco card/payment details stay on Yoco's hosted checkout; signed Yoco webhooks (not the browser success redirect) confirm payment. In-account reminders are created by the application; email requires configured SMTP.

Local passwords use Node.js scrypt hashes and must be 6–128 characters. Sign in using the administrator username or email entered during account creation; successful staff/admin sign-ins open `/staff.html`. Use **Forgot password?** to receive a one-time reset link by email; configure SMTP in `.env` for email delivery and set `BASE_URL` to the public site address when deployed. Password inputs include a Show/Hide control. Guest registrations cannot grant themselves staff or administrator access. Configure OAuth credentials to enable Google/Facebook sign-in; the buttons use a popup and return staff/admin users to the staff dashboard. Keep the `npm start` terminal open while using the website; pressing Ctrl+C stops the server.

For production, use HTTPS, set `NODE_ENV=production`, configure the correct proxy hop count, restrict OAuth callback URLs to the deployed HTTPS host, configure SMTP and Yoco live credentials, register and verify the Yoco webhook, set `BASE_URL` to the deployed HTTPS origin, configure the on-premises attendance geofence, and back up SQLite files securely. Read [backend operations and API setup](docs/backend-api.md) first.

## Audit and delivery notes

- [Website audit](docs/website-audit.md)
- [API and provider setup](docs/backend-api.md)
- [Issue board](docs/ISSUE_BOARD.md)

The website and API are served from one origin by default. If the frontend is hosted separately, configure a same-origin reverse proxy for `/api/*` and `/auth/*`; the API intentionally does not enable permissive cross-origin access.
