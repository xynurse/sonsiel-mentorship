# Deployment Audit — Vercel Phase 1

**Audited URL:** `https://sonsiel-mentorship.vercel.app`
**Date:** 2026-05-03
**Method:** Read-only API smoke testing, frontend route fetching, code review of import graph.

---

## Summary

Phase 1 deployment is healthy. The SPA shell loads on every tested route (HTTP 200), all API endpoints answer with proper JSON (401 when auth-gated, never a 5xx HTML leak), and basic CRUD/auth/email flows reach the database. Real-time and file-byte transport are both broken as expected — socket.io has no server (the client will reconnect-loop) and any code path touching the legacy GCS sidecar will 500 once exercised.

Nothing surprising surfaced beyond what's already documented. The migration is in the predicted "skeleton works, media + realtime are dead" state.

**Do not cut DNS until Phases 2 and 3 land** — profile photos, document upload/view/download, and live messaging/notifications are user-visible failures the moment a real user logs in.

---

## Endpoint smoke test (20 hits)

| Result                       | Endpoints                                                                                                                                                                                                                                                                              | Notes                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 401 (correctly auth-gated)   | `/api/user`, `/api/profile`, `/api/notifications*`, `/api/conversations`, `/api/documents`, `/api/folders`, `/api/goals`, `/api/meetings`, `/api/journal`, `/api/reminders`, `/api/programs*`, `/api/matches/my`, `/api/users/online`, `/api/community/threads`, `/api/certificates`, `/api/tracks`, `/api/admin/stats`, `/api/audit-logs`, `/objects/foo`, `POST /api/uploads/request-url` | Wired correctly.                                                                   |
| 200 / 4xx with sane JSON     | `POST /api/login` (401 bad creds), `POST /api/forgot-password` (200 generic), `GET /api/cohorts/:id/questions` (200 `[]`), `GET /api/public/cohorts/test` (404), `GET /api/verify-email/foo` (400), `GET /api/profile-photo/<missing>` (404 early-out), `GET /api/certificates/verify/abc` (404)                                          | Healthy.                                                                           |
| SPA pages (HTML 200)         | `/`, `/login`, `/register`, `/forgot-password`, `/admin`, `/community`, `/goals`, `/journal`, `/documents`, `/calendar`, `/reminders`, `/notifications`, `/my-profile`, `/apply/test`                                                                                                  | All 200 HTML.                                                                       |
| Telltale                     | `/socket.io/?EIO=4&transport=polling` returns **200 text/html** (SPA fall-through)                                                                                                                                                                                                     | Confirms no socket server. Client `io()` will reconnect-loop forever.              |

**Zero 500/502/504/HTML-leak observed across the full sample.**

---

## Feature impact map

### ✅ Works

- **Auth**: register, login, logout, forgot-password, reset-password, change-password, verify-email, complete-profile.
- **Profiles** (data only): view/edit fields, mentor/mentee profile setup, role management.
- **Mentor↔Mentee matching** (admin): cohorts, applications, matching config, auto-match, manual match, available mentors/mentees lists.
- **Mentorship matches**: `/api/matches/my`, mentee goals/profile/shared-document *listings*.
- **Meetings/Calendar**: full CRUD on `/api/meetings`.
- **Goals/Tasks**: full CRUD, milestones, approval flow.
- **Journals**: full CRUD, mentee-entries view.
- **Community boards / Mentee community / Threads**: categories, threads, replies, pin/unpin, access checks.
- **Reminders**: full CRUD, complete/dismiss, mentee reminders.
- **Surveys**: admin CRUD + responses submission.
- **Certificates**: list/get/verify/issue (record only — no PDF email distribution observed).
- **Admin dashboard**: stats, users, cohorts, applications, programs, audit logs, settings, mentor/mentee profile lists, bulk import (CSV in-memory), bulk password reset, welcome emails, exports.
- **Notifications (data layer)**: list, unread-count, mark-read, archive, delete.
- **DM messaging (REST)**: conversations, messages, send/read/delete.
- **Email**: forgot-password reaches the live Resend path and returns clean.

### ⚠️ Soft broken — REST works, key sub-feature dead

