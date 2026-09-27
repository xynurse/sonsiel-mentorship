# TODO — SONSIEL Mentorship Platform Roadmap

What's left to ship and then evolve the platform. Migration (Phases 1–3) is done; the rest is the product roadmap.

Items are grouped by phase. Within a phase they're ordered by what should happen first.

---

## Phase 4 — Quick wins ✅ Complete

- [x] **Quick actions: split "View Documents"** into "View My Documents" + "View Platform Documents" on the dashboard.
- [x] **Analytics chart colors** — fixed mentee-gray contrast on user-distribution chart.
- [x] **Investigate missing mentor profiles in admin Connections** — resolved.
- [x] **Reactivate NurseHack4Health program** — `is_active = true`.
- [ ] **Change favicon** — deferred; needs source asset (logo/image file) from project owner.

---

## Phase 5 — Dashboard insights ✅ Complete

- [x] **Recent activity widget**
- [x] **Progress widget**
- [x] **Goals brief widget**
- [x] **Mentor/mentee assignment card**
- [x] **Hyperlink all stat boxes**
- [x] **Multi-program selector on login**

---

## Phase 6 — Profile, calendar, goals, docs ✅ Complete

- [x] **My Profile: render full onboarding survey**
- [x] **Calendar: agenda view toggle**
- [x] **Calendar: availability marking**
- [x] **Calendar: subscribed ICS feed**
- [x] **Goals page** — at-risk surfacing, split empty states
- [x] **Documents page restructure** — My / System / Shared With Me layout

---

## Phase 7 — Admin tooling ✅ Complete

- [x] **Award certificates UI**
- [x] **Upcoming meetings dashboard**
- [x] **User list: click-through profile + Last Active column**
- [x] **Dormant filters (14/30/60/90 days)**
- [x] **Ping user** (in-app + email)
- [x] **Connections: unmatched toggle**
- [x] **Productivity metrics overhaul**
- [x] **Analytics: clickable performance summary boxes**

---

## Phase 8 — Application intake + onboarding workflow ✅ Complete

- [x] **External-facing application form** at `/apply` — 5-step wizard, full Fillout survey mapped, JSONB storage.
- [x] **Application pipeline** — PENDING → REVIEWING → APPROVED/WAITLISTED/REJECTED status transitions in admin UI.
- [x] **Admit/activate flow** — "Activate Account" button provisions user, pre-populates mentor/mentee profiles from application data, sends set-password email.
- [x] **Onboarding sign-off** — Code of Conduct acceptance gate with canvas signature. Existing users backfilled.
- [x] **Cohort assignment** — after activation, admin assigns users to a cohort from the applications queue.

---

## Phase 9 — Theme rework ✅ Complete

- [x] **Notion-style CSS token pass** — warm palette, neutral dark mode, hairline borders, real shadows, Inter typography.

---

## Phase 10 — Surveys

- [ ] **Survey builder** — native survey creation UI, writes to existing `surveys` schema. *(Next after onboarding)*

---

## Phase 10 (revised) — Meeting logging

**Decision (2026-05-28):** External calendar integration (Google Meet / Zoom OAuth) is descoped. It's a significant lift and unlikely to be fully utilized given the program structure. Members will **log meetings manually** within the platform using the existing meetings UI and `meeting_logs` table. No calendar auth, webhook infrastructure, or "invite the platform" mechanism needed.

- [x] **Meeting integration** — ~~Google Meet / Zoom~~ → manual in-platform logging. Already built; no further work needed.

---

## Phase 11 — Calm Clinical, Phase 2 (design de-AI pass) ✅ Complete (2026-07-02)

Extends the sage/Hanken Grotesk theme (commit `5f1ff5d`, login-only) across the whole app. Audit found 200+ hardcoded Tailwind palette colors across 30+ files — rainbow status badges, per-card stat colors, leftover gradient blobs.

- [x] **Semantic status palette** — `--success` / `--warning` / `--info` tokens (light + dark) in `index.css`, exposed in Tailwind; `status.*` colors retuned to tokens.
- [x] **Shared primitives** in `components/shared/` — `PageHeader`, `StatCard` (extracted from home), `EmptyState`, `StatusBadge` (single status→tone map), `EventTypeIndicator`, `notification-meta` (21 types → icon + 3 calm tones).
- [x] **Worst-page sweep** — calendar, notifications + bell, admin/connections, admin/matching, admin/applications, forgot-password (leftover glow blobs) onto tokens/primitives.
- [x] **Long tail** — every remaining client file swept; **zero raw Tailwind palette classes remain** in client/src. reset-password.tsx (missed by the original redesign) rebuilt to match login/forgot-password.
- [ ] **Follow-ups** — adopt PageHeader/EmptyState on remaining pages that kept bespoke headers for `data-testid` reasons; unify remaining spinner-only loading states on skeletons; visual QA pass in dark mode.

## Phase 12 — Feature roadmap (from 2026-07-02 product audit)

Ranked for a program of dozens of users. Tier 1 first.

