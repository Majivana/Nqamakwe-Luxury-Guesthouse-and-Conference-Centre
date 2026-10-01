# Operations backend: setup and API

The website now ships with an Express/Node.js operations API, SQLite database, Google/Facebook account sign-in, and a staff console at `/staff.html`. Browser sessions are server-side in SQLite; customer data, transactions, and the email queue are also persisted locally. Use Node.js 20 or later.

## Setup

1. Run `npm install` and copy `.env.example` to `.env`.
2. Set `SESSION_SECRET` to a random value of at least 32 characters, and set an administrator Google email in `ADMIN_EMAILS`.
3. Configure OAuth applications and callback URLs:
   - `https://YOUR_HOST/auth/google/callback`
   - `https://YOUR_HOST/auth/facebook/callback`
4. For email, provide SMTP host, port, sender, and credentials when the server requires authentication. With SMTP unset, notifications remain visible in the durable queue and staff see that delivery is not configured.
5. Set Yoco's `YOCO_SECRET_KEY` and `YOCO_WEBHOOK_SECRET`. In Yoco's Checkout API settings, register `https://YOUR_HOST/api/payments/yoco/webhook`. Yoco returns the webhook signing secret only once; store it in the production secret manager. `BASE_URL` must be the deployed HTTPS origin in production.
6. Configure actual property coordinates in `BUSINESS_LATITUDE` and `BUSINESS_LONGITUDE`, and set `ATTENDANCE_RADIUS_METERS` for the on-premises clock. Browsers require HTTPS for reliable geolocation.
7. Run `npm start`; open `/staff.html` after sign-in. Assign team positions in **Team & accounts**, add all bookable rooms, conference venues, dining and activities in **Inventory & availability**, and add breakfast dishes in **Breakfast menu & orders**. Use the exact booking form option as the inventory slug (for example `double-room` or `quad-biking`). Automatic confirmation defaults off.

SQLite data lives under `server/data/`. Do not serve, commit, or share it. Back up the database and email queue securely. Production requires HTTPS, strict file/secret permissions, tested backups, and `TRUST_PROXY` set to the actual trusted proxy hop count. `BUSINESS_TIME_ZONE` defaults to `Africa/Johannesburg`; `PENDING_HOLD_HOURS` defaults to 24 and is limited to 1–168.

## Account access and linking

Google/Facebook OAuth creates an account on first sign-in and resolves future sign-ins using the provider subject. Email equality alone never merges accounts. New accounts are customers; only a verified Google address allowlisted in `ADMIN_EMAILS` bootstraps the initial admin. Administrators promote existing users to staff in the Team console.

From the signed-in account page, a user can link another provider or unlink one. Linking requires a sign-in within the last 10 minutes, uses OAuth state validation, and rejects provider identities already owned by another account. Users cannot remove their final sign-in method. There is no email/password recovery because credentials are managed by the identity providers.

## Staff console and permissions

`/staff.html` adapts its navigation to the team member's position. API permissions are enforced server-side; hiding a button is not the access control. The About Us page lists Director, Guest Relations Manager, Conference Coordinator, General Worker, and Housekeeping. Assign these positions in **Team & accounts**:

| Staff position | Operational access |
|---|---|
| Director | All business modules, financials, menu, settings, schedules, and approvals |
| Guest Relations Manager | Reservations, guest records, enquiries, breakfast service, announcements, leave review, and email |
| Conference Coordinator | Reservations, conference inventory/catalogue, housekeeping tasks, calendar/events, and announcements |
| General Worker | Assigned operations tasks, on-site attendance, own schedule/leave, and non-guest-identifying bookings/events calendar |
| Housekeeping | Room-turnover tasks, on-site attendance, own schedule/leave, and non-guest-identifying bookings/events calendar |

Administrators have full access and manage account roles/positions. The Director can change business settings; only administrators can promote users. The Director manages staff schedules; the Guest Relations Manager and Director review leave requests. Staff see their own schedule and leave unless they have an approved management position.

Inventory units represent simultaneously bookable rooms/seats/resources; `max_guests` is capacity per unit. Overlapping confirmed reservations and unexpired pending holds are checked transactionally. Map every bookable accommodation, conference, dining, and leisure option to active inventory. Pending requests reserve mapped inventory for the configured hold duration. Expired holds no longer count toward capacity.

