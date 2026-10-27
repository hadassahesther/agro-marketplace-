# Agro Marketplace v2/v3 — International Agricultural Marketplace MVP

This version extends the supplied prototype with an operations/admin layer, the missing marketplace workflows, and (as of v3) a real PostgreSQL database with a double-entry payment ledger. It remains a **deployment-ready MVP skeleton, not a regulated production payment/escrow service** - see "Important production work still required" below.

## Added in v3 (PostgreSQL + payment ledger)
- Replaced the JSON-file datastore with PostgreSQL. Schema at `backend/db/schema.sql`, applied via `npm run migrate`.
- **A real double-entry ledger** (`ledger_entries` table, logic in `backend/db/ledger.js`): every payment, payout release, and refund posts a balanced group of debit/credit rows across `platform_escrow`, `platform_revenue`, and per-seller accounts. `GET /api/admin/ledger` and `GET /api/admin/ledger/balance-check` expose it; the latter should always return an empty array (an empty result means the books balance).
- A separate `payouts` table tracks the *operational* status of actually sending money to a seller (`pending` → `processing` → `paid`/`failed`), distinct from the accounting ledger. `GET /api/admin/payouts` and `PUT /api/admin/payouts/:id/status` manage it. **Nothing calls a real bank-transfer API yet** - an admin currently marks payouts as sent by hand after doing it manually; see the production checklist for wiring this to Flutterwave Transfers or similar.
- Atomic stock reservation (`backend/db/products.js: reserveStock`) and order creation (`backend/db/orders.js: createWithLineItems`) run inside real DB transactions - this closes a genuine race condition the old JSON-file read-modify-write pattern had (two buyers could both "win" the last unit of stock).
- All ledger-affecting logic (confirm payment, release payout, refund) is centralized in `backend/services/paymentService.js` so it's only ever posted from one place, which is what prevents a payment from accidentally being posted to the ledger twice.
- **Caveat on the current build**: this was written and syntax-checked (`node --check` on every file) but has not been run against a live PostgreSQL instance or with `npm install` completed - no network access or database server was available while building it. Run `npm run migrate` against a real Postgres instance and walk the full order flow (register → list a product → order it → pay → ship → confirm receipt) before trusting any of this.

## Added in v2
- Admin role and administration dashboard
- Admin-only bank-transfer verification
- KYC submission workflow for buyers/sellers
- KYC approval/rejection controls
- Wholesale Request-a-Quote API and seller offers
- Buyer/seller messaging API
- User notifications API
- Refund records and dispute resolution controls
- Crypto payment intent + transaction-hash submission flow
- Additional transaction ledger records
- Rate limiting and payload limits
- Password reset token workflow (email delivery must still be connected)
- Expanded data tables
- Out-of-stock status when inventory reaches zero
- Safer upload handling for KYC documents

## Run locally
```bash
# 1. Have a PostgreSQL server available - locally installed, or a free tier
#    from Render/Railway/Supabase/etc. Create an empty database for this app.

cd backend
npm install
cp .env.example .env
# edit .env - at minimum set DATABASE_URL, JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD

npm run migrate       # applies backend/db/schema.sql - safe to re-run any time
npm run seed-admin    # creates the first admin account from .env
npm start
```

Serve `frontend/` with any static server, e.g.:
```bash
cd frontend
python3 -m http.server 5500
```

Open `http://localhost:5500`.

## Admin login
Create the first admin using `npm run seed-admin`. Do not use the public registration form to create admin accounts.

## Payments
### Card
The existing Flutterwave integration remains available when `FLW_SECRET_KEY` is configured. Use test credentials during development.

### Bank transfer
Buyers upload payment proof. **Only an admin can verify it.** This does not automatically reconcile a bank account; connect a bank/payment-provider reconciliation service before launch.

### Crypto
The MVP now creates a crypto payment intent and accepts a transaction hash for review. It intentionally does not claim that a blockchain transfer has been verified. For production, connect a compliant crypto payment processor or wallet-monitoring service that verifies network, asset, amount, destination address and confirmations automatically.

## Important production work still required
See `backend/PRODUCTION_CHECKLIST.md` for the full, current list. Highlights:
1. ~~Replace JSON storage with PostgreSQL~~ — done in v3.
2. **Automate seller payouts** - the ledger tracks what's owed correctly, but no code actually sends money yet; wire `PUT /api/admin/payouts/:id/status` to a real transfer API.
3. Reconcile the ledger against your payment provider's settlement reports on a schedule.
4. Use a regulated payment/payout provider for cross-border money movement and any escrow-like flow.
5. Complete KYC/AML, sanctions screening, tax, consumer protection, privacy and terms-of-service review for Nigeria, UK, USA and each additional market.
6. Connect real bank-transfer reconciliation and card refunds/chargeback handling.
7. Connect real crypto payment processing if crypto remains enabled.
8. Add email/SMS delivery for verification, password reset and notifications.
9. Add shipping/freight APIs, customs/export document workflows and product-specific compliance checks.
10. Move uploads to private object storage and serve documents with signed URLs.
11. Put the API behind HTTPS, a WAF/reverse proxy, structured logging, monitoring and automated backups.
12. Perform security testing before handling real customer money or identity documents.

## Recommended commercial flow
Buyer -> payment provider -> order/payment ledger -> supplier fulfillment -> logistics/customs -> delivery -> provider-managed seller payout.

Avoid holding customer funds in your own bank account unless your legal/payment-provider structure explicitly permits it.
