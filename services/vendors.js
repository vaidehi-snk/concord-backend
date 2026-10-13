const Vendor = require('../models/Vendor');
const Dispute = require('../models/Dispute');
const Match = require('../models/Match');
const { validateGSTIN } = require('./gstin');
const { similarity } = require('./checks');

const LEGAL = /\b(private|pvt|limited|ltd|llp|inc|co|company|corp|corporation|the|m\/s)\b\.?/gi;
const clean = (s) => (s || '').toLowerCase().replace(LEGAL, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Attach a document to the right vendor without the user picking from a
 * dropdown: GSTIN first (unique per business per state), then name/alias
 * similarity, else create the vendor.
 */
async function resolveVendor(companyId, { name, gstin }) {
  const vendors = await Vendor.find({ company: companyId });
  if (gstin) {
    const byGstin = vendors.find((v) => v.gstin && v.gstin.toUpperCase() === gstin.toUpperCase());
    if (byGstin) return { vendor: byGstin, created: false };
  }
  if (name) {
    const target = clean(name);
    let best = null;
    let bestScore = 0;
    for (const v of vendors) {
      for (const candidate of [v.name, ...(v.aliases || [])]) {
        const c = clean(candidate);
        const score = c === target ? 1 : similarity(c, target);
        if (score > bestScore) {
          best = v;
          bestScore = score;
        }
      }
    }
    if (best && bestScore >= 0.75) {
      if (best.name !== name && !(best.aliases || []).includes(name)) {
        best.aliases = [...(best.aliases || []), name].slice(-8);
      }
      if (!best.gstin && gstin) {
        best.gstin = gstin;
        best.gstinValid = validateGSTIN(gstin).valid;
      }
      await best.save();
      return { vendor: best, created: false };
    }
  }
  if (!name && !gstin) return { vendor: null, created: false };
  const vendor = await Vendor.create({
    company: companyId,
    name: name || `Vendor ${gstin}`,
    gstin: gstin || undefined,
    gstinValid: gstin ? validateGSTIN(gstin).valid : undefined,
  });
  return { vendor, created: true };
}

/**
 * Risk 0–100, transparent by design (shown to users as its parts):
 *   dispute rate      — share of this vendor's purchases that raised a dispute (up to 45)
 *   money at stake    — log-scaled ₹ disputed (up to 25)
 *   recency           — disputes in the last 30/90 days (up to 15)
 *   unresolved        — open disputes right now (up to 15)
 */
function scoreParts({ matches = 0, disputes = 0, disputedAmount = 0, open = 0, lastDisputeAt }) {
  const rate = matches ? disputes / matches : disputes ? 1 : 0;
  const daysSince = lastDisputeAt ? (Date.now() - new Date(lastDisputeAt).getTime()) / 86400000 : Infinity;
  const parts = {
    disputeRate: Math.round(Math.min(45, rate * 90)),
    moneyAtStake: Math.round(Math.min(25, Math.log10(disputedAmount + 1) * 4.5)),
    recency: daysSince < 30 ? 15 : daysSince < 90 ? 7 : 0,
    unresolved: Math.min(15, open * 5),
  };
  const total = Math.min(100, Object.values(parts).reduce((a, b) => a + b, 0));
  return { total, parts, disputeRate: rate };
}

async function refreshVendorStats(vendorId) {
  const vendor = await Vendor.findById(vendorId);
  if (!vendor) return null;
  const [matches, disputes] = await Promise.all([
    Match.find({ vendor: vendorId, status: { $ne: 'awaiting_documents' } }).select('status touchless'),
    Dispute.find({ vendor: vendorId }).select('status totalFinancialImpact recoveredAmount createdAt'),
  ]);
  const disputedAmount = disputes.reduce((a, d) => a + (d.totalFinancialImpact || 0), 0);
  const recovered = disputes.reduce((a, d) => a + (d.recoveredAmount || 0), 0);
  const open = disputes.filter((d) => !['resolved', 'dismissed'].includes(d.status)).length;
  const lastDisputeAt = disputes.length ? disputes.map((d) => d.createdAt).sort((a, b) => b - a)[0] : undefined;
  const { total } = scoreParts({ matches: matches.length, disputes: disputes.length, disputedAmount, open, lastDisputeAt });
  vendor.stats = {
    ...(vendor.stats?.toObject?.() || vendor.stats || {}),
    totalDisputes: disputes.length,
    totalDisputedAmount: Math.round(disputedAmount * 100) / 100,
    recoveredAmount: Math.round(recovered * 100) / 100,
    cleanMatches: matches.filter((m) => m.status === 'matched').length,
    lastDisputeAt,
    riskScore: total,
  };
  await vendor.save();
  return vendor;
}

module.exports = { resolveVendor, refreshVendorStats, scoreParts, cleanName: clean };
