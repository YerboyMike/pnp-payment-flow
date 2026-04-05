# Security Model

## Overview

PnP Tax uses a defense-in-depth approach to payment security. This document explains how each layer works and why the code in this repo is safe to publish.

## Why This Code Is Public

Every file in this repo already runs in your browser when you visit pnp.tax. Anyone can view it in DevTools. Making it a repo just makes it easier to read and audit.

**Nothing in this repo is secret.** All sensitive logic lives server-side in a private repository.

## Authentication Flow

### Cookie-Based Access (httpOnly)

```
Browser                          Server
  |                                |
  |-- POST /crypto/verify -------->|  (sends tx signature)
  |                                |-- verifies on-chain
  |                                |-- generates UUID token
  |                                |-- stores in SQLite DB
  |<-- Set-Cookie: pnp_access_token (httpOnly, Secure, SameSite=Lax)
  |                                |
  |-- GET /access/verify --------->|  (cookie sent automatically)
  |                                |-- reads cookie
  |                                |-- validates token in DB
  |<-- {valid: true, runs_left: 3} |
```

**Why httpOnly?**
- JavaScript cannot read the cookie value (prevents XSS token theft)
- Browser sends it automatically with `credentials: 'include'`
- Even if an attacker injects JS into the page, they can't extract the token

### Wallet Ownership Verification (Ed25519)

```
Browser                          Server
  |                                |
  |-- POST /auth-nonce ----------->|  (wallet address)
  |                                |-- generates UUID nonce
  |                                |-- stores in DB (5 min TTL)
  |<-- {nonce: "abc123"}           |
  |                                |
  |-- Phantom signs "PnP Login: abc123"
  |                                |
  |-- POST /auth-verify ---------->|  (wallet, nonce, signature)
  |                                |-- retrieves nonce from DB
  |                                |-- DELETES nonce (atomic, prevents replay)
  |                                |-- verifies Ed25519 signature
  |<-- {ok: true}                  |
```

**Why this matters:**
- Can't fake wallet ownership without the private key
- Nonce is burned before verification (can't replay)
- 5-minute TTL prevents stale nonces from being useful

### Cross-Device Restore

```
Device A: pays with wallet X -> token created in DB with wallet=X

Device B: connects wallet X -> signs message -> 
  POST /restore-access -> backend finds token where wallet=X ->
  sets cookie on Device B pointing to SAME token row

Both devices share one token. Runs consumed on A are reflected on B.
No duplication. No double-spending.
```

## What an Attacker Would Need

### To steal a user's access:
1. Access to the user's physical browser (cookie is httpOnly, can't be extracted via JS)
2. OR access to the user's Phantom wallet private key (to sign the restore message)
3. OR breach Railway's container infrastructure AND dump process memory during the 2-3 second processing window

### To fake a payment:
1. Actually send real SOL/USDC to the merchant wallet (which is... paying)
2. Each transaction signature can only be used once (duplicate check)
3. Amount is verified on-chain (can't send 0.001 SOL and claim a full payment)

### To abuse the restore flow:
1. Rate limited to 3 attempts per minute
2. Requires valid Ed25519 signature (need private key)
3. Nonce burned after one use (can't replay)

## Environment Variables (NOT in this repo)

The following are configured server-side and never appear in any frontend code:

| Variable | Purpose |
|----------|---------|
| `JWT_SECRET` | Admin panel authentication |
| `PAYMENT_HOT_SEED` | Session wallet derivation for manual payments |
| `SOLANA_RPC_URL` | Backend Solana RPC (Secure URL, never sent to browser) |
| `SOLANA_RPC_URL_PUBLIC` | Frontend Solana RPC (domain-restricted) |
| `MERCHANT_WALLET` | Destination for SOL/USDC payments |
| `ANTHROPIC_API_KEY` | AI transaction classification |
| `STRIPE_SECRET_KEY` | Stripe payment processing |

## Responsible Disclosure

If you find a vulnerability, please reach out before disclosing publicly. We take security seriously and will address issues promptly.

Contact: admin@pnptaxpros.com
