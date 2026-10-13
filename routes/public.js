const express = require('express');
const rateLimit = require('express-rate-limit');
const Dispute = require('../models/Dispute');
const { assessReply } = require('../services/negotiation');
const { refreshVendorStats } = require('../services/vendors');
const activity = require('../services/activity');

/**
 * Vendor portal — no account, no login. The vendor opens the link from the
 * settlement email and sees exactly what we see: their invoice next to our
 * PO and challan, line by line, with every discrepancy. They can accept
 * (dispute resolves, credit is recorded) or contest with an explanation
 * (the negotiation agent assesses it and drafts the follow-up for approval).
 *
 * Access is the unguessable 48-hex-char token. Internal notes and unapproved
 * drafts are never shown.
 */
const router = express.Router();
router.use(rateLimit({ windowMs: 60 * 1000, limit: 30 }));

const pickItems = (doc) => (doc?.extracted?.lineItems || []).map((li) => ({ description: li.description, quantity: li.quantity, unitPrice: li.unitPrice, total: li.total }));

function view(d) {
  const visible = d.thread.filter((t) => ['vendor_reply', 'outbound_sent'].includes(t.direction) || (t.direction === 'outbound_draft' && d.thread.some((x) => x.direction === 'approved' && x.createdAt >= t.createdAt)));
  return {
    reference: d.reference,
    buyer: d.company?.name,
    vendorName: d.vendor?.name,
    poNumber: d.po?.docNumber,
    invoiceNumber: d.invoice?.docNumber,
    challanNumber: d.deliveryNote?.docNumber,
    invoiceTotal: d.invoice?.extracted?.totalAmount,
    flags: d.flags.map((f) => ({ code: f.code, severity: f.severity, item: f.item, description: f.description, formula: f.formula, financialImpact: f.financialImpact })),
    totalFinancialImpact: d.totalFinancialImpact,
    status: d.status,
    resolution: d.resolution?.outcome ? { outcome: d.resolution.outcome } : null,
    comparison: { po: pickItems(d.po), dn: pickItems(d.deliveryNote), invoice: pickItems(d.invoice) },
    thread: visible.filter((t) => t.direction !== 'outbound_sent').map((t) => ({ direction: t.direction === 'vendor_reply' ? 'you' : 'buyer', body: t.body, createdAt: t.createdAt })),
  };
}

async function load(token) {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  return Dispute.findOne({ publicToken: token })
    .populate('vendor', 'name')
    .populate('company', 'name')
    .populate('po deliveryNote invoice', 'docNumber extracted.lineItems extracted.totalAmount');
}

router.get('/:token', async (req, res) => {
  const d = await load(req.params.token);
  if (!d) return res.status(404).json({ error: 'This link is not valid. Ask the buyer to resend it.' });
  res.json(view(d));
});

router.post('/:token/respond', async (req, res) => {
  const d = await load(req.params.token);
  if (!d) return res.status(404).json({ error: 'This link is not valid. Ask the buyer to resend it.' });
  if (['resolved', 'dismissed'].includes(d.status)) return res.status(400).json({ error: 'This dispute is already closed.' });
  const { decision, message = '', name = '' } = req.body || {};
  if (!['accept', 'contest'].includes(decision)) return res.status(400).json({ error: 'Choose accept or contest.' });
  const who = name ? `${name} (${d.vendor?.name})` : d.vendor?.name;
  const text = String(message).slice(0, 4000);

  if (decision === 'accept') {
    d.thread.push({ direction: 'vendor_reply', body: `Accepted via vendor portal${text ? `: ${text}` : '.'}`, actorName: who });
    d.status = 'resolved';
    d.recoveredAmount = d.totalFinancialImpact;
    d.resolution = { outcome: 'credit_note', note: `Accepted by ${who} via vendor portal.`, resolvedBy: who, resolvedAt: new Date() };
    d.thread.push({ direction: 'system', body: `Resolved — vendor accepted ₹${Math.round(d.totalFinancialImpact).toLocaleString('en-IN')} via the portal.` });
  } else {
    if (!text.trim()) return res.status(400).json({ error: 'Explain what you disagree with, so the buyer can review it.' });
    d.thread.push({ direction: 'vendor_reply', body: text, actorName: who });
    const a = await assessReply(d, text);
    d.thread.push({ direction: 'system', body: `Vendor contested via portal. Agent assessment: ${a.decision.toLowerCase()} — ${a.summary || ''}`.trim() });
    if (a.decision === 'RESOLVED' && a.outcome === 'vendor_justified') {
      d.thread.push({ direction: 'system', body: 'Agent believes the vendor may be right — review and dismiss if their evidence holds.' });
    } else if (a.reply) {
      d.thread.push({ direction: 'outbound_draft', body: a.reply, generatedBy: a.generatedBy, actorName: 'Concord agent' });
    }
    d.status = 'pending_approval';
  }
  await d.save();
  await refreshVendorStats(d.vendor._id);
  await activity.log(d.company._id, 'negotiation', `${who} ${decision === 'accept' ? 'accepted' : 'contested'} ${d.reference} via the vendor portal`, { actorName: who, refType: 'Dispute', refId: d._id });
  res.json(view(await load(req.params.token)));
});

module.exports = router;
