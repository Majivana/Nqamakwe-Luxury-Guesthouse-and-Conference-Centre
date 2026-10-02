# Website audit

**Scope:** Source-level review of the tracked HTML/CSS/JavaScript website and the requested initial backend. This is not a live-host, dependency, infrastructure, or legal-compliance assessment.

## Findings and changes

| Priority | Finding | Status |
|---|---|---|
| High | Login form simulated success in the browser; Google/Facebook links were placeholders; register/forgot-password linked to pages absent from this repository. | Replaced with provider OAuth entry points and current-session/sign-out UX. |
| High | Booking and contact forms submitted to PHP handlers absent from this static project. Contact JavaScript also displayed a success state without a server response. | Added validated SQLite-backed endpoints and wired both forms to the API. |
| High | A Google Maps/Places API key is embedded in public page scripts. Browser keys are visible by design, but unrestricted keys can be abused. | Not rotated from source; owner must rotate/restrict the key by HTTP referrer and enabled API. |
| Medium | Google review author, avatar URL, and review text were interpolated into `innerHTML` without escaping on four pages, creating a DOM-injection/XSS risk if upstream content is malicious. | Escaped inserted values on the home, about, bookings, and services pages. |
| Medium | The shared script ran carousel intervals on pages without carousel elements, eventually throwing on empty selections. | Start intervals only when matching slides/dots are present. |
| Medium | There was no backend account, reservation, inquiry, or offering store/authorization layer. | Added SQLite schema, provider identities, session authentication, customer/admin APIs, input checks, and rate limits. |
| Medium | Initial backend had no account linking, capacity checks, or business workflows. | Added owner-confirmed account linking, inventory/hold capacity checks, staff-managed confirmations, task tracking, finance, and guest management. Cross-provider email matches intentionally never auto-merge. |
| Medium | Initial backend had no email delivery or payment workflow. | Added persistent SMTP outbox and Yoco hosted checkout with signed, timestamp-checked webhooks. Live credentials and provider verification remain external. |
| Low | Site-wide external links, image references, duplicated metadata, and Google review calls are embedded across large standalone HTML pages. | Retained to avoid unrelated content/design changes; verify production URLs and consolidate shared components separately. |

## Security and operational notes

- OAuth secrets and a strong session secret must be configured outside source control. Admin bootstrap only trusts an explicitly allowlisted, provider-verified Google email. Facebook accounts do not become admins automatically.
- The API accepts browser writes only from its own origin, uses HTTP-only/SameSite session cookies, caps JSON payloads, and limits public submissions. Use HTTPS and set `TRUST_PROXY` correctly behind a reverse proxy.
- The content security policy permits inline scripts/styles to preserve the existing pages; removing those allowances requires first moving legacy inline code into vetted static assets.
- SQLite data and session files include personal information. Restrict file access, establish encrypted backups and retention/deletion procedures, and never expose the data directory from the web server.
- The operations backend now provides a persistent email outbox, inventory availability checks, staff-managed booking confirmation, and Yoco hosted checkout. Live provider setup and reconciliation still require owner configuration.

## Follow-up security and performance review (2 October 2026)

- **Fixed, medium:** the shared staff calendar no longer returns guest names. Calendar access is granted to housekeeping and general-worker roles, whose documented calendar is non-identifying; a regression test verifies the response omits guest contact fields.
- **Fixed, hardening:** API responses are marked `Cache-Control: no-store`; only public static assets are cached for one hour, and HTML remains revalidatable. Gallery videos use `preload="none"` to avoid requesting video media before playback.
- **Outstanding, low:** Google Maps browser keys appear in the public page source by design. Verify each key is restricted by HTTP referrer and only the required Maps APIs; rotate it if its restrictions or usage are unknown.
- Source inspection found no upload endpoints, Docker/deployment manifests, or CI workflow. No Lighthouse installation or configured live deployment is present, so this review does not claim live-host, Core Web Vitals, or production-provider measurements. The checked-in image directory is approximately 134 MiB, including 15 gallery videos (approximately 68.8 MiB); optimize and measure image/video delivery against production traffic before adding a CDN or changing media quality.
- Dependency audit reported no known vulnerabilities at review time. `npm test` passed all 33 integration tests; JavaScript syntax and `git diff --check` passed. Live OAuth, SMTP, Yoco, hosting headers, and browser performance were not tested.