- **Messaging real-time** — Send/receive via REST works, but live delivery, typing indicators, and online presence are silent. Client `use-messaging.tsx` and `notification-bell.tsx` will repeatedly attempt `io()` against `/socket.io/`, get an HTML 200 instead of an EIO handshake, and reconnect-loop noisily in the console. Console spam, but not a functional crash. `/api/users/online` will always return `[]` (server stub `getOnlineUsers()` returns empty array).
- **Notifications** — In-app polling and email work; live bell badge updates won't push. User must navigate or refresh to see new notifications.
- **Profiles** — Data is fine, but profile photo display will 500 as soon as a user has a `profileImage` set (route hits sidecar at `127.0.0.1:1106`). The 404 observed in the smoke test was the missing-user early-out, not a real fetch.
- **Documents** — List/metadata/folders/sharing/ACL all fine; upload (`POST /api/uploads/request-url`), view (`/api/documents/:id/view`), and download (`/api/documents/:id/download`) all 500 once auth passes. `/objects/*` will also fail.
- **Avatars across the app** — `mentee-detail.tsx`, `home.tsx`, `search.tsx`, `community.tsx`, `dashboard-layout.tsx`, `admin-layout.tsx`, `settings.tsx` all bind `<AvatarImage src={user.profileImage}>` directly to the stored object path. Anywhere a stored URL is used directly will break.

### ❌ Hard broken

- **Phase 2 — socket.io server entirely stubbed.** `server/websocket.ts` exports no-ops. Documented and expected.
- **Phase 3 — Legacy GCS sidecar.** The legacy `objectStorage.ts` still hardcodes `http://127.0.0.1:1106`. Every read/write path will hit a closed port on Vercel. Documented and expected.

---

## Critical issues to fix before DNS cutover

1. **Phase 3: Vercel Blob migration** (highest priority).
   - Profile photos and the entire Documents feature are unusable.
   - Drop-in service swap: replace `ObjectStorageService` with `@vercel/blob`.
   - Rewrite four call sites: profile-photo route, documents view, documents download, `registerObjectStorageRoutes` (presign + serve).
   - Drop or repoint the `/objects/(.*)` rewrite in `vercel.json`.

2. **Phase 2: Realtime stack via Ably**.
   - At minimum, gate the client `io()` calls behind a flag or remove the reconnect loop so the JS console isn't flooded.
   - Ideally wire Ably so messaging and the notification bell stop being silent.

3. **Profile photo URL convention** (sub-task of Phase 3).
   - After Blob migration, decide whether to:
     - (a) Store full Blob URLs and keep direct `<img src>` use, or
     - (b) Keep an indirection route like `/api/profile-photo/:id` and fix every direct-reference component.
   - Option (a) is simpler. Option (b) preserves access control if needed.

---

## Recommended next-action ordering

1. **Phase 3 (Blob) first.** Biggest user-visible blast radius — profile photos appear on every page; documents is a primary feature. Lowest implementation risk: drop-in service swap behind the existing four routes.
2. **Phase 2 (Ably) second.** Adds polish to messaging and notifications. Users can survive REST-only messaging short-term; the only acute symptom is console noise.
3. **Cleanup before cutover.**
   - Remove the `/objects/(.*)` rewrite from `vercel.json` once Blob is live.
   - Delete the legacy object-storage integration directory.
   - Delete the websocket stub once the Ably hook lands.
   - Confirm `socket.io-client` is dropped from the client bundle if no longer used.
4. **Nice-to-have.** Add a Vercel Cron for any audit/reminder sweep work that previously ran in-process (none found, but worth confirming with the product team that nothing is silently expected to tick).

---

## Key files referenced

- `server/routes.ts` — sidecar call sites at lines 1597, 3204, 3271; upload route registered at 2985.
- Legacy `objectStorage.ts` (object-storage integration) — hardcoded `127.0.0.1:1106` at line 12.
- `server/websocket.ts` — Phase 1 stub.
- `client/src/hooks/use-messaging.tsx` — client `io()` at line ~94.
- `client/src/components/notification-bell.tsx` — client `io()` at line ~165.
- `vercel.json` — rewrites include `/objects/(.*)`.

---

## Database state at audit time

- 34 users, 33 active, 0 locked, 0 with missing or malformed password hashes.
- 2 super admins (`mentor@sonsiel.org`, `xyrn@outlook.com`); both have valid scrypt hashes.
- 2 programs total, 1 active (`prog_sonsiel_mentorship`); `prog_nursehack4health` is `is_active = false`.
- 33 memberships under the active program; 2 stale memberships under the soft-deleted program (admins enrolled by the old auto-seed).
- 59 tables in the `public` schema, matching the source dump.

---

## Audit subject lines (where to grep)

If you need to reproduce these findings:

- `grep -rn "127.0.0.1:1106" server/` — confirms remaining sidecar references.
- `grep -rn "socket.io" client/src/` — confirms remaining client realtime calls.
- `grep -rn "user.profileImage\|profileImage =" client/src/` — confirms direct-bind usage.
- `npm run build` — should succeed and produce `dist/server.mjs` (~480 KB) and `dist/public/`.
- `vercel inspect https://sonsiel-mentorship.vercel.app --logs --scope xyrn` — full build log.