Automatic confirmation is explicitly opt-in in **Business settings** and only confirms requests with a configured, available resource and guest capacity. Otherwise a reservation remains pending and must be confirmed by staff. Rates are integer cents in the resource currency and are charged per unit per reserved day. Reservations are not inventory bookings until confirmed.

## API

Writes use same-origin JSON, except the Yoco server webhook. Errors return `{ "error": "..." }`.

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/health` | Public | Readiness |
| GET | `/auth/google`, `/auth/facebook` | Public | Sign in / sign up |
| GET | `/auth/google?intent=link`, `/auth/facebook?intent=link` | Recent-authenticated user | Link a provider |
| GET | `/api/me`, `/api/account/identities`, `/api/account/bookings` | Signed in | Account and own reservations |
| PATCH | `/api/account/profile` | Signed in | Update own display name and phone |
| DELETE | `/api/account/identities/:provider` | Signed in within 10 min | Unlink a provider; last identity is protected |
| POST | `/api/account/bookings/:id/cancel` | Signed in owner | Cancel eligible unpaid reservation |
| POST | `/api/account/bookings/:id/change` | Signed in owner | Change future unpaid dates, activity/resource, and party size if inventory allows |
| POST | `/api/account/bookings/:id/check-in`, `/api/account/bookings/:id/check-out` | Signed in owner | Check in on arrival day and check out after check-in on/after departure date |
| GET | `/api/account/payments`, `/api/account/notifications`, `/api/account/calendar` | Signed in | Own payment history, in-app reminders/announcements, and guest-visible events |
| PATCH | `/api/account/notifications/:id/read` | Signed in owner | Mark own delivered notification read |
| GET | `/api/breakfast/menu` | Public | Available breakfast choices |
| GET, POST | `/api/account/breakfast-orders` | Signed in | Order from the menu for a confirmed stay date and view own orders |
| POST | `/api/account/breakfast-orders/:id/payment`, `/api/account/breakfast-orders/:id/cancel` | Signed in owner | Pay via Yoco or cancel an eligible unpaid order |
| GET | `/api/property-info` | Public | Configured check-in, checkout, and breakfast times |
| POST | `/api/logout` | Signed in | End session |
| GET | `/api/offerings`, `/api/availability` | Public | Active service catalogue and date availability |
| POST | `/api/bookings`, `/api/inquiries` | Public, rate-limited | Submit reservation request or enquiry |
| GET | `/api/staff/session`, `/api/staff/dashboard` | Staff/admin | Console access and daily operations snapshot |
| GET, PATCH | `/api/staff/bookings`, `/api/staff/bookings/:id` | Staff/admin | Review and transition reservations |
| GET, PATCH | `/api/staff/inquiries`, `/api/staff/inquiries/:id` | Staff/admin | Work enquiry queue |
| GET, POST, PATCH | `/api/staff/inventory`, `/api/staff/inventory/:id` | Staff/admin | Manage unit counts, capacity, rate, and active status |
| GET, POST, PATCH, DELETE | `/api/staff/catalogue`, `/api/staff/catalogue/:id` | Staff/admin | Manage public business service entries |
| GET | `/api/staff/guests`, `/api/staff/guests/:id` | Staff/admin | Search guest accounts and view stay history/notes |
| POST | `/api/staff/guests/:id/notes` | Staff/admin | Add an internal guest note |
| POST, PATCH | `/api/staff/tasks`, `/api/staff/tasks/:id` | Staff/admin | Housekeeping and operations tasks |
| GET, POST | `/api/staff/attendance`, `/api/staff/attendance/clock-in`, `/api/staff/attendance/clock-out` | On-site staff | Location-verified attendance clock and own shift history |
| GET, POST, PATCH | `/api/staff/leave`, `/api/staff/leave/:id` | Staff / management | Apply for leave and review pending requests |
| GET, POST | `/api/staff/schedule`, `/api/staff/workforce` | Staff / Director | See own week; Director publishes shifts and views active staff directory |
| GET, POST | `/api/staff/calendar`, `/api/staff/events` | Staff / conference coordinator | View bookings/events; authorized staff add events |
| GET, POST | `/api/staff/announcements` | Guest-relations manager / conference coordinator / Director | Publish guest, staff, or shared announcements |
| GET | `/api/staff/breakfast-orders`, `/api/staff/breakfast-menu` | Guest-relations manager / Director | Fulfil dated orders and review the guest menu |
| POST, PATCH | `/api/staff/breakfast-menu`, `/api/staff/breakfast-menu/:id`, `/api/staff/breakfast-orders/:id` | Guest-relations manager / Director | Publish menu items and update order preparation status |
| GET | `/api/staff/reports/summary`, `/api/staff/reports/financials` | Staff/admin | Income/expense/net, reservation pipeline, balances, occupancy, ledger |
| GET | `/api/staff/reports/financials.csv` | Staff/admin | Download ledger report (`from`/`to`, maximum 367 days) |
| GET, POST | `/api/staff/ledger` | Staff/admin | Read ledger and record cash income/expenses in cents |
| GET | `/api/staff/settings` | Director/admin | Business hours and integration status |
| PATCH | `/api/staff/settings` | Director/admin | Enable confirmation or update check-in, checkout, and breakfast service times |
| GET, POST, PATCH, DELETE | `/api/admin/offerings` and `/api/admin/offerings/:id` | Admin | Manage the public service catalogue |
| GET, PATCH | `/api/admin/users`, `/api/admin/users/:id` | Admin | Manage user roles and account status |
| POST | `/api/account/bookings/:id/payment` | Signed-in booking owner | Create/reuse secure Yoco Checkout API session |
| POST | `/api/staff/bookings/:id/payment` | Reservation staff | Queue Yoco checkout instructions to guest |
| POST | `/api/payments/yoco/webhook` | Yoco webhook | Verify signature/timestamp, amount, currency, and idempotently record payment |
| GET, POST | `/api/staff/emails` and `/api/staff/emails/flush` | Guest-relations staff / Director | Review queue and send queued mail |
| POST | `/api/staff/emails/:id/retry` | Guest-relations staff / Director | Retry failed delivery |

Booking requests include `booking_type`, `booking_option` (inventory slug), `checkin_date`, `checkout_date`, `guests`, `children`, contact details, and optional `units_requested`. Dates must be real future `YYYY-MM-DD` calendar days. Booking status transitions are limited to pending→confirmed/cancelled and confirmed→cancelled/completed. Paid reservations cannot be cancelled through the console without refund review.

The financial ledger treats amounts as positive integer minor units: income increases net and expense reduces it. Valid Yoco `payment.succeeded` webhooks create one income entry per payment. Browser redirect results never mark a payment paid. Cash entries are manually recorded with receipt references. CSV/reports are operational summaries, not audited accounting statements, VAT filings, payroll, or bank settlement reconciliation.

## Email and payment operations

SMTP notifications use Nodemailer and a persistent, retryable outbox. Reservation receipts/confirmation/cancellation, enquiry acknowledgements and alerts, checkout instructions, and payment receipts are queued. Without SMTP configuration nothing is falsely reported as delivered; staff can see queued/failed messages in the console. The worker polls every minute, applies backoff, and allows staff retry.

Yoco Checkout API creates a server-side hosted checkout; the server never receives card details. Checkout secrets remain server-side. The webhook validates Yoco's HMAC-SHA256 signature over the exact raw body, rejects timestamps older than three minutes, deduplicates event IDs, and checks checkout ID, amount, and currency before updating payment state. Configure the webhook signing secret in Yoco and this service. Refund execution and payout reconciliation remain manual; record approved refunds as expense ledger entries and handle provider-side refunds in the Yoco merchant account.

See Yoco's [Checkout API guide](https://developer.yoco.com/guides/online-payments/accepting-a-payment) and [webhook verification guide](https://developer.yoco.com/guides/online-payments/webhooks/verifying-the-events) for account setup and test/live key management.

Guest-facing reminders are stored in-app and scheduled by the application worker; email reminders enter the durable outbox when due. Email requires SMTP. Check-in/out confirmations are operational records only and do not replace reception identity verification or physical key handover. Breakfast orders are associated with a stay and dated menu item; configure the real menu and prices before collecting orders.

## Operational limitations and launch requirements

- Real OAuth, SMTP, Yoco, callback-domain, email consent, and live-merchant checks require owner credentials and cannot be completed in this repository.
- The system provides a usable staff console, but it is an initial property-management implementation, not a channel manager. No integration with Booking.com, point of sale, external accounting, taxes/VAT, or staff payroll is configured.
- Automatic confirmation is not enabled by default. Staff must configure the inventory and rules before opting in.
- Define retention, export/deletion, access auditing, privacy notice, incident response, and encrypted/offsite backup procedures before production, including a POPIA review.
