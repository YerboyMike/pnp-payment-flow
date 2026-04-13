# PnP Tax - Payment Flow (Open Source)

> The complete wallet connection, crypto payment, and access management flow used by [pnp.tax](https://pnp.tax) -- an AI-powered bank statement processor for accountants.

This repo contains the **frontend payment infrastructure** for PnP Tax. We're making this public because crypto runs on trust, and trust runs on transparency. Read the code. Verify for yourself.

## What's Here

| File | Purpose |
|------|---------|
| `js/wallet.js` | Phantom wallet connection, disconnection, message signing, auto-connect, cross-device access restore |
| `js/wallet-btn.js` | Nav bar Connect/Disconnect button with real-time wallet state sync |
| `js/payment.js` | Full payment modal -- SOL direct, USDC, manual payment, Stripe, rewards token check, wallet restore |
| `css/payment.css` | Payment modal styling |

## How the Payment Flow Works

### 1. Wallet Connection
```
User clicks "Connect Wallet"
  -> Phantom popup -> user approves
  -> Public key stored in memory (not server)
  -> Nav button updates to show truncated address
```

### 2. Token Balance Check (Rewards Members)
```
Connected wallet -> POST /api/payments/token/check-access
  -> Backend verifies $PNP token balance via Solana RPC
  -> Balance determines tier (Whale 30M+ / Shark 10M+ / Fish 1M+)
  -> Access granted via httpOnly cookie (JS cannot read it)
```

### 3. SOL/USDC Payment
```
User selects amount -> Phantom builds transaction
  -> Signs with wallet -> sends to Solana network
  -> Frontend waits for confirmation
  -> POST /api/payments/crypto/verify {wallet, tx_signature, tool, currency}
  -> Backend verifies on-chain: correct amount to merchant wallet
  -> Backend checks duplicate: tx signature used only once
  -> Access token generated -> httpOnly cookie set
```

### 4. Manual Payment (No Wallet Extension)
```
User clicks "Manual Payment"
  -> Backend creates session wallet (unique per session)
  -> User sends SOL from any wallet/exchange
  -> User pastes transaction signature
  -> Backend verifies and sweeps funds to merchant
  -> Session wallet persisted in localStorage (survives modal close)
```

### 5. Cross-Device Access Restore
```
User paid on Device A -> goes to Device B
  -> Connects same wallet -> signs message (Ed25519)
  -> Backend: "Does this wallet have an active token?"
  -> Same token row in DB -> cookie set on Device B
  -> No new token, no double spending
  -> Both devices share runs from one DB row
```

### 6. Disconnect
```
User clicks Disconnect
  -> Cookie cleared (POST /api/payments/access/clear-cookie)
  -> Token stays in database (not deleted)
  -> User can restore later by reconnecting + signing
  -> Gold theme removed, runs counter hidden
```

## Security Model

### What's Protected
- **Access tokens** are httpOnly cookies -- JavaScript cannot read, steal, or modify them
- **Wallet ownership** verified via Ed25519 message signing -- can't fake without private key
- **Nonces** are burned atomically after one use -- can't replay signatures
- **Rate limiting** on all sensitive endpoints (3/minute on restore, payment verify)
- **SameSite=Lax** cookies prevent CSRF attacks
- **HTTPS only** in production -- cookies have Secure flag

### What's NOT in This Repo
- Backend server code (Python/FastAPI)
- Environment variables (API keys, JWT secrets, hot wallet seeds)
- Database schemas or queries
- RPC endpoint URLs
- Session wallet derivation logic

The backend code lives in a private repository. This frontend code is the complete client-side payment flow -- what runs in your browser when you use pnp.tax.

### Zero-Storage Architecture
PnP processes bank statements entirely in memory. No PDFs, transaction data, or user files are ever saved to disk. When your session ends, the data is gone. There is no database table for user files because the infrastructure to store them doesn't exist.

## Anti-Abuse Protections

| Protection | How It Works |
|-----------|-------------|
| Duplicate tx check | Each transaction signature can only grant access once |
| Wallet signature verification | Ed25519 signing proves wallet ownership |
| Server-side balance checks | RPC verification before every tool run (rewards members) |
| Annual run limits | Shark/Fish tiers have yearly caps with automatic reset |
| Cross-device session sharing | One token row in DB, runs shared across all devices |
| Per-IP daily limits (free mode) | 5 runs/day per IP during promotional periods |
| AI budget cap | Global daily AI spend limit — tools degrade gracefully |
| Transaction count cap | Max 5,000 rows per upload |
| Financial content validation | Rejects non-financial uploads before AI processing |

See [ABUSE_PREVENTION.md](ABUSE_PREVENTION.md) for the full abuse prevention system design.
| Session wallet reuse | Manual payment sessions are reused, not recreated on modal reopen |

## Token Tiers

| Tier | Holding | Access |
|------|---------|--------|
| Whale | 30M+ $PNP | Unlimited runs, VIP gold theme |
| Shark | 10M+ $PNP | Unlimited runs |
| Fish | 1M+ $PNP | 100 runs per tool per year |

**Contract Address:** `H5FvXfZk5VfEaeQo2yj3rYkSAMHHVbCBPxWuU1h6Qc8w`

## API Contracts

### POST /api/payments/crypto/verify
Verify a direct crypto payment (SOL or SPL token).
```json
// Request
{
  "wallet": "FiDEiLwvE4z8...",
  "tx_signature": "4pkQACFigUkd...",
  "tool": "bank",           // or "labeler", "tis", "sales-tax", "bundle"
  "currency": "SOL"         // or "USDC", "PIGEON", any SPL token
}

// Success Response (200) — sets httpOnly cookie
{
  "ok": true,
  "access_token": "uuid-here",
  "tools": ["bank"],
  "amount_sol": 0.1,
  "runs_granted": 1
}

// Error Response (400)
{ "detail": "Payment could not be verified..." }
```

### POST /api/payments/crypto/prepare-manual
Create a manual payment session (SOL uses session wallet, SPL uses merchant ATA).
```json
// Request
{ "tool": "bank", "currency": "SOL" }

// Response
{
  "ok": true,
  "wallet_address": "session_or_merchant_ata",
  "session_wallet": "session_wallet_for_sol",
  "expires_at": 1234567890,
  "amount": 0.1,
  "amount_display": "0.1 SOL",
  "tool": "bank",
  "currency": "SOL",
  "is_session": true
}
```

### POST /api/payments/crypto/verify-manual
Verify a manual payment.
```json
// Request
{
  "session_wallet": "wallet_address",
  "tx_signature": "sig_here",
  "tool": "bank",
  "currency": "SOL"
}

// Success Response (200) — sets httpOnly cookie
{
  "ok": true,
  "access_token": "uuid",
  "tools": ["bank"],
  "amount": 0.1,
  "currency": "SOL",
  "runs_granted": 1
}
```

### POST /api/payments/crypto/restore-access
Restore access on a new device by proving wallet ownership.
```json
// Request
{
  "wallet": "FiDEiLwvE4z8...",
  "nonce": "uuid-nonce",
  "signature": "base64-ed25519-sig"
}

// Success Response (200) — sets httpOnly cookie
{
  "ok": true,
  "restored": true,
  "tools": ["bank", "labeler", "tis", "sales-tax"],
  "method": "sol",
  "runs_left": { "bank": 3, "labeler": 3 }
}

// Not Found (404)
{ "ok": false, "message": "No active access found for this wallet." }
```

### GET /api/payments/pricing
Returns all payment options and pricing.
```json
{
  "sol": { "per_tool": 0.1, "bundle": 0.5, "symbol": "SOL", "merchant_wallet": "9gHKe...", "rpc_url": "https://..." },
  "usdc": { "per_tool": 100, "bundle": 250, "symbol": "USDC", "decimals": 6, "mint": "EPjFW...", "merchant_ata": "..." },
  "pigeon": { "per_tool": 5000, "bundle": 20000, "symbol": "PIGEON", "decimals": 6, "mint": "4fSWE...", "merchant_ata": "..." },
  "stripe": { "per_tool": 100, "bundle": 300, "symbol": "USD" },
  "tools": ["bank", "labeler", "tis", "sales-tax"]
}
```

## Using This Code

This code is MIT licensed. You're free to use it in your own project. If you're building a Solana-based payment system, this is a production-tested reference implementation.

Key dependencies:
- [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/) -- Solana blockchain interaction
- [Phantom Wallet](https://phantom.app/) -- browser wallet provider

## Links

- **Live app:** [pnp.tax](https://pnp.tax)
- **Token:** [$PNP on Solana](https://solscan.io/token/H5FvXfZk5VfEaeQo2yj3rYkSAMHHVbCBPxWuU1h6Qc8w)

---

*Built by an accountant, for accountants. No VC. No permission. Just code.*
