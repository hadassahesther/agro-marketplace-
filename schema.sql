-- =============================================================================
-- Agro Marketplace — PostgreSQL schema (v3)
-- =============================================================================
-- Design notes:
--
-- 1. IDs are application-generated UUIDs (v4, via the `uuid` npm package) so
--    the app code that creates a record can reference its id immediately,
--    without a round trip. Columns are UUID type either way.
--
-- 2. Status fields use VARCHAR + CHECK constraints rather than native
--    Postgres ENUM types. ENUMs are painful to extend later (ALTER TYPE ...
--    ADD VALUE can't run inside a transaction on older Postgres); a CHECK
--    constraint is a one-line migration to change.
--
-- 3. THE LEDGER (ledger_entries) is the heart of this upgrade. Every money
--    event in the system — a buyer's payment landing, the platform's fee
--    being earned, a seller's payout being held then released, a refund —
--    is recorded as a **balanced pair of rows**: one debit and one credit,
--    same amount, same order. This is standard double-entry bookkeeping:
--
--      Debit platform_escrow  100.00   |  Credit seller:<id>       100.00
--      (cash the platform is holding)     (what the platform owes the seller)
--
--    Two properties fall out of this for free, which a flat "transactions"
--    log doesn't give you:
--      - You can always answer "how much does the platform currently owe
--        seller X" by summing credits-minus-debits on `seller:<id>`.
--      - You can verify the books balance: SUM(amount) WHERE direction =
--        'debit' must equal SUM(amount) WHERE direction = 'credit', globally
--        and per order. See the `ledger_is_balanced` view at the bottom.
--
--    Ledger rows are append-only. A refund does not edit or delete the
--    original payment rows — it posts new, opposite rows. This is what makes
--    the ledger auditable: nothing is ever silently changed after the fact.
--
-- 4. `payouts` is a separate, smaller table: it tracks the *operational*
--    act of actually sending money to a seller's bank account (status,
--    provider reference, failure reason). The ledger says "the platform
--    owes the seller $100"; `payouts` says "here's the actual transfer
--    attempt that paid it out, and whether it succeeded." Keeping them
--    separate means a failed bank transfer doesn't corrupt your accounting
--    records — you reverse the ledger with a new pair of rows instead.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- only used if you later want gen_random_uuid()

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                   UUID PRIMARY KEY,
  full_name            TEXT NOT NULL,
  email                TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('buyer', 'seller', 'admin')),
  country              TEXT NOT NULL,
  phone                TEXT,
  verified             BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified       BOOLEAN NOT NULL DEFAULT FALSE,
  kyc_status           TEXT NOT NULL DEFAULT 'not_submitted'
                         CHECK (kyc_status IN ('not_submitted', 'pending', 'approved', 'rejected')),
  kyc_documents        JSONB NOT NULL DEFAULT '[]',
  kyc_review_note      TEXT,
  kyc_reviewed_at      TIMESTAMPTZ,
  kyc_reviewed_by      UUID REFERENCES users(id),
  business_name        TEXT,
  farm_location        TEXT,
  bank_details         JSONB,
  reset_token          TEXT,
  reset_token_expires_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_kyc_status ON users(kyc_status);

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id                   UUID PRIMARY KEY,
  seller_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  description          TEXT NOT NULL,
  category             TEXT NOT NULL CHECK (category IN
                         ('Garri', 'Palm Oil', 'Crayfish', 'Cocoa', 'Cashew', 'Spices', 'Other Products')),
  unit_price           NUMERIC(12, 2) NOT NULL CHECK (unit_price > 0),
  unit                 TEXT NOT NULL,
  quantity_available   NUMERIC(12, 2) NOT NULL CHECK (quantity_available >= 0),
  origin_country       TEXT NOT NULL,
  image_url            TEXT,
  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'paused', 'out_of_stock')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

