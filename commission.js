/**
 * commission.js
 * ---------------------------------------------------------------------------
 * Central place for the platform's fee logic. Every price the buyer sees,
 * and every payout the seller receives, is computed here - so if you ever
 * change your fee structure, you only change it in one place.
 * ---------------------------------------------------------------------------
 */

const BUYER_SERVICE_FEE_PERCENT = parseFloat(
  process.env.BUYER_SERVICE_FEE_PERCENT || "0.05"
); // charged ON TOP of the listed price, paid by the buyer
const SELLER_COMMISSION_PERCENT = parseFloat(
  process.env.SELLER_COMMISSION_PERCENT || "0.05"
); // deducted FROM the listed price, paid by the seller

/**
 * Given a product's listed unit price and quantity, compute the full
 * breakdown the checkout page and the order record both rely on.
 */
function calculateOrderBreakdown(unitPrice, quantity) {
  const subtotal = round2(unitPrice * quantity);
  const buyerServiceFee = round2(subtotal * BUYER_SERVICE_FEE_PERCENT);
  const totalChargedToBuyer = round2(subtotal + buyerServiceFee);

  const sellerCommission = round2(subtotal * SELLER_COMMISSION_PERCENT);
  const sellerPayout = round2(subtotal - sellerCommission);

  const platformRevenue = round2(buyerServiceFee + sellerCommission);

  return {
    subtotal,
    buyerServiceFee,
    totalChargedToBuyer,
    sellerCommission,
    sellerPayout,
    platformRevenue,
    buyerServiceFeePercent: BUYER_SERVICE_FEE_PERCENT,
    sellerCommissionPercent: SELLER_COMMISSION_PERCENT,
  };
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = { calculateOrderBreakdown, round2 };
