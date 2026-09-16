const express = require('express');
const Dispute = require('../models/Dispute');

const router = express.Router();

/**
 * This is the "lightweight vendor response link" — a smaller, sooner-achievable
 * version of the full two-sided vendor portal on the roadmap. No account, no
 * login: a vendor gets a link (from the negotiation email) and can view the
 * dispute and respond in one click.
 *
 * Deliberately exposes LESS than the internal dispute view — a vendor should
 * see the specific issue and figures relevant to them, not the company's
 * internal document IDs, vendor risk score, or other unrelated data.
 */

function publicView(dispute) {
  const isApproved = dispute.status !== 'pending_approval';
  return {
    vendorName: dispute.vendor?.name,
    poNumber: dispute.po?.docNumber,
    invoiceNumber: dispute.invoice?.docNumber,
    flags: dispute.flags.map((f) => ({ severity: f.severity, description: f.description })),
    totalFinancialImpact: dispute.totalFinancialImpact,
    status: dispute.status,
    // A draft still pending manager/admin approval is not yet the company's
    // official position — a vendor should never see it before it's approved.
    thread: isApproved
      ? dispute.thread.filter((t) => t.direction !== 'outbound_sent').map((t) => ({ direction: t.direction, body: t.body, createdAt: t.createdAt }))
      : [],
  };
}

// GET /api/public/disputes/:token — view-only, no auth
router.get('/:token', async (req, res) => {
  const dispute = await Dispute.findOne({ publicToken: req.params.token })
    .populate('vendor', 'name')
    .populate('po invoice', 'docNumber');
  if (!dispute) return res.status(404).json({ error: 'Not found' });
  res.json(publicView(dispute));
});

// POST /api/public/disputes/:token/respond — vendor submits accept/dispute + message
router.post('/:token/respond', async (req, res) => {
  const { decision, message } = req.body; // decision: 'accept' | 'dispute'
  if (!['accept', 'dispute'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "accept" or "dispute"' });
  }

  const dispute = await Dispute.findOne({ publicToken: req.params.token })
    .populate('vendor', 'name')
    .populate('po invoice', 'docNumber');
  if (!dispute) return res.status(404).json({ error: 'Not found' });

  const replyBody = decision === 'accept'
    ? `[Vendor accepted via response link]${message ? ' — ' + message.trim() : ''}`
    : `[Vendor disputed via response link]${message ? ' — ' + message.trim() : ''}`;

  dispute.thread.push({ direction: 'vendor_reply', body: replyBody });
  // A direct "accept" resolves immediately without needing the LLM to
  // interpret free text — the vendor already gave an unambiguous signal.
  // A "dispute" click still routes to human review (status stays as-is)
  // rather than auto-escalating, since we don't have a message to reason
  // over the way the full negotiation-loop endpoint does.
  if (decision === 'accept') {
    dispute.status = 'resolved';
  }
  await dispute.save();

  res.json({ ok: true, status: dispute.status });
});

module.exports = router;
