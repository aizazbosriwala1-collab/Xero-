# Security Summary

**Reviewed Files**: 26
**Issues Resolved**: 11

### Issues Resolved
| Area | File | Line | What Was Happening | Impact | Status | How It Was Fixed |
|---|---|---|---|---|---|---|
| Unprotected Admin & Wallet Endpoints | `src/api/routes.ts` | 18 | Admin price updates, catalog sync, manual deposit review/approval/rejection, wallet balances, Binance diagnostics, and bot simulation endpoints accepted requests without verifying an admin token. | High | Fixed | Added `requireAdminApiAuth` middleware using constant-time token verification (`ADMIN_API_SECRET`) that fails closed in production when unconfigured, plus `403` production blocking on `/api/telegram/simulate`. |
| Production Ephemeral Database Fallback | `src/db/index.ts` | 28 | Missing or failing `DATABASE_URL` silently fell back to an in-memory database even in production, risking complete loss of balances and orders on restart. | High | Fixed | Restricted in-memory fallback strictly to non-production environments; production now fails closed on startup if PostgreSQL cannot initialize. |
| Support Ticket Cross-User Access | `src/services/support.ts` | 116 | Customer replies to support tickets did not check whether the sender owned the target ticket. | High | Fixed | Added strict ticket ownership verification for customer replies inside the row-locked database transaction. |
| Giveaway Claim Concurrency & Toggle | `src/services/giveaway.ts` | 300 | Concurrent claim requests could exceed `claim_limit` and claims bypassed the global giveaways disable setting. | High | Fixed | Enforced `settings.enabled`, acquired an exclusive row lock (`FOR UPDATE`) inside `db.withTransaction`, and guarded the counter increment with `WHERE id = $1 AND claims_count < claim_limit`. |
| Webhook Token Comparison Timing | `src/telegram/bot.ts` | 369 | Telegram webhook secret verification used standard string inequality instead of constant-time comparison. | Medium | Fixed | Switched secret verification to SHA-256 digest comparison with `crypto.timingSafeEqual`. |
| Missing HTTP Security Headers & API 404 | `server.ts` | 48 | Express exposed `X-Powered-By`, lacked protective response headers, and fell through unknown `/api/*` paths to the SPA HTML fallback in production. | Medium | Fixed | Disabled `x-powered-by`, added `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and `Referrer-Policy: no-referrer`, and mounted a JSON 404 handler on `/api`. |
| Ticket Number Sequence Race | `src/services/support.ts` | 61 | Concurrent PostgreSQL ticket creations reading `MAX(ticket_number) + 1` could collide under load. | Medium | Fixed | Added a transaction-scoped PostgreSQL advisory lock before allocating the next `ticket_number`. |
| Referral Tier Claim Concurrency & Bounds | `src/services/referral.ts` | 390 | Tier claim uniqueness was checked outside the transaction and referral settings lacked upper/lower bounds. | Medium | Fixed | Moved duplicate claim checks inside `db.withTransaction` with unique-violation handling and bounded `minQualifyingOrderUsdt` (`0..100000`) and `rewardPercentage` (`0..1`). |
| Pricing & Deposit Numeric Validation | `src/services/pricing.ts` | 563 | Negative, zero, or non-numeric price, markup, and deposit inputs could throw unhandled exceptions or store invalid values. | Medium | Fixed | Added finite numeric parsing and domain bounds on fixed prices (`> 0`), fixed markups (`>= 0`), and deposit amounts (`manualPayment.ts`). |
| Auto-Promotion Overlap & Timeout Leaks | `src/services/promotion.ts` | 857 | Scheduled promotion cycles could overlap if sending took longer than the poll interval, and failed supplier HTTP calls left active timeout handles. | Low | Fixed | Added a `cycleInFlight` lock around `runAutoPromotionCycle` and moved `clearTimeout` calls into `finally` blocks in `supplier.ts`. |
| Embedded Preview Alerts | `src/App.tsx` | 238 | Blocking `window.alert` dialogs disrupted embedded iframe operation and failed to attach optional admin authorization headers. | Low | Fixed | Replaced `alert` popups with a non-blocking status banner and added optional in-memory admin bearer token support. |

### Safeguards Verified
| Area | File | How It's Protected |
|---|---|---|
| Secrets & Key Management | `src/config/env.ts` | All API keys, webhook secrets, database URLs, and encryption keys load exclusively from server `process.env`; public health config masks all secrets. |
| Encrypted Credential Storage | `src/services/encryption.ts` | Delivered digital goods are encrypted at rest with authenticated AES-256-GCM (`v1`) and strict 32-byte key validation at startup. |
| Parameterized Database Queries | `src/db/index.ts` | All PostgreSQL queries across services use `$1..$n` bound parameters with zero raw SQL string interpolation of user input. |
| Double-Spend & Wallet Integrity | `src/services/wallet.ts` | All balance changes use per-user locks, `FOR UPDATE` row locks, immutable append-only `ledger_entries` with unique `operation_ref`/`idempotency_key`, and global reconciliation (`reconcileAllWallets`). |
| Live Ordering & Binance Safety Gates | `src/services/binance.ts` | Binance auto-credit requires 6 independent readiness checks plus strict clock-window and TXID/OrderID uniqueness; supplier ordering requires `LIVE_ORDERING_ENABLED=true`. |

## PoC Verification

### Unauthenticated Access to Admin & Financial Routes

#### Summary
| Field | Value |
|---|---|
| Issue Type | Missing Authorization Guard on Admin & Wallet APIs |
| Impact | High |
| Affected File | `src/api/routes.ts:37` |
| Test Scenario | `GET /api/admin/deposits` and `GET /api/wallet/123456789` sent without an authorization token when `ADMIN_API_SECRET` is set (or in production when unset). |

#### How It Was Fixed
Added `requireAdminApiAuth` middleware to all admin, wallet, diagnostic, and simulator routes using constant-time SHA-256 digest comparison (`crypto.timingSafeEqual`), failing closed (`503`) in production if `ADMIN_API_SECRET` is omitted and disabling `/api/telegram/simulate` (`403`) in production.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Unauthenticated `GET /api/admin/deposits` reaches `apiRouter` | Enters `requireAdminApiAuth` at `src/api/routes.ts:37` |
| 2 | `extractAdminToken(req)` returns empty string while `ADMIN_API_SECRET` is set | Constant-time token check at `src/api/routes.ts:56` fails |
| 3 | Middleware responds immediately before querying database | **Handled Safely (`401 Unauthorized` / `503` in production)** |

#### Conclusion
**Fix Verified** - Admin, wallet balance, Binance diagnostics, and simulator endpoints reject unauthorized callers before accessing or modifying any application data.

### Concurrent Giveaway Claims Exceeding Claim Limit

#### Summary
| Field | Value |
|---|---|
| Issue Type | Non-Atomic Reward Claim Check |
| Impact | High |
| Affected File | `src/services/giveaway.ts:307` |
| Test Scenario | Two distinct users call `claimGiveaway` concurrently on an active campaign with `claim_limit = 1`. |

#### How It Was Fixed
Locked the giveaway row inside a database transaction (`SELECT ... FOR UPDATE`), re-evaluated `claims_count < claim_limit` and `giveaway_claims` uniqueness inside the lock, and guarded the counter increment with `WHERE id = $1 AND claims_count < claim_limit`.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Two concurrent `claimGiveaway` calls pass initial `settings.enabled` check | Both enter `db.withTransaction` at `src/services/giveaway.ts:307` |
| 2 | First transaction acquires `FOR UPDATE` row lock, inserts claim, increments `claims_count` to `1` | Second transaction reads `claims_count = 1 >= claim_limit = 1` at line 331 |
| 3 | Second transaction throws and rolls back cleanly | **Handled Safely (strictly 1 claim granted)** |

#### Conclusion
**Fix Verified** - Concurrent requests cannot exceed the configured giveaway `claim_limit` or duplicate per-user reward credits.

### Cross-User Support Ticket Message Injection

#### Summary
| Field | Value |
|---|---|
| Issue Type | Missing Resource Ownership Check on Ticket Replies |
| Impact | High |
| Affected File | `src/services/support.ts:116` |
| Test Scenario | User `989202` calls `supportService.addMessage` with `senderType: 'CUSTOMER'` targeting a ticket created by user `989201`. |

#### How It Was Fixed
Added a resource-ownership check inside `addMessage`'s locked transaction verifying `String(tkt.user_id) === String(params.senderId)` whenever `senderType === 'CUSTOMER'`.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Non-owner reply enters `supportService.addMessage` | Loads locked ticket row at `src/services/support.ts:110` |
| 2 | Ownership guard compares `tkt.user_id` (`989201`) against `params.senderId` (`989202`) at line 116 | Mismatch triggers `Access denied` error |
| 3 | Transaction rolls back without inserting message or changing ticket status | **Handled Safely (blocked before DB write)** |

#### Conclusion
**Fix Verified** - Customers can only post replies to support tickets they own.
