# The Sky Bot

A free-tier, Cloudflare Workers-hosted Deriv demo connection starter.

## Current scope

- Deriv OAuth 2.0 Authorization Code with PKCE
- Server-side authorization-code exchange
- Deriv account discovery
- One-time WebSocket OTP request and demo connection check
- Trading is deliberately disabled in this starter

## Configuration

The registered Deriv OAuth redirect URI must exactly match the deployed URL plus `/callback`.

For local development, register `http://localhost:8787/callback` (or the exact localhost URL used by Wrangler) in the Deriv application settings. The earlier `http://localhost:3000/callback` is only valid if the app is actually served on port 3000.

The production redirect URI must be added to the Deriv app after the Cloudflare deployment URL is known.

## Run locally

```bash
npm install
npm run dev
```

## Deploy

```bash
npx wrangler login
npm run deploy
```

After deployment, add `https://YOUR-WORKER.workers.dev/callback` to the Deriv application's registered redirect URLs, then use that exact URL in the OAuth flow.

Never commit API tokens or OAuth access tokens. The app keeps the access token in memory only. Demo account connection is the only enabled account workflow.
