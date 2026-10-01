# Guest-house operations issue board

Local delivery board for the guest-house business system. P0 blocks launch, P1 is high priority, P2 is normal follow-up, and P3 is improvement work. “Done” indicates repository implementation; external credentials, live-domain verification, and owner policies remain open until checked in production.

| ID | Priority | Status | Work item | Acceptance criteria |
|---|---|---|---|---|
| BE-01 | P1 | Done | Add SQLite business schema and persistent sessions | Users, provider identities, offerings, bookings, inventory, payments, ledger, email, guest notes, tasks, settings, and audit records persist with indexes/FKs. |
| BE-02 | P1 | Done | Add Google and Facebook OAuth | First sign-in creates an account, repeat login uses provider ID, Google-verified allowlisted owner can bootstrap admin. |
| BE-03 | P1 | Done | Enforce account and staff authorization | Staff/admin session gates, admin-only account-role changes, director/admin business settings, recent-auth identity changes, last-admin/last-provider protections, audit trail. |
| BE-04 | P1 | Done | Connect reservation/contact forms | Forms persist validated submissions and show truthful success/failure states. |
| BE-05 | P1 | Done | Build protected staff console | Staff can handle reservations, inquiries, guests/notes, inventory, finance, tasks, email and team access; APIs enforce access. |
| BE-06 | P1 | Done | Add resource capacity and availability checks | Reservation holds and confirmed bookings consume dated units/guest capacity; collision-safe transitions, pending expiry and public availability checks. |
| BE-07 | P1 | Done | Add controlled automatic booking confirmation | Admin opt-in confirms only when a mapped active resource is available; requests otherwise remain pending. |
| BE-08 | P1 | Done | Add financial ledger and reports | Cash income/expenses, payment income, balances, booking pipeline, occupancy, date filters, and CSV export are available. |
| BE-09 | P1 | Done | Add secure account linking | Provider subject is attached only to the recently authenticated account; account-owner conflicts and removing the final identity are rejected. |
| BE-10 | P1 | Done | Add durable email notifications | SMTP-configurable queue, delivery polling/retry/backoff, staff alerts, guest receipts, and queue visibility. |
| BE-11 | P1 | Done | Add Yoco hosted checkout and signed webhooks | Server creates Yoco Checkout API sessions; signed, timestamp-checked, idempotent webhooks match checkout, amount, and currency before recording income. |
| BE-12 | P1 | To do | Configure production integrations and deploy securely | Owner configures OAuth, SMTP, Yoco live credentials/webhook, property attendance geofence, HTTPS, trusted proxy, secret management, and live callback verification. |
| BE-13 | P1 | To do | Establish operations, accounting, and POPIA policies | Owner approves booking/cancellation/deposit/tax rules, guest privacy/retention/deletion, refund handling, incident response, and tested encrypted backups. |
| BE-14 | P2 | To do | Reconcile inventory, rates, and opening data | Staff imports/validates every room/venue, actual capacity, prices, blackout dates and confirmed future bookings before accepting auto-confirmation. |
| BE-15 | P2 | To do | Add refund and payout reconciliation | Implement provider refund records/workflow, Yoco settlement/bank reconciliation, and accounting exports. |
| BE-16 | P2 | Done | Add booking change and guest-service workflows | Guest workflows cover eligible reservation changes/cancellations, online check-in/out, dated breakfast orders, Yoco payment history, announcements, reminders, and guest calendars. |
| BE-17 | P2 | Done | Publish staff-managed services and booking options | Staff manage the catalogue and inventory; active inventory drives guest booking/change choices and published catalogue entries appear on Services. |
| BE-18 | P3 | To do | Consolidate static website assets and remove inline code | Shared page components/scripts replace duplicated markup; CSP no longer needs broad inline-script allowances. |
| BE-19 | P1 | Done | Add role-scoped staff operations dashboard | Director, Guest Relations Manager, Conference Coordinator, General Worker, and Housekeeping get scoped navigation and server-enforced permissions. |
| BE-20 | P1 | Done | Add staff attendance, leave, and weekly schedules | Staff can geofence clock-in/out, request leave, see their weekly shifts, and authorized management can review leave/publish schedules. |
| BE-21 | P1 | Done | Add business events and guest breakfast operations | Calendar combines upcoming bookings/events; authorized staff publish events, manage the breakfast menu, and fulfil dated guest orders. |
| BE-22 | P1 | Done | Expand tests for guest and staff journeys | Integration coverage exercises Yoco signature and idempotency, self-service stays/meals/payments, announcements, attendance, leave, schedules, and role access. |

Automatic booking confirmation is off by default. No live provider credentials or production deployment are included. This Markdown board is the tracked project board; no GitHub issue/project-creation integration is available in this environment.