### Tier 1 — high value, schema mostly exists
- [x] **Match health dashboard** — per-match last-message/last-meeting recency for admins; flag pairs inactive 14+ days. Shipped: `/admin/match-health`, worst-first, health + cohort filters. Logic in `shared/match-health.ts`.
- [x] **Automated match nudges** — in-app + email check-in when no message in 7 days / no meeting in 2 weeks. Preview-then-confirm UI on the Match Health page; 3-day grace + 7-day cooldown; defaults to dry-run. Now genuinely scheduled: `GET /api/cron/match-nudges` (Bearer `CRON_SECRET`, fails closed with 503 if unset) runs weekly via the `crons` entry in `vercel.json` — Mondays 14:00 UTC. `CRON_SECRET` is set on Vercel Production.
  - [ ] **Still DORMANT until the enum migration below is run.** The job writes a `MATCH_CHECK_IN` notification, which the production `notification_type` enum does not yet contain.
  - [ ] **Do not deploy the cron before the enum exists** — otherwise the first Monday run throws on every pair.

### Blocker: `MATCH_CHECK_IN` enum migration — ready to run, not yet run

`MATCH_CHECK_IN` is in `shared/schema.ts` but not in the production `notification_type` enum. The DDL and the tooling to apply it now exist; what's left is running it against production.

- [x] **DDL recorded** — `migrations/manual/2026-08-24_match_check_in_enum.sql`. This project uses `drizzle-kit push` and has no migration runner, so `migrations/manual/` is the trace of hand-applied production DDL (see its README).
- [x] **Apply tooling** — `scripts/sync-enums.ts` diffs every `pgEnum` in `shared/schema.ts` against a target database and adds what's missing. Additive only: never drops a value or a type, never touches tables. Dry-run by default, `--apply` to write, re-reads `pg_enum` afterward to verify. Exit 2 on drift, so it also works as a pre-deploy check.
- [ ] **Run it against production.**

```bash
TARGET_DATABASE_URL='postgres://...' npx tsx scripts/sync-enums.ts          # report first
TARGET_DATABASE_URL='postgres://...' npx tsx scripts/sync-enums.ts --apply
```

The script reads `TARGET_DATABASE_URL`, **not** `DATABASE_URL` — the one in the local `.env` points at a stale pre-cutover database, not production. Production's is stored Sensitive on Vercel and cannot be read back via `vercel env pull`; get the connection string from the Neon dashboard.

Before `--apply`, check the fingerprint the script prints. The stale database shows **0 messages, 0 CoC acceptances, 0 applications** (confirmed 2026-08-24); production will show non-zero. If those three are zero, you are pointed at the wrong database — stop.

A dry run against the stale database on 2026-08-24 confirmed `notification_type: MATCH_CHECK_IN` is the **only** drift across all 65 enum types. Production may differ; the report step will say.

- [x] **Post-meeting session feedback** — 2-question star rating (`SessionFeedbackDialog`) wired into the member dashboard (`home.tsx` "Recent Sessions") and admin meetings page (Feedback column + view dialog + program-wide rollup card). Stored in the existing `mentorFeedback`/`menteeFeedback` jsonb columns; no migration.
- [x] **Survey builder** (was Phase 10) — question-builder UI already existed; added response **analytics** (per-question aggregates: rating averages/distribution, option/checkbox breakdowns, free-text lists) as a Summary tab, plus the missing `DELETE /api/surveys/:id` endpoint the UI already called.
- [x] **Onboarding progress widget** — `GET /api/onboarding/progress` derives a 6-step checklist from real activity (profile, CoC, match, goal, message, meeting); `OnboardingChecklist` on `home.tsx` shows "N of 6 steps" and hides once complete.

### Tier 2
- [ ] **Message reactions** — `messages.reactions` jsonb exists; add endpoint + picker UI.
- [ ] **Cohort broadcast messaging** — admins can currently only ping 1:1.
- [ ] **Program summary report export** — one-click PDF/CSV outcomes report for stakeholders.
- [ ] **Journal upgrades** — visualize existing mood field, tags/filtering, reflection prompts.

### Tier 3 — hygiene/compliance
- [ ] **GDPR self-service** — data-export endpoints exist with no UI; account-deletion table exists with no endpoints.
- [ ] **Close stubs** — force-logout returns "coming soon" (`routes.ts:212`); membership-checking TODO at `routes.ts:3919` is on an access-control path — review.
- [ ] **Mobile refinements** — messages layout on narrow screens, collapsible documents tree; pagination on long lists.

---

## Carried over from migration

See sections below. DNS cutover and deploy wrap-up are complete (2026-06-12); remaining items are operational follow-ups (guide re-upload, Ably verification, observability).

---

## P0 — Phase 3 wrap-up: deploy ✅ Complete

