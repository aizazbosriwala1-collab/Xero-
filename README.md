# XERO KHAN — Complete Standalone Telegram Commerce Bot

> **Digital Tools. Instant Access.**  
> Public Brand: **XERO KHAN** | Internal Project: **xero-khan-bot**

XERO KHAN is an enterprise-grade, standalone Telegram commerce bot built with Node.js, TypeScript, PostgreSQL (authoritative), Redis (cache/FSM), and Express. It powers an end-to-end customer journey from Telegram `/start` to automated/manual deposits, live supplier catalogue synchronization, dynamic admin pricing, and instant digital tool delivery.

---

## ⚡ Key Highlights

1. **Authoritative PostgreSQL Core**: Decimal-safe immutable ledger (`NUMERIC(18, 4)` via `decimal.js`), strict row locks, and foreign-key constraints.
2. **AiToolShop Reseller API v1**: Complete live catalogue mirroring with stock tracking, bounded timeouts, and safety flag gating (`LIVE_ORDERING_ENABLED=false`).
3. **5-Tier Pricing Precedence**:
   1. Per-product fixed retail price
   2. Per-product markup rule (fixed or percentage)
   3. Category pricing rule
   4. Global default pricing rule
   5. Safe cost floor (never sell below supplier cost)
4. **Binance Pay USDT Automatic Deposits**: Read-only transaction verifier (`GET /sapi/v1/pay/transactions`), HMAC-SHA256 signature, 20-category error classification matrix, and atomic wallet credit.
5. **Easypaisa & JazzCash Manual Deposits**: Pre-seeded account configurations, duplicate TXID detection, receipt image uploads, and admin approval safeguards.
6. **Dynamic Giveaways & Referrals**: Qualified-purchase referral rules, anti-self/anti-circular referral logic, dynamic criteria, and claim tracking.
7. **Telegram Bot UX**: Inline and persistent keyboards, 64-byte callback handling, graceful message editing fallbacks, and multi-language support.

---

## 📂 Repository Architecture

```text
xero-khan-bot/
├── .env.example              # Secret-free environment variable template
├── .gitignore                # Git ignore rules
├── railway.json              # Railway production deployment configuration
├── package.json              # Dependencies and scripts
├── tsconfig.json             # TypeScript compiler settings
├── vite.config.ts            # Vite bundler configuration
├── server.ts                 # Full-stack server entry point (Express + Vite)
├── src/
│   ├── config/env.ts         # Environment contract and credential masker
│   ├── db/
│   │   ├── index.ts          # Database connection manager (PG pool & pg-mem)
│   │   ├── migrate.ts        # Idempotent migration runner
│   │   ├── seed.ts           # Baseline payment methods and category seeds
│   │   └── migrations/
│   │       └── 001_initial_schema.sql
│   ├── services/
│   │   ├── logger.ts         # Structured secret-safe logger
│   │   ├── redis.ts          # Non-authoritative Redis cache and FSM
│   │   ├── wallet.ts         # Authoritative wallet and append-only ledger
│   │   ├── supplier.ts       # AiToolShop Reseller API client & catalogue sync
│   │   ├── pricing.ts        # 5-tier pricing engine & catalogue querying
│   │   ├── binance.ts        # Binance Pay verifier & deposit processor
│   │   ├── manualPayment.ts  # Easypaisa & JazzCash service
│   │   ├── order.ts          # Idempotent checkout & order fulfillment
│   │   ├── referral.ts       # Purchase-qualified referral tracker
│   │   ├── giveaway.ts       # Dynamic giveaways engine
│   │   ├── support.ts        # Customer support ticket service
│   │   └── i18n.ts           # Translation dictionary (EN, UR, UR-RO)
│   ├── telegram/
│   │   ├── client.ts         # Telegram Bot API HTTP client
│   │   ├── types.ts          # Telegram types and FSM states
│   │   ├── keyboards.ts      # Inline & reply keyboards
│   │   ├── bot.ts            # Telegram webhook router & idempotency
│   │   └── handlers/
│   │       ├── customer.ts   # Customer menu, shopping, wallet flows
│   │       └── admin.ts      # Admin control center & price overrides
│   ├── api/routes.ts         # HTTP health endpoints and admin REST APIs
│   └── App.tsx               # Web control console, bot simulator & smoke tester
└── test/
    └── run_tests.ts          # Complete automated test suite
```

---

## 🛠️ Environment Variables Contract