-- ---------------------------------------------------------------------------
-- orders  (the buyer-facing "envelope" — totals + shipping + status)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                      UUID PRIMARY KEY,
  order_number            TEXT NOT NULL UNIQUE,
  buyer_id                UUID NOT NULL REFERENCES users(id),
  shipping_address        JSONB NOT NULL,
  payment_method           TEXT NOT NULL CHECK (payment_method IN ('card', 'bank_transfer', 'crypto')),
  currency                TEXT NOT NULL DEFAULT 'USD',
  order_total              NUMERIC(12, 2) NOT NULL CHECK (order_total >= 0),
  platform_revenue_total   NUMERIC(12, 2) NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN (
                             'pending_payment', 'pending_verification', 'paid',
                             'shipped', 'completed', 'disputed', 'cancelled'
                           )),
  payment_proof_url        TEXT,
  tracking_info             JSONB,
  status_history            JSONB NOT NULL DEFAULT '[]',
  flw_tx_ref                 TEXT,
  flw_transaction_id          TEXT,
  crypto_payment              JSONB,
  payment_reference            TEXT,
  payment_verified_by          UUID REFERENCES users(id),
  payment_verified_at          TIMESTAMPTZ,
  refund_status                 TEXT CHECK (refund_status IS NULL OR refund_status IN
                                 ('partial_pending', 'full_pending', 'partial_paid', 'full_paid')),
  refund_amount                  NUMERIC(12, 2),
  dispute_reason                  TEXT,
  dispute_raised_by                UUID REFERENCES users(id),
  dispute_resolution                TEXT,
  dispute_resolved_at                TIMESTAMPTZ,
  dispute_resolved_by                 UUID REFERENCES users(id),
  created_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_flw_tx_ref ON orders(flw_tx_ref);

-- ---------------------------------------------------------------------------
-- order_line_items  (one row per product per order — the fee math lives here)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_line_items (
  id                          UUID PRIMARY KEY,
  order_id                    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id                  UUID NOT NULL REFERENCES products(id),
  seller_id                   UUID NOT NULL REFERENCES users(id),
  product_name                 TEXT NOT NULL,
  unit_price                    NUMERIC(12, 2) NOT NULL,
  unit                            TEXT NOT NULL,
  quantity                         NUMERIC(12, 2) NOT NULL CHECK (quantity > 0),
  subtotal                          NUMERIC(12, 2) NOT NULL,
  buyer_service_fee                  NUMERIC(12, 2) NOT NULL,
  total_charged_to_buyer               NUMERIC(12, 2) NOT NULL,
  seller_commission                     NUMERIC(12, 2) NOT NULL,
  seller_payout                          NUMERIC(12, 2) NOT NULL,
  platform_revenue                        NUMERIC(12, 2) NOT NULL,
  buyer_service_fee_percent                NUMERIC(6, 4) NOT NULL,
  seller_commission_percent                 NUMERIC(6, 4) NOT NULL,
  created_at                                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_line_items_order ON order_line_items(order_id);
CREATE INDEX IF NOT EXISTS idx_line_items_seller ON order_line_items(seller_id);

-- ---------------------------------------------------------------------------
-- ledger_entries  (the payment ledger — append-only, double-entry)
-- ---------------------------------------------------------------------------
-- `account` values used by this app:
--   'platform_escrow'   — cash the platform is currently holding (an asset)
--   'platform_revenue'  — fees the platform has earned (income)
--   'seller:<user_id>'  — what the platform currently owes that seller
--   'buyer:<user_id>'   — used only for refund entries, to show money
--                          leaving platform_escrow back to the buyer
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                UUID PRIMARY KEY,
  order_id          UUID REFERENCES orders(id),
  line_item_id      UUID REFERENCES order_line_items(id),
  account           TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount            NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency          TEXT NOT NULL DEFAULT 'USD',
  entry_type        TEXT NOT NULL CHECK (entry_type IN (
                       'buyer_payment',    -- funds land in platform_escrow
                       'platform_fee',     -- fee portion recognized as revenue
                       'escrow_hold',      -- amount now owed to a seller, still held
                       'seller_payout',    -- amount released from escrow to a seller
                       'refund',           -- funds leave escrow back to the buyer
                       'payout_reversal'   -- a payout was reversed/failed after being posted
                     )),
  reference         TEXT,          -- e.g. Flutterwave transaction id, bank ref, tx hash
  description       TEXT,
  created_by        UUID REFERENCES users(id), -- null for system-generated entries
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_order ON ledger_entries(order_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account);
CREATE INDEX IF NOT EXISTS idx_ledger_entry_type ON ledger_entries(entry_type);

-- A quick sanity view: the books balance globally when this returns zero rows.
CREATE OR REPLACE VIEW ledger_is_balanced AS
SELECT currency,
       SUM(CASE WHEN direction = 'debit' THEN amount ELSE 0 END) AS total_debits,
       SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END) AS total_credits,
       SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) AS imbalance
