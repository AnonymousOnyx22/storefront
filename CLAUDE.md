# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Storefront for Slate products (useslate.net). Static HTML pages served by Netlify, with serverless functions for payments, licensing, and Discord integration. Sells: Onyx (HWID spoofer), Basalt (Rust external), and Obsidian (Rust internal, coming soon).

## Run

- Local dev: `npx netlify dev`
- Preflight (validate API keys): `node scripts/preflight.mjs --live`
- Deploy: `npx netlify deploy --prod --dir=.`

## Folder map

- Root HTML files -- public storefront pages
- `assets/` -- CSS, JS, SVG
- `netlify/functions/` -- Netlify serverless functions (ESM)
- `netlify/lib/` -- shared backend: core.mjs (key issuance, tiers, blobs, email, rate limiting), discord.mjs (REST helpers), payments.mjs (provider adapters)
- `bot/` -- Discord admin bot for Render deployment
- `scripts/` -- Discord setup scripts, preflight checker
- `dl/` -- installer payload (gitignored, never committed)

## Architecture

All backend logic is in Netlify Functions (ESM). Shared core in `netlify/lib/core.mjs` handles: key issuance, tier definitions, Netlify Blobs persistence, email via Resend, Discord webhook notifications, rate limiting, TOTP admin auth.

Payment flow: `checkout.mjs` creates an invoice with the first configured provider (paypal > stripe > nowpayments > cryptomus > hosted) -> provider callback hits `payment-webhook.mjs` (or `stripe-webhook.mjs`) -> signature verified -> key issued -> email sent -> Discord sale notification.

Admin console: `admin.html` (noindex, unlinked) calls `admin.mjs` with `x-admin-token` + optional TOTP.

Discord interactions (`discord-interactions.mjs`): ticket panel buttons, key verification modal, guided purchase flow. Private ticket channels in OPEN/CLOSED TICKETS categories. REST helpers in `netlify/lib/discord.mjs`.

Status bot (`bot/`): Node.js app using `ws` for Discord gateway. Health-checks useslate.net every 5 min, logs moderation events, posts audit entries. Deployed to Render.

## Rules

- **Secrets** live only in `.env.local` or the Netlify dashboard. Run `node scripts/preflight.mjs` before any deploy that should take payments.
- **Never commit:** `node_modules/`, `.env.local`, `dl/` contents.
- **No AI slop in prose or UI copy.** No emojis, no em dashes. Keep text minimal and direct.
