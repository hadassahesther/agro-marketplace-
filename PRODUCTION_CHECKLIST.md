# Production checklist

This codebase is an MVP. Before accepting real money or identity documents:

- [x] Replace JSON datastore with PostgreSQL and transactions/row locking.
      Done: see `backend/db/schema.sql` + `backend/db/`. Stock reservation
      (`products.reserveStock`) and order creation (`orders.createWithLineItems`)
      both run inside real DB transactions, closing the race condition the old
      JSON-file store had.
- [x] Record payments and seller payouts in a real, auditable ledger rather
      than an ad hoc transactions list.
      Done: `backend/db/ledger.js` posts balanced double-entry rows for every
      payment, payout release, and refund. `GET /api/admin/ledger/balance-check`
      is a standing integrity check - it should always return an empty array.
      `backend/payouts` tracks the *operational* side (has the transfer
      actually been sent) separately from the accounting record.
- [ ] **Not yet automated: actually executing seller payouts.** The ledger
      correctly tracks what's owed to each seller and creates a `pending`
      payout row when escrow is released, but nothing calls a real transfer
      API yet. `PUT /api/admin/payouts/:id/status` lets an admin mark a payout
      paid/failed by hand once they've sent it manually - wire this to
      Flutterwave Transfers (or Wise, etc.) to automate it.
- [ ] Reconcile the ledger against your payment provider's settlement
      reports on a schedule (daily, ideally) - the ledger reflects what your
      app *believes* happened; the provider's report is the source of truth
      for what actually settled.
- [ ] Use a regulated payment provider for marketplace collection and seller payouts.
- [ ] Confirm whether your exact business model requires licensing in Nigeria, UK, USA or other markets.
- [ ] Complete KYC/AML/sanctions screening and retention policies.
- [ ] Configure card webhooks and refund/chargeback reconciliation.
- [ ] Replace crypto manual confirmation with a compliant processor or audited wallet-monitoring service.
- [ ] Store KYC/payment documents in private object storage with signed URLs.
- [ ] Configure email verification and password-reset delivery.
- [ ] Add automated inventory reservation expiry and background jobs.
- [ ] Add shipping/freight/customs integrations and product compliance checks.
- [ ] Enable HTTPS, WAF, centralized logging, monitoring and backups.
- [ ] Perform penetration/security testing and independent payment-flow testing.
- [ ] Set a Postgres connection pool size appropriate to your host and run a
      managed backup schedule (point-in-time recovery, not just periodic dumps).
- [ ] Add DB indexes/monitoring for query performance once order volume is
      non-trivial - the schema ships with the obvious ones (foreign keys,
      status, seller/buyer lookups) but real traffic patterns may need more.
- [ ] This build was written and syntax-checked (`node --check`) but never
      run against a live PostgreSQL instance or with `npm install` completed,
      because neither network access nor a database server was available in
      the environment that built it. Run `npm run migrate` against a real
      Postgres instance and walk through the full order flow before trusting
      this in any real capacity - see README for the exact steps.