| Variable | Description | Default |
|---|---|---|
| `NODE_ENV` | Environment (`development` or `production`) | `development` |
| `PORT` | HTTP Server port | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | *PostgreSQL connection* |
| `REDIS_URL` | Redis connection string (cache / FSM) | `redis://localhost:6379` |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token | *Configured in Railway* |
| `TELEGRAM_WEBHOOK_URL` | Full URL to webhook endpoint | `https://.../api/telegram/webhook` |
| `TELEGRAM_WEBHOOK_SECRET`| Secret token for Telegram header verification | *Random 32+ char token* |
| `TELEGRAM_ADMIN_IDS` | Comma-separated admin Telegram IDs | `123456789,987654321` |
| `AITOOLSHOP_BASE_URL` | Reseller API Base URL | `https://aitoolshop.aitoolifystudio.io/api/reseller/v1` |
| `AITOOLSHOP_RESELLER_API_KEY`| Reseller API Bearer key | *Secret* |
| `BINANCE_PAY_ENABLED` | Enable Binance Pay verification | `false` |
| `BINANCE_API_BASE_URL` | Binance Pay endpoint | `https://bpay.binanceapi.com` |
| `BINANCE_API_KEY` | Binance API Key | *Secret* |
| `BINANCE_API_SECRET` | Binance API Secret for HMAC-SHA256 | *Secret* |
| `BINANCE_RECEIVER_ID` | Binance Pay Receiver ID | *Receiver UID* |
| `RECOVERY_MODE` | Allows maintenance, browsing and read-only tests | `true` |
| `LIVE_ORDERING_ENABLED` | **CRITICAL SAFETY FLAG**: blocks real supplier orders | `false` |
| `MANUAL_PAYMENTS_ENABLED`| Enable Easypaisa and JazzCash payments | `true` |

---

## 🚀 Commands

```bash
# Run migrations
npm run migrate

# Run automated tests
npm run test

# Type check
npm run lint

# Build client bundle
npm run build

# Start development server
npm run dev

# Start production server
npm run start
```

---

---

## 🔒 Security & Credentials Encryption

Delivered digital tool credentials and sensitive fulfillment payloads are protected with **authenticated AES-256-GCM** encryption (`src/services/encryption.ts`):
- Versioned cipher format: `v1:{iv_hex}:{auth_tag_hex}:{ciphertext_hex}`
- **Unambiguous 32-Byte Key Encoding**: Requires `DELIVERY_ENCRYPTION_KEY=<64 hexadecimal characters representing exactly 32 bytes>` (generated with `openssl rand -hex 32`). Decoded Buffer must strictly satisfy `key.length === 32`.
- Validated at production startup; missing, short, long, or malformed encodings trigger an immediate fatal startup error.
- Decrypted strictly on-demand for authenticated owners or authorized administrators.
- Plaintext secrets and supplier keys never enter logs, client responses, or telemetry.

---

## 🛡️ Binance Pay Readiness Levels

The Binance Pay integration strictly enforces a 5-tier readiness progression to prevent accidental or unverified credit execution:
1. `UNIT_TESTED`: Offline cryptographic and error matrix unit tests passed (HMAC-SHA256, parameter validation).
2. `MOCK_INTEGRATION_TESTED`: Full simulated transaction flow and error classification verified.
3. `CONFIGURED`: API Key, Secret, and Receiver ID supplied in environment variables.
4. `READ_ONLY_LIVE_VERIFIED`: Read-only live probe against Binance Pay API returned HTTP 200 with zero wallet mutations.
5. `AUTOMATIC_CREDIT_ENABLED`: Operator explicitly enabled live credit processing via `BINANCE_PAY_ENABLED=true`.

---

## 🚂 Railway Deployment Guide

1. Create a fresh project on **Railway.app**.
2. Add a **PostgreSQL** database service. Railway automatically sets `DATABASE_URL`.
3. Add a **Redis** service (optional). Railway sets `REDIS_URL` (in-memory fallback active if absent).
4. Connect this GitHub repository. Railway detects `railway.json`:
   - **Pre-Deploy Command**: `npm run migrate` (runs idempotent schema migrations protected by PostgreSQL advisory lock `987654321`).
   - **Recommended Pre-Deploy Timeout**: `300` seconds.
   - **Start Command**: `npm run start` (launches `node dist/server.js`).
   - **Healthcheck Path**: `/health` (timeout: 100s).
5. In **Variables**, configure your secrets:
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ADMIN_IDS`
   - `DELIVERY_ENCRYPTION_KEY` (64-character hex string representing exactly 32 bytes)
   - `AITOOLSHOP_RESELLER_API_KEY` (Bearer key for live supplier catalogue)
   - `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `BINANCE_RECEIVER_ID`
   - Keep `LIVE_ORDERING_ENABLED=false` until operator is ready for live supplier fulfillment.
6. Trigger deployment. The service will bind to `$PORT` and report healthy.
