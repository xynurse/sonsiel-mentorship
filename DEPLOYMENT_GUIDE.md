# Mentorship Platform Deployment Guide

How to deploy and operate this platform on **Vercel**, and how to stand up a new instance for a different program.

> The production instance lives at **https://mentorship.sonsiel.org** (Vercel project `sonsiel-mentorship`). For feature documentation see [FEATURES.md](./FEATURES.md); for release history see [CHANGELOG.md](./CHANGELOG.md); for open work see [TODO.md](./TODO.md).

## Architecture

| Layer | Technology |
|-------|------------|
| Frontend | React 18 + Vite, served as static assets from `dist/public` |
| Backend | Express app bundled into a single Vercel serverless function (`api/index.ts`) |
| Database | PostgreSQL (Neon) via Drizzle ORM |
| Realtime | Ably (typing indicators, live messages, notification badges) |
| File storage | Vercel Blob |
| Email | Resend |
| Sessions | `express-session` + `connect-pg-simple` (Postgres-backed) |

All `/api/*` requests are rewritten to the serverless function; everything else falls through to the SPA (`vercel.json`).

## Environment Variables

Set these on the Vercel project (Production, plus Preview where noted):

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Postgres connection string (Neon pooled URL) |
| `SESSION_SECRET` | Yes | Random 32+ character string |
| `APP_URL` | Yes (Production) | Canonical origin, e.g. `https://mentorship.sonsiel.org`. Used for links in emails and ICS feeds |
| `RESEND_API_KEY` | Yes | Resend email API key |
| `RESEND_FROM_EMAIL` | Recommended | From address, e.g. `SONSIEL Mentorship Hub <noreply@sonsiel.org>` |
| `ABLY_API_KEY` | Yes | Ably app API key (Production + Preview) |
| `BLOB_READ_WRITE_TOKEN` | Yes | Vercel Blob token (auto-provisioned when the Blob store is connected) |
| `BLOB_STORE_ID` / `BLOB_WEBHOOK_PUBLIC_KEY` | Auto | Set automatically by the Blob integration |

Manage them with the CLI: `vercel env ls production`, `vercel env add <NAME> production`, and pull locally with `vercel env pull`.

**After adding or changing a production env var, redeploy** (`vercel redeploy <deployment-url>` or push to `main`) — running functions don't pick up changes.

## Deploying

- **Normal flow:** push to `main` on GitHub → Vercel auto-builds and deploys to production.
- **Manual:** `vercel deploy` for a preview, `vercel deploy --prod` for production.
- Build = `npm run build` (`scripts/build-server.ts` bundles the server, Vite builds the client into `dist/public`).
- Type-check before pushing: `npm run check` (must pass clean).

## Standing Up a New Instance

### 1. Create the Vercel project

1. Fork/clone this repo to a new GitHub repository.
2. Import it into Vercel (`vercel link` or the dashboard). `vercel.json` carries the build config — no framework preset needed.

### 2. Provision services

1. **Postgres** — create a Neon database (Vercel Marketplace or neon.com); set `DATABASE_URL`.
2. **Blob storage** — add a Vercel Blob store to the project; the token env vars are auto-provisioned.
3. **Resend** — create an account, verify your sending domain, set `RESEND_API_KEY` and `RESEND_FROM_EMAIL`.
4. **Ably** — create an app, set `ABLY_API_KEY` (Production + Preview).
5. Set `SESSION_SECRET` and `APP_URL`.

### 3. Initialize the database

```bash
vercel env pull            # writes .env.local with DATABASE_URL etc.
npm run db:push            # create schema via drizzle-kit
npm run seed               # idempotent production seed (scripts/seed-prod.ts)
```

The seed creates required users, community categories, programs, and the system document folder. Update the seed account details in `server/auto-seed.ts` for your program, and change any seeded credentials immediately after first login.

### 4. Custom domain

1. Add the domain to the Vercel project (`vercel domains` or dashboard).
2. At your DNS provider, point the hostname at Vercel (CNAME `cname.vercel-dns.com`, or A record `76.76.21.21` for an apex).
3. Set `APP_URL` to the final origin and redeploy.

### 5. Branding customization

- `client/src/components/layouts/dashboard-layout.tsx` and `admin-layout.tsx` — program name in the shell.
- `client/src/pages/login.tsx`, `register.tsx` — auth page branding.
- `server/routes.ts` — search for "SONSIEL" in email content.
- `client/src/lib/pdf-generator.ts` — PDF export headers.
- `shared/schema.ts` — fields of expertise, education levels, and other program-specific dropdown options (mirrored in `client/src/pages/my-profile.tsx` and `client/src/pages/admin/user-profile.tsx`).

### 6. First-run checklist

- [ ] Site loads on the production URL; `/api/user` returns 401 when logged out.
- [ ] Log in with the seeded admin; change the password.
- [ ] Send a test email (e.g. ping a user) — verify links use `APP_URL`.
- [ ] Upload a document — verify Vercel Blob storage works.
- [ ] Two browsers, two users: typing indicators and live messages appear (Ably WebSocket to `realtime.ably.io` in devtools).
- [ ] Subscribe to the ICS calendar feed and verify event URLs.

## Local Development

```bash
vercel env pull        # sync env from Vercel into .env.local
npm install
npm run dev            # Express + Vite dev server on :5000
```

## Operations

- **Logs:** `vercel logs <deployment-url>` or the Vercel dashboard. (Long-term log retention and client error reporting are open items — see TODO.md.)
- **Rollback:** promote a previous deployment from the Vercel dashboard, or `vercel rollback`.
- **Database:** Neon provides point-in-time restore; schema changes go through `npm run db:push`.

### Common Issues

- **Email not sending** — check `RESEND_API_KEY` and that the sending domain is verified in Resend.
- **Email links point to the wrong host** — `APP_URL` missing or stale in production; set it and redeploy.
- **File uploads failing** — verify the Blob store is connected and `BLOB_READ_WRITE_TOKEN` is present.
- **Login issues / sessions dropping** — check `SESSION_SECRET` is set and `DATABASE_URL` is reachable (sessions are stored in Postgres).
- **Realtime not updating** — check `ABLY_API_KEY` and the WebSocket connection in browser devtools.
