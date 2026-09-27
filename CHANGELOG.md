# Changelog

All notable changes to the SONSIEL Mentorship Platform (`xynurse/sonsiel-mentorship`).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates are local to the project owner.

---

## [Unreleased]

### Added — 2026-08-24

- **A path for hand-applied production DDL.** The project manages schema with `drizzle-kit push` and has no migration runner — `migrations/` held a drizzle snapshot and journal but no `.sql` files — so DDL applied by hand to production left no trace. Added `migrations/manual/`, outside the migrations root where it cannot collide with `drizzle-kit generate` numbering, holding dated idempotent `.sql` files plus a README explaining the convention. First entry: `2026-08-24_match_check_in_enum.sql`.
- **`scripts/sync-enums.ts`** — diffs every `pgEnum` declared in `shared/schema.ts` against a target database and adds missing values. Additive only: it never drops an enum value or type and never touches tables or columns. Dry-run by default; `--apply` writes each `ALTER TYPE ... ADD VALUE IF NOT EXISTS` as a standalone statement outside a transaction (Postgres forbids using a new enum value in the transaction that added it), then re-reads `pg_enum` to verify rather than trusting the writes. Exits 2 on drift, so it doubles as a pre-deploy check.
  - Reads `TARGET_DATABASE_URL`, deliberately **not** `DATABASE_URL`, so the stale pre-cutover database in the local `.env` cannot be hit by accident. It prints a row-count fingerprint (`users`, `messages`, `coc_acceptances`, `program_applications`) before doing anything — the stale database shows 0 for the last three.
  - A dry run on 2026-08-24 confirmed `notification_type: MATCH_CHECK_IN` is the only drift across all 65 enum types.

### Added — 2026-08-18

- **Match nudges are now actually scheduled.** The Tier 1 "automated match nudges" shipped in 1.6.0 had no scheduler — `runMatchNudges` was only reachable from the two admin-triggered endpoints, so a human had to remember to visit `/admin/match-health` and click send. Added `GET /api/cron/match-nudges`, authenticated with a `Bearer $CRON_SECRET` header (Vercel Cron supplies this automatically), plus a `crons` entry in `vercel.json` running it Mondays at 14:00 UTC. The endpoint **fails closed**: if `CRON_SECRET` is unset it returns 503 rather than running unauthenticated. Runs are recorded as `SCHEDULED_JOB_EXECUTED` audit entries. `CRON_SECRET` has been set on Vercel Production.

### Pending (see [TODO.md](./TODO.md))

- **`MATCH_CHECK_IN` enum migration — tooling ready, still not run, still gating the cron.** The scheduled job writes a `MATCH_CHECK_IN` notification; production's `notification_type` enum does not contain that value. Run `npx tsx scripts/sync-enums.ts --apply` against production **before** deploying the cron, or the first scheduled run fails on every pair.

### Deploy wrap-up — 2026-06-12

- **DNS cutover confirmed complete** — `mentorship.sonsiel.org` resolves to Vercel and serves the production deployment.
- **`APP_URL=https://mentorship.sonsiel.org`** set in Vercel production env; production redeployed so email links and ICS feeds use the custom domain.
- **Legacy-host artifacts removed from disk** — `cookies.txt`, `prod_cookies.txt`, `production-migration.sql`, and the old host config files (all were untracked).
- **`DEPLOYMENT_GUIDE.md` rewritten** for Vercel as the primary host.

### Pending (see [TODO.md](./TODO.md))

- **Re-upload 10 program guides** through the admin UI.
- **Ably realtime verification** — two-browser smoke test (typing indicators, live messages, notification badges).
- **Favicon** — deferred; needs source asset from project owner.
- **Observability** — client error reporting (e.g. Sentry) and a log drain for Vercel logs.

---

## [1.6.0] — 2026-08-08 — Phase 12 Tier 1: match health, nudges, session feedback, survey analytics, onboarding

