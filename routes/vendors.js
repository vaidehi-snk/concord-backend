const express = require('express');
const Vendor = require('../models/Vendor');

const router = express.Router();

/**
 * Risk scoring: a simple, transparent heuristic for now — NOT a trained model.
 * The plan (from the roadmap) is to eventually train a small classifier once
 * there's enough real accumulated dispute history to learn from; until then,
 * a formula that's easy to explain in a report/demo is more honest than
 * pretending this is "AI-scored" when it's really just weighted counting.
 *
 * Score components (capped 0-100):
 *  - Frequency: more disputes = more risk, but with diminishing weight per
 *    additional dispute (a vendor with 10 disputes isn't 10x riskier than
 *    one with 1 — it's clearly worse, but the scale shouldn't be linear).
 *  - Financial severity: total disputed amount matters independently of count
 *    (one $50,000 dispute is a bigger deal than five $10 rounding errors).
 *  - Recency: a vendor with disputes only in the distant past is lower-risk
 *    today than one with a recent dispute, even at the same totals.
 */
function computeRiskScore(vendor) {
  const { totalDisputes = 0, totalDisputedAmount = 0, lastDisputeAt } = vendor.stats || {};
  if (totalDisputes === 0) return 0;

  const frequencyScore = Math.min(50, Math.log2(totalDisputes + 1) * 18); // diminishing returns
  const severityScore = Math.min(35, Math.log10(totalDisputedAmount + 1) * 7);

  let recencyPenalty = 0;
  if (lastDisputeAt) {
    const daysSince = (Date.now() - new Date(lastDisputeAt).getTime()) / (1000 * 60 * 60 * 24);
    recencyPenalty = daysSince < 30 ? 15 : daysSince < 90 ? 8 : 0;
  }

  return Math.round(Math.min(100, frequencyScore + severityScore + recencyPenalty));
}

function riskLabel(score) {
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  if (score > 0) return 'low';
  return 'none';
}

// GET /api/vendors — the scorecard list, sorted riskiest first
router.get('/', async (req, res) => {
  const { companyId } = req.query;
  const filter = companyId ? { company: companyId } : {};
  const vendors = await Vendor.find(filter);

  const scored = vendors
    .map((v) => {
      const riskScore = computeRiskScore(v);
      return {
        _id: v._id,
        name: v.name,
        contactEmail: v.contactEmail,
        stats: v.stats,
        riskScore,
        riskLabel: riskLabel(riskScore),
      };
    })
    .sort((a, b) => b.riskScore - a.riskScore);

  res.json(scored);
});

module.exports = router;