FROM ledger_entries
GROUP BY currency
HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) != 0;

-- Convenience view: current balance per account (what the platform owes each seller, etc.)
CREATE OR REPLACE VIEW ledger_account_balances AS
SELECT account, currency,
       SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END) AS balance
FROM ledger_entries
GROUP BY account, currency;

-- ---------------------------------------------------------------------------
-- payouts  (operational record of actually sending money to a seller)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payouts (
  id                UUID PRIMARY KEY,
  seller_id         UUID NOT NULL REFERENCES users(id),
  order_id          UUID REFERENCES orders(id),
  line_item_id      UUID REFERENCES order_line_items(id),
  ledger_entry_id   UUID REFERENCES ledger_entries(id),
  amount            NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency          TEXT NOT NULL DEFAULT 'USD',
  method            TEXT NOT NULL DEFAULT 'bank_transfer',
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                       'pending', 'processing', 'paid', 'failed', 'reversed'
                     )),
  provider_reference TEXT,
  failure_reason     TEXT,
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payouts_seller ON payouts(seller_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);

-- ---------------------------------------------------------------------------
-- disputes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS disputes (
  id            UUID PRIMARY KEY,
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  opened_by     UUID NOT NULL REFERENCES users(id),
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution    TEXT,
  resolved_at   TIMESTAMPTZ,
  resolved_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_disputes_order ON disputes(order_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);

-- ---------------------------------------------------------------------------
-- quotes + quote_offers  (wholesale request-a-quote flow)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quotes (
  id                    UUID PRIMARY KEY,
  quote_number          TEXT NOT NULL UNIQUE,
  buyer_id              UUID NOT NULL REFERENCES users(id),
  seller_id             UUID NOT NULL REFERENCES users(id),
  product_id            UUID NOT NULL REFERENCES products(id),
  product_name          TEXT NOT NULL,
  quantity              NUMERIC(12, 2) NOT NULL CHECK (quantity > 0),
  destination_country   TEXT NOT NULL,
  destination_city      TEXT,
  packaging             TEXT,
  frequency             TEXT NOT NULL DEFAULT 'one_time',
  message               TEXT,
  status                TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'offered', 'accepted', 'declined', 'closed')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quotes_buyer ON quotes(buyer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_seller ON quotes(seller_id);

CREATE TABLE IF NOT EXISTS quote_offers (
  id              UUID PRIMARY KEY,
  quote_id        UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  unit_price      NUMERIC(12, 2) NOT NULL CHECK (unit_price > 0),
  currency        TEXT NOT NULL DEFAULT 'USD',
  shipping_price  NUMERIC(12, 2) NOT NULL DEFAULT 0,
  valid_until     TIMESTAMPTZ,
  message         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quote_offers_quote ON quote_offers(quote_id);

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id           UUID PRIMARY KEY,
  sender_id    UUID NOT NULL REFERENCES users(id),
  receiver_id  UUID NOT NULL REFERENCES users(id),
  message      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_messages_participants ON messages(sender_id, receiver_id);

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

COMMIT;