Completes the Tier 1 slate of the Phase 12 feature roadmap and folds in the Phase 11 design follow-ups. Merged via [#2](https://github.com/xynurse/sonsiel-mentorship/pull/2).

### Added

- **Match health dashboard** — `/admin/match-health`, worst-first, flags pairs inactive 14+ days (health + cohort filters; logic in `shared/match-health.ts`).
- **Automated match check-in nudges** — in-app + email when a match goes quiet (no message 7d / no meeting 2wk). Preview-then-confirm on the Match Health page, 3-day grace + 7-day cooldown, dry-run by default. **Dormant until** `MATCH_CHECK_IN` is added to the production `notification_type` enum (see [TODO.md](./TODO.md) — pending migration).
- **Post-meeting session feedback** — 2-question star rating after a logged meeting. Members rate from the dashboard's "Recent Sessions" card; admins see a Feedback column, a per-session view dialog, and a program-wide rollup (average, distribution, sessions rated) on the meetings page. Stored in the existing `mentorFeedback`/`menteeFeedback` jsonb columns — no migration.
- **Survey response analytics** — the admin survey responses dialog gains a Summary tab with per-question aggregates (rating averages + distribution, single/multi-select and checkbox breakdowns, free-text answer lists) alongside the existing per-respondent view. Added the `DELETE /api/surveys/:id` endpoint the delete button already relied on (removes the survey and its responses).
- **Onboarding progress widget** — `GET /api/onboarding/progress` derives a six-step getting-started checklist from real activity (profile, Code of Conduct, first match, first goal, first message, first logged session). The dashboard shows "N of 6 steps" for new members and hides the card once every step is done.

### Changed

- **Phase 11 design follow-ups** — adopted the shared `PageHeader`/`EmptyState` primitives across the remaining pages that still carried bespoke headers, and unified page-level loading on skeletons instead of bare spinners.

### Pending

- **`MATCH_CHECK_IN` enum migration** — run `ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'MATCH_CHECK_IN'` against production before the nudges endpoints will work. Not yet run.

---

## [1.5.0] — 2026-07-03 — Calm Clinical design system (app-wide de-AI redesign)

Replaces the AI-app-builder look with a cohesive "Calm Clinical" design system: sage primary, warm-stone neutrals, Hanken Grotesk typography, and a strict tokens-only color policy. A design audit found 200+ raw Tailwind palette colors across 30+ files (rainbow status badges, per-card stat colors, leftover gradient blobs); all are now gone — **client/src contains zero raw palette color classes**. Commits `5f1ff5d`, `8619f99`, `b2ff96c`.

### Added

- **Semantic status tokens** — `--success`, `--warning`, `--info` (light + dark) in `index.css`, exposed as Tailwind colors alongside the existing `destructive`/`muted`/`primary`. The `status.online/away/busy/offline` colors now derive from these tokens.
- **Shared UI primitives** in `client/src/components/shared/`:
  - `StatusBadge` + `statusTone`/`toneBadgeClass`/`toneDotClass` — single source of truth for status → color across matches, applications, goals, cohorts, and surveys.
  - `PageHeader` — standard title/description/actions header.
  - `StatCard` — extracted from the dashboard; always primary-toned (no per-card colors).
  - `EmptyState` — standard icon/title/description/CTA empty state.
  - `EventTypeIndicator` — calendar event dots and badges from one mapping.
  - `notification-meta` — maps all 21 notification types to an icon + one of just three tones (muted default; success for approvals; destructive for rejected/overdue).

### Changed

- **Theme** — sage/warm-stone palette in light and dark mode, Hanken Grotesk as `--font-sans`, softer radii, Notion-style shadows (commit `5f1ff5d`).
- **Auth pages** — login, forgot-password, and reset-password rebuilt without the AI-era styling: no gradient text/buttons, glow blobs, grid overlays, or the one-off Outfit font. Solid sage CTAs on token-based cards.
- **Notifications (page + bell)** — the 17-color type rainbow replaced by calm muted icon chips; unread is a primary dot + tinted row instead of a red badge.
- **Admin pages** (connections, matching, applications, users, cohorts, meetings, reminders, analytics, and the rest) — status color-map object literals deleted in favor of `StatusBadge`; stat-card icon chips and avatar fallbacks unified to sage; score/health indicators use the semantic success/warning/destructive ladder.
- **Calendar** — event-type dots, badges, and legends share `EventTypeIndicator`; the four ad-hoc empty states use `EmptyState`; hex-gradient decoration removed.
- **All remaining pages** (goals, journal, community, search, survey, program selector, CoC onboarding, certificates, apply, 404) swept onto tokens.
- **TODO.md** — roadmap restructured: Phase 11 (this design pass) and Phase 12 (tiered feature roadmap from the 2026-07 product audit: match health dashboard, automated nudges, session feedback, survey builder, onboarding progress, GDPR self-service).

### Notes for contributors

- Do not use raw Tailwind palette classes (`bg-blue-500`, `text-green-600`, `gray-*`, hex/rgba inline styles) in client code. Use the semantic tokens and shared primitives; extend `STATUS_TONES` in `status-badge.tsx` for new statuses.

---

## [1.4.0] — 2026-06-01 — Phase 8 complete: CoC gate, cohort assignment, admin compliance view

Completes the application intake → activation → onboarding pipeline. Newly-activated users must sign the Code of Conduct before accessing the platform. Admins can assign activated applicants to cohorts directly from the applications queue. The Users admin page now surfaces CoC compliance status.

### Added

#### Code of Conduct onboarding gate

- **`/onboarding/coc` signing page** (`client/src/pages/onboarding/coc.tsx`) — full-page CoC acceptance wizard. Displays the complete SONSIEL Code of Conduct with scroll-to-bottom detection. Canvas-based signature pad (no third-party dependency; native pointer + touch events). Pre-fills name and email from the logged-in user. Form only becomes submittable once the user has scrolled to the bottom, drawn a signature, and filled all fields.
- **`POST /api/onboarding/coc`** — validates the signing payload, inserts a row into `coc_acceptances` (deduplicates), sets `users.has_signed_coc = true`, and logs a `COC_SIGNED` audit event.
- **`GET /api/onboarding/coc`** — returns the current user's acceptance record (or `null`) for status checks.
- **`coc_acceptances` table** — stores `userId`, `version`, `firstName`, `lastName`, `email`, `signatureData` (base64 PNG), `ipAddress`, `userAgent`, `signedAt`.
- **`has_signed_coc` column** on `users` — boolean, default `false`. Backfilled to `true` for all 34 pre-existing users at rollout.
- **`COC_SIGNED` audit action** — added to `auditActionEnum` pgEnum (DB migration) and `AuditAction` TypeScript union.
- **Gate in `ProtectedRoute`** — non-admin users with `hasSignedCoc = false` are redirected to `/onboarding/coc` on every protected route. ADMIN / SUPER_ADMIN roles are permanently exempt.

#### Cohort assignment from applications queue

- **`POST /api/admin/program-applications/:id/assign-cohort`** — accepts `{ cohortId }`, idempotently creates a `cohort_memberships` row for the provisioned user (role inferred from account), and stamps `assignedCohortId` + `assignedCohortAt` on the application record.
- **`assigned_cohort_id` / `assigned_cohort_at` columns** on `program_applications` (DB migration + schema update).
- **Applications page cohort assignment UI** — "Assign to Cohort" dropdown action for provisioned applications (blue, font-medium); "Change Cohort" for already-assigned ones. Cohort picker dialog lists all non-archived/non-completed cohorts with status badges. Cohort name displayed as a secondary `BookOpen` badge in the Status column and as a blue info banner in the detail panel.

#### Admin CoC compliance view

- **`GET /api/admin/users/:id/coc`** — returns the `coc_acceptances` record for any user (admin-only). Used by the detail dialog to surface the exact signature timestamp.
- **CoC column** on the Users table — green `FileCheck` + "Signed" for compliant members; amber `AlertCircle` + "Pending" for unsigned non-admins; muted "N/A" for ADMIN / SUPER_ADMIN accounts (gate-exempt).
- **CoC filter** dropdown (All / CoC Signed / CoC Pending) alongside the existing role, status, and dormancy filters. Card description updates to show e.g. *"3 CoC pending of 37 total"*.
- **View Details dialog** — full-width CoC row shows status + signature timestamp (fetched from backend); unsigned users show amber warning with "Not yet signed".
- **CSV export** — new "CoC Signed" column (Yes / No / N/A per user).

### Changed

- **`program_applications`** PATCH handler now also accepts `assignedCohortId` for direct override.
- **Admin applications page** — dropdown for provisioned rows now shows a single conditional item ("Assign to Cohort" or "Change Cohort") plus a disabled "Account Active" indicator, removing the previous duplication.

---

## [1.3.0] — 2026-05-28 — Product features: UX, admin tooling, application workflow

Large feature drop covering all product work since the Vercel migration (Phases 4–8 partial). Covers dashboard improvements, admin tooling, theme rework, analytics, the external application intake form, and the full applicant → user activation pipeline.

### Added

#### Application intake & activation workflow (Phase 8)

- **`/apply` public intake form** (`client/src/pages/apply-general.tsx`) — 5-step multi-page wizard for Mentor and Mentor applicants. Maps directly to the SONSIEL Fillout survey: personal info, professional background, SONSIEL membership, role-specific questions (11-area interest/comfort ratings, preferred methods, hours, motivations, past experience), and a review step. Submissions create a `program_applications` row with `status: "PENDING"`.
- **`POST /api/apply`** — public (no auth required) endpoint. Deduplicates by email, stores full `applicationData` JSONB.
- **`GET /api/admin/program-applications`** — paginated admin list with optional `?status=` filter.
- **`PATCH /api/admin/program-applications/:id`** — admin status transitions (PENDING → REVIEWING → APPROVED / WAITLISTED / REJECTED) with optional `adminNotes`.
- **`POST /api/admin/program-applications/:id/activate`** — one-click account provisioning for approved applications. Creates the user account, professional profile, and full role-specific profile (mentee or mentor extended) from application data. Generates a 7-day password-set token and sends an activation email. Stamps `provisionedUserId` + `provisionedAt` on the application row.
- **`sendAccountActivationEmail()`** in `server/email.ts` — activation email with a "Set Your Password & Sign In" CTA. Includes next-steps checklist and link fallback text.
- **`program_applications` table** — new Drizzle table with `programApplicationStatusEnum` (`PENDING | REVIEWING | APPROVED | REJECTED | WAITLISTED`). Added `provisioned_user_id` and `provisioned_at` columns for tracking account activation.
- **Admin applications page** (`/admin/applications`) — rewritten to query `program_applications` instead of cohort memberships. Shows applicant, role, institution, status (with ✓ provisioned indicator), submitted date. Full survey detail in a slide-out dialog. Inline status transitions. "Activate Account" button with confirmation dialog for APPROVED + unprovisioned rows. "Account Active" badge + provisioned-on date once activated. "All" filter option.

#### Admin tooling (Phase 7)

- **Admin user list** — Last Active column, click-through to user profile at `/admin/users/:userId/profile`.
- **Dormant user filters** — 14/30/60/90-day inactive toggles on the users list.
- **Ping user** — admin can send an in-app notification + email from any user's profile view. Uses `sendAdminPingEmail()`.
- **Connections: unmatched toggle** — filter to show only unmatched mentors or mentees. Inline unmatched counts per cohort.
- **Admin productivity metrics overhaul** — removed task-based metrics; now tracks goals, conversations, documents, journals, and meeting count only. Removes noise from the activity summary.
- **Analytics: clickable KPI cards** — every summary box on the analytics overview routes to its relevant admin page or switches the active analytics tab. Implemented with `href` + `onClick` on the `KPICard` component.
- **Admin certificates UI** — award certificates to users from the admin panel.
- **Admin upcoming meetings dashboard** — cross-match meeting visibility with date/time context.

#### Dashboard insights (Phase 5)

- **Recent activity widget** — surfaces the latest messages, meetings, doc interactions, and goal updates.
- **Progress widget** — percentage of goals complete, meetings logged, milestones hit, cohort week.
- **Goals brief widget** — compact card linked to `/goals`, with per-goal click-through.
- **Mentor/mentee assignment card** — prominent pairing card with quick-message shortcut.
- **All stat boxes hyperlinked** — every dashboard metric routes to the corresponding detail page.
- **Multi-program selector on login** — users enrolled in more than one program see a program picker after login rather than landing in an arbitrary context.

#### User-facing pages (Phase 6)

- **My Profile: full survey data** — all intake survey fields rendered and editable, including interest/comfort ratings, motivations, preferred methods, availability, and career context.
- **Calendar: agenda view toggle** — list-style alternative to the month grid.
- **Calendar: availability / unavailability marking** — blackout-period blocks with a visual indicator.
- **Calendar: subscribed ICS feed** — per-user `webcal://` URL for Google / Apple / Outlook sync.
- **Goals page** — complete list/add/edit UX with at-risk surfacing and split empty states.
- **Documents page** — My Documents (collapsible) at top, System Resources below, Shared With Me in the right rail.

#### Quick wins (Phase 4)

- **Dashboard quick actions** — "View Documents" split into "View My Documents" and "View Platform Documents".
- **Analytics chart colors** — fixed mentee-gray contrast on the user-distribution chart.
- **NurseHack4Health reactivated** — program soft-deleted during Phase 1 migration is now `is_active = true`.

### Changed

- **`/admin/applications`** redirected from cohort-membership view to the new `program_applications` pipeline.
- **`POST /api/reset-password`** now clears `mustChangePassword: false` so users who set a password via an activation or forgot-password link are not forced to the change-password screen on first login.
- **Theme** (`client/src/index.css`, animated-background, dashboard-layout, admin-layout, card) — full Notion-style rework. Warm `#37352F`-family foreground, neutral `#1F1F1F` dark background (removes blue-navy tint), hairline borders, real box-shadows, `line-height: 1.6`, tightened heading tracking, thin 5px scrollbars. Animated background opacity reduced to ~30% of original; grid overlay removed. Layout labels and icon containers decluttered.
- **Admin layout** — removed "Navigation" group label from sidebars; icon containers stripped of colored background boxes.

### Fixed

- **`mustChangePassword` loop for activated users** — the password-reset endpoint now sets `mustChangePassword: false`, preventing newly-activated users from being bounced to `/change-password` immediately after setting their own password via the activation email link.
- **Missing mentor profiles in admin Connections** — query and data-state issue causing only 2 mentees and no mentors to appear.

### Decisions / descoped

- **Meeting calendar integration (#45)** — descoped. Google Meet / Zoom OAuth integration is a significant lift and unlikely to be fully utilized in the near term. Meetings will be **logged manually by members within the platform** using the existing `meeting_logs` table and meetings UI. No external calendar auth or webhook infrastructure needed.

---

## [1.2.0] — 2026-05-25 — Phase 2: Ably real-time

Replaces the Phase 1 socket.io no-op stub with Ably. Live messaging, typing indicators, presence (online users), and live notification badges all work end-to-end on Vercel — pending an `ABLY_API_KEY` being provisioned.

### Added

- `server/realtime/ably.ts` — Ably wrapper around the REST client (for server publishes) and a token-request issuer for clients. Exposes `emitNotification`, `emitNotificationCountUpdate`, `emitMessageNew/Edited/Deleted/Reaction`, `emitMessagesRead`, and `issueClientToken`. No-ops gracefully when `ABLY_API_KEY` is missing so dev builds without a key still boot (logs a one-time warning).
- `POST /api/ably/auth` — token endpoint. Client SDK calls it via `authUrl`; server mints a 1-hour TokenRequest with `clientId = user.id` and capability scoped to `user:<id>` (subscribe), `conversation:*` (subscribe + publish + presence), and `presence:online` (presence + subscribe).
- `ably` v2.21 dependency.

### Changed

- **Channel layout:** `user:<userId>` for notifications (server publishes only), `conversation:<id>` for message events (server publishes state-changing ops; clients publish transient typing events directly), `presence:online` for online indicators via Ably presence.
- **Server emits Ably events after persisting** in three routes: `POST /api/conversations/:id/messages`, `POST /api/conversations/:id/read`, `DELETE /api/conversations/:conversationId/messages/:messageId`. The send route emits the full sender-attached payload once; clients can de-duplicate against their optimistic temp row.
- **`client/src/hooks/use-messaging.tsx`** rewritten with the Ably Realtime client. Drops the `socket` field from `MessagingContext`. State-changing ops (`sendMessage`, `markAsRead`, `editMessage`, `deleteMessage`, `addReaction`, `removeReaction`) now route through REST, then events arrive via Ably. Typing indicators publish client→Ably directly (transient — no DB write needed).
- **`client/src/components/notification-bell.tsx`** subscribes to its user channel via Ably for live unread-count updates and notification invalidation. Runs its own Ably client because `MessagingProvider` only wraps `/messages`; can be hoisted later if needed.

### Removed

- `server/websocket.ts` — Phase 1 stub no longer needed.
- `socket.io`, `socket.io-client`, `@types/socket.io-client` — uninstalled.
- `bufferutil` — was an `optionalDependencies` entry to speed up socket.io frame parsing; irrelevant without socket.io.

### Security

- Per-user Ably tokens are auth-gated by `requireAuth` middleware. Token TTL is 1 hour; clients can refresh by re-hitting the auth URL.
- `conversation:*` capability is wildcarded. Conversation IDs are unguessable UUIDs (same security model as our Blob URLs), so this is acceptable. Per-conversation capability would require re-minting tokens whenever conversation membership changes.
- Server uses the master API key for publishes (`server/realtime/ably.ts` only); the key never reaches the client.

### Migration / operational notes

- **No data migration needed.** Phase 2 only swaps the realtime transport — DB schemas, REST endpoints, and message rows are untouched.
- **`ABLY_API_KEY` must be set in production + preview before live updates work in deploys.** Without it, message events still flow over REST and the UI degrades to "send works, but other users won't see it until they refetch."

---

## [1.1.0] — 2026-05-25 — Phase 3: Vercel Blob

Replaces the unreachable legacy GCS sidecar (`http://127.0.0.1:1106`) with `@vercel/blob`. Document upload + view + download and profile-photo upload work end-to-end on Vercel — pending `BLOB_READ_WRITE_TOKEN` being provisioned on the project.

### Added

- `server/storage/blob.ts` — Vercel Blob wrapper exposing `streamRequestToBlob` (server-side upload proxy), `streamBlobToResponse` (server-mediated download with ACL preserved upstream), `deleteBlobIfExists`, `blobExists`, and `isBlobUrl`. Per-kind size and content-type limits enforced server-side.
- `POST /api/uploads` — new auth-gated upload route. Accepts `?kind=document|profile-photo&name=<file>` with the raw file as the request body; proxies to Blob via `put()` and returns `{ url, pathname, contentType, size, name }`. Replaces the old `/api/uploads/request-url` + presigned-PUT flow.
- `@vercel/blob` v2 dependency.
- Vercel Blob store `store_yU2vqWCcTiKma2Tc` provisioned on the `sonsiel-mentorship` project (2026-05-25).

### Changed

- `documents.fileUrl` and `users.profileImage` now store full Vercel Blob URLs (e.g. `https://<store>.public.blob.vercel-storage.com/documents/<id>-<filename>`). Existing legacy `objects/uploads/<uuid>` rows continue to be recognized by `isBlobUrl()` as legacy and 404 with a "please re-upload" message until migration runs.
- `/api/documents/:id/view` and `/api/documents/:id/download` now fetch the Blob URL server-side and pipe the response back, preserving the existing ACL model (admin / owner / public / explicit share) unchanged. Inline `viewBlobUrl` Content-Type quirk that motivated the original metadata override is gone — Blob preserves the upload Content-Type faithfully.
- `/api/profile-photo/:userId` is now a backwards-compat shim. For Blob URLs it 302-redirects to the canonical URL; for legacy GCS-style paths it 404s with a helpful message. Front-end avatars read `user.profileImage` directly.
- `ObjectUploader` rewritten as a small click-to-pick component with XHR upload + progress modal. No longer depends on Uppy (`@uppy/aws-s3`, `@uppy/core`, `@uppy/dashboard`, `@uppy/react`).
- `use-upload` hook reduced to a single `uploadFile(file, kind)` helper that POSTs to `/api/uploads`. Removed the old two-step "get presigned URL → PUT to URL" indirection.
- `vercel.json` — dropped the `/objects/(.*)` rewrite (no longer used).

### Removed

- The legacy object-storage integration directory (entire directory): `objectStorage.ts`, `objectAcl.ts`, `routes.ts`, `index.ts`. The ACL-via-GCS-metadata scaffold was vestigial (the `ObjectAccessGroupType` enum was empty); the real ACL has always been DB-driven, so nothing functional was lost.
- `@google-cloud/storage`, `google-auth-library`, `@uppy/aws-s3`, `@uppy/core`, `@uppy/dashboard`, `@uppy/react` — uninstalled.
- `/api/uploads/request-url` route — clients now POST to `/api/uploads` directly.

### Security

- The new upload route enforces auth + per-kind size limits (`5 MB` for profile photos, `50 MB` for documents) and a content-type whitelist (`image/jpeg|png|gif|webp` for profile photos). Documents accept any content type, gated by the existing 50 MB max.
- Blob URLs use `access: 'public'` — they're unguessable but anyone with the URL can read. For documents this is safe because the URL only lives in `documents.fileUrl` (never returned to the client; all reads route through `/api/documents/:id/view|download` which enforce ACL before fetching). For profile photos this is by design (avatars are visible to any logged-in user anyway).

### Migration: start fresh (2026-05-25)

Instead of carrying legacy object-storage files forward, we elected to start fresh. 12 legacy file references existed at the time of cutover:

- **10 document rows deleted** (program track guides + handbooks + code of conduct + mentorship guides). An admin will re-upload these through the new flow post-deploy.
- **2 user profile photos nulled** (`profile_image` set to NULL — users see initials until they re-upload).

No user accounts, applications, cohorts, matches, messages, journal entries, or other relational data was touched. Migration scripts (`scripts/migrate-blobs.ts`, `scripts/count-legacy-files.ts`, `scripts/clean-legacy-files.ts`) were authored, used, and then removed since they were single-use.

---

## [1.0.0] — 2026-05-03 — Phase 1: Vercel deployment

The platform now runs on Vercel Functions with a user-owned Neon Postgres database. Real-time messaging and file storage are temporarily disabled pending Phases 2 and 3.

### Added

- `api/index.ts` Vercel Function entry point that wraps the Express app.
- `server/app.ts` — extracted Express app construction, separate from the local-dev entry.
- `scripts/build-server.ts` — pre-bundles `server/app.ts` to `dist/server.mjs` via esbuild before Vercel's function bundler runs.
- `scripts/seed-prod.ts` — one-shot production seed runner. Replaces the auto-seed-on-boot pattern that ran on every start under the previous host.
- `scripts/auth-diag.ts` and `scripts/programs-diag.ts` — read-only DB diagnostic helpers.
- `vercel.json` — build, output, function, and rewrite configuration.
- `.env.example` — documents the four required environment variables.
- An admin-only `/api/admin/email-diagnostics` endpoint that reports whether `RESEND_API_KEY` is configured.

### Changed

- **Database**: dumped from the legacy platform-managed Neon project and restored into a user-owned Neon project. 59 tables and all 34 user accounts (with scrypt password hashes) verified intact.
- **Email integration**: replaced the legacy connector-based Resend credential fetch with direct `RESEND_API_KEY` and `RESEND_FROM_EMAIL` environment variables.
- **`getTrustedBaseUrl()`** in [server/email.ts](./server/email.ts) now prefers `APP_URL`, then `VERCEL_PROJECT_PRODUCTION_URL`, then `VERCEL_URL`, with `localhost:5000` as the final fallback.
- **Auto-seed** moved out of the boot path. Run `npm run seed` once after the database is provisioned, instead of on every cold start.
- **Build pipeline**: `npm run build` is now `tsx scripts/build-server.ts && vite build`. The legacy esbuild server bundle is preserved as `npm run build:legacy`.
- **`server/static.ts`** uses `import.meta.dirname` instead of `__dirname` (ESM-safe).
- **`vite.config.ts`** no longer references the legacy host's runtime-error-modal or other host-specific dev plugins.
- **`server/routes.ts`** import for object storage points at the object-storage module's `index` file explicitly instead of the bare directory name. ESM doesn't allow directory imports; this was masked in dev by tsx but failed under Vercel's bundler.
- **`server/index.ts`** is now a local-dev-only entry. It calls `createApp` and conditionally pulls in the Vite middleware. The Vercel function never imports Vite.
- **NurseHack4Health program** soft-deleted (`is_active = false`) and removed from `ensurePrograms()` in `server/auto-seed.ts`. The user-facing program switcher hides inactive programs via `getUserPrograms()`.

### Stubbed (returns no-op responses pending Phases 2 and 3)

- **`server/websocket.ts`** — every export (`setupWebSocket`, `getOnlineUsers`, `isUserOnline`, `emitNotification`, `emitNotificationCountUpdate`) is now a no-op. The original socket.io implementation lives in git history before commit `14d46fc`.
- **Document upload, view, and download routes** still resolve, but the underlying `ObjectStorageService` will throw when its methods are called because the legacy storage sidecar (`http://127.0.0.1:1106`) is unreachable on Vercel.

### Removed

- The three legacy host-specific Vite plugin imports from `vite.config.ts` (kept as `devDependencies` for now).
- The legacy connector-based `getCredentials()` flow in `server/email.ts`.
- All legacy host environment-variable reads from `server/email.ts` and the email-diagnostics route in `server/routes.ts`.

### Fixed

- **`FUNCTION_INVOCATION_FAILED` on every API request** (Phase 1 deploy blocker). Two compounding causes:
  1. ESM directory import in `server/routes.ts` (fixed by appending `/index`).
  2. `server/app.ts` had `await import("./vite")` under the dev-mode branch; esbuild traced the literal string and pulled vite → rollup into the function bundle. Rollup needs platform-specific native binaries that Vercel's `npm install` skipped (`@rollup/rollup-linux-x64-gnu`). Fixed by yanking the vite import out of `createApp` entirely and pre-bundling `server/app.ts` to a single `.mjs` artifact via `scripts/build-server.ts`.

### Security

- `SESSION_SECRET` rotated to a fresh 32-byte hex value before the first Vercel deploy. Store and rotate via `vercel env add SESSION_SECRET production`.
- `.env` and `.vercel` added to `.gitignore`.

### Migration / operational notes

- **Source dump** preserved at `/tmp/mentorship-source.dump` (212 KB, custom format) as a safety net for the database cutover. Delete after Phase 3 is verified in production.
- **Legacy platform-managed Neon endpoint** (`ep-sweet-poetry-ahg49omp`) is no longer in the production path but still exists. Auto-suspends after inactivity. Free to leave; nothing depends on it.
- **Vercel project**: `mike-9206s-projects/sonsiel-mentorship`, linked to the `xynurse/sonsiel-mentorship` GitHub repo. Pushes to `main` auto-deploy.

---

## Older history

Everything before commit `14d46fc` predates the migration and is preserved in git. The most recent pre-migration commit was `dc3d854 — Fix notification URL generation and remove debug logs`.