- [x] Provision Vercel Blob on the `sonsiel-mentorship` project.
- [x] `BLOB_READ_WRITE_TOKEN` confirmed set on Vercel Production + Preview.
- [x] `ABLY_API_KEY` set on Vercel.
- [x] Pushed to `main`; Vercel auto-deploying.
- [x] **DNS cutover** — `mentorship.sonsiel.org` resolves to Vercel (76.76.21.21) and serves the production deployment. Verified 2026-06-12.
- [ ] **Re-upload 10 program guides** via admin UI. *(Unblocked — cutover is done.)*

---

## P0 — Phase 2 wrap-up: Ably ✅ Complete

- [x] `ably` v2 installed; socket.io removed.
- [x] `server/realtime/ably.ts` live.
- [x] `ABLY_API_KEY` provisioned and set on Vercel (Production + Preview).
- [x] Phase 2 pushed to `main`; deployed.

### Verification

- [ ] Two browsers logged in as different users in the same conversation: typing in one shows the typing indicator in the other within 1s.
- [ ] Sending a message in one shows up in the other without a page refresh.
- [ ] Triggering an admin action that creates a notification (e.g., assign a task) updates the recipient's notification bell badge live.
- [ ] Open browser devtools network tab and confirm Ably's WebSocket connection comes up (URL contains `realtime.ably.io`).

---

## P1 — DNS cutover ✅ Complete (verified 2026-06-12)

- [x] Add `mentorship.sonsiel.org` as a domain on the Vercel project.
- [x] DNS points at Vercel — `mentorship.sonsiel.org` resolves to 76.76.21.21 and serves the production deployment (same ETag as `sonsiel-mentorship.vercel.app`).
- [x] Set `APP_URL=https://mentorship.sonsiel.org` in Vercel production env (2026-06-12) and redeployed production to pick it up.
- [ ] Re-upload 10 program guides via admin UI.

---

## P2 — Cleanup after Phase 2

Done as part of Phase 3 (1.1.0):

- [x] Delete the legacy object-storage integration directory.
- [x] Drop `@google-cloud/storage`, `google-auth-library`, `@uppy/*`.

Done as part of Phase 2 (1.2.0):

- [x] Delete `server/websocket.ts` (replaced by `server/realtime/ably.ts`).
- [x] Drop `socket.io`, `socket.io-client`, `@types/socket.io-client`, `bufferutil`.

General hygiene:

- [x] Drop the three legacy host-specific Vite plugins from `devDependencies` (commit `cbb2f12`).
- [x] Delete `cookies.txt` and `prod_cookies.txt` from the repo root (2026-06-12).
- [x] Delete `production-migration.sql` (2026-06-12).
- [x] Delete the legacy host config files (2026-06-12).
- [x] Delete the legacy `script/build.ts` and `build:legacy` npm script (already gone).
- [x] `/tmp/mentorship-source.dump` no longer present.
- [ ] Drop the legacy platform-managed Neon project from the Neon dashboard (no longer in use).
- [x] Update `DEPLOYMENT_GUIDE.md` to reflect Vercel as the primary host (2026-06-12).
- [ ] Decommission the old pre-Vercel hosting project (read-only fallback period at owner's discretion).

---

## P3 — Codebase hygiene

The migration surfaced several pre-existing issues. Not blocking, but worth addressing.

### Pre-existing TypeScript errors ✅ Fixed

All 14 pre-existing errors were fixed in commit `13ddd03`. `npm run check` passes clean (verified 2026-06-12).

### Bundle size

- [ ] `pdf-export-Bik-HkE3.js` is 596 KB minified. Consider lazy-loading the PDF flow rather than including jspdf in the main bundle.
- [ ] `BarChart-BMNgOxqN.js` is 390 KB. Recharts is heavy; route-level code-splitting helps.

### Dependencies ✅ Resolved

- [x] `npm audit` reports **0 vulnerabilities** (cleared in commit `26d2413`; verified 2026-06-12).
- [x] `bufferutil` removed along with socket.io.

### Observability

- [ ] Wire up Vercel Logs to a long-term sink (Datadog, Logtail, or just S3 archival).
- [ ] Add error-boundary reporting on the client (Sentry or similar). The current admin error log only captures server-side exceptions.

---

## Open questions for the project owner

1. **Existing files in the document library** — migrate them, or accept that pre-Phase-1 uploads are gone?
2. **Profile photo URL convention** — store full Blob URLs (preferred) or keep an indirection route?
3. **Communication plan for DNS cutover** — when, and to whom?
4. **Legacy host decommissioning** — keep around as a read-only fallback for a month, or shut down on cutover day?
5. **Default super-admin password** — `SuperAdmin123!` is in `DEPLOYMENT_GUIDE.md` and was potentially the original seed value. Has it been rotated for the production accounts? (`mentor@sonsiel.org`, `xyrn@outlook.com`)
6. **NurseHack4Health** — soft-deleted. Should it be hard-deleted (drop the row + the 2 admin memberships), or stay as inactive in case of revival?

---

## Status legend

- [x] Done
- [ ] Pending

For deployment/operational state see [CHANGELOG.md](./CHANGELOG.md). For audit findings see [AUDIT.md](./AUDIT.md). For the user-facing feature catalog see [FEATURES.md](./FEATURES.md).
