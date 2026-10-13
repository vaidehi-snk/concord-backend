const express = require('express');
const Dispute = require('../models/Dispute');
const Company = require('../models/Company');
const Match = require('../models/Match');
const User = require('../models/User');
const { runChecks } = require('../services/checks');
const { draft, draftBatch, assessReply } = require('../services/negotiation');
const { generateCreditNotePDF } = require('../services/creditNote');
const { refreshVendorStats } = require('../services/vendors');
const activity = require('../services/activity');

const router = express.Router();
const fmt = (n) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`;
const DOC_FIELDS = 'docNumber type extracted.totalAmount extracted.subtotal extracted.taxAmount extracted.taxPercent extracted.lineItems extracted.vendorGstin parseStatus parseConfidence extractionMethod originalFilename createdAt docDate';
const CLOSED = ['resolved', 'dismissed'];

async function load(req, id = req.params.id) {
  return Dispute.findOne({ _id: id, company: req.companyId })
    .populate('vendor', 'name gstin contactName contactEmail stats')
    .populate('po deliveryNote invoice', DOC_FIELDS)
    .populate('assignee', 'name email')
    .populate('company', 'name gstin settings');
}

async function actorName(req) {
  const u = await User.findById(req.userId).select('name');
  return u?.name || 'Someone';
}

const canApprove = (req) => ['admin', 'manager'].includes(req.role);

router.get('/', async (req, res) => {
  const filter = { company: req.companyId };
  if (req.query.status === 'active') filter.status = { $nin: CLOSED };
  else if (req.query.status) filter.status = req.query.status;
  if (req.query.vendor) filter.vendor = req.query.vendor;
  if (req.query.priority) filter.priority = req.query.priority;
  let disputes = await Dispute.find(filter)
    .select('-thread -publicToken')
    .populate('vendor', 'name')
    .populate('invoice po', 'docNumber extracted.totalAmount')
    .populate('assignee', 'name')
    .sort({ createdAt: -1 })
    .limit(500);
  if (req.query.q) {
    const q = String(req.query.q).toLowerCase();
    disputes = disputes.filter((d) =>
      [d.reference, d.vendor?.name, d.invoice?.docNumber, d.po?.docNumber, ...d.flags.map((f) => f.description)].some((s) => s && s.toLowerCase().includes(q))
    );
  }
  res.json(disputes);
});

router.get('/:id', async (req, res) => {
  const d = await load(req);
  if (!d) return res.status(404).json({ error: 'Dispute not found.' });
  // live checklist for the "N of 13 checks passed" panel
  const checks = d.po && d.invoice ? runChecks({ po: d.po, dn: d.deliveryNote, invoice: d.invoice, settings: d.company.settings, vendor: d.vendor }).checks : [];
  res.json({ dispute: d, checks, canApprove: canApprove(req) });
});

router.patch('/:id', async (req, res) => {
  const d = await Dispute.findOne({ _id: req.params.id, company: req.companyId });
  if (!d) return res.status(404).json({ error: 'Dispute not found.' });
  if (req.body.assignee !== undefined) d.assignee = req.body.assignee || undefined;
  if (req.body.priority && ['high', 'medium', 'low'].includes(req.body.priority)) d.priority = req.body.priority;
  await d.save();
  res.json(d);
});

// Draft a settlement email (tone: collaborative | firm | final)
router.post('/:id/draft', async (req, res) => {
  const d = await load(req);
  if (!d) return res.status(404).json({ error: 'Dispute not found.' });
  if (CLOSED.includes(d.status)) return res.status(400).json({ error: 'This dispute is closed. Reopen it to draft a new email.' });
  const tone = ['collaborative', 'firm', 'final'].includes(req.body?.tone) ? req.body.tone : 'collaborative';
  const { body, generatedBy } = await draft(d, { tone });
  d.thread.push({ direction: 'outbound_draft', body, generatedBy, actorName: 'Concord agent' });
  const threshold = d.company.settings?.autoApproveBelow || 0;
  if (threshold > 0 && d.totalFinancialImpact < threshold) {
    d.thread.push({ direction: 'approved', body: `Auto-approved: amount is below the ${fmt(threshold)} approval threshold.`, actorName: 'Concord' });
    d.status = 'email_drafted';
  } else {
    d.status = 'pending_approval';
  }
  await d.save();
  await activity.log(req.companyId, 'negotiation', `Settlement email drafted for ${d.reference} (${tone})`, { actorName: await actorName(req), refType: 'Dispute', refId: d._id });
  res.json(await load(req));
});

router.post('/:id/approve', async (req, res) => {
  if (!canApprove(req)) return res.status(403).json({ error: 'Only a manager or admin can approve a draft.' });
  const d = await load(req);
  if (!d) return res.status(404).json({ error: 'Dispute not found.' });
  if (d.status !== 'pending_approval') return res.status(400).json({ error: 'There is no draft waiting for approval.' });
  const name = await actorName(req);
  d.thread.push({ direction: 'approved', body: 'Draft approved and released to the vendor.', actorName: name });
  d.status = 'email_drafted';
  await d.save();
  await activity.log(req.companyId, 'approval', `${name} approved the settlement email for ${d.reference}`, { actorName: name, refType: 'Dispute', refId: d._id });
  res.json(await load(req));
});

// The email is sent from the user's own mailbox (mailto / copy). This records that it went out.
router.post('/:id/mark-sent', async (req, res) => {
  const d = await load(req);
  if (!d) return res.status(404).json({ error: 'Dispute not found.' });
  if (d.status !== 'email_drafted') return res.status(400).json({ error: 'Approve the draft before marking it sent.' });
  const name = await actorName(req);
  d.thread.push({ direction: 'outbound_sent', body: `Sent to ${d.vendor?.name}${d.vendor?.contactEmail ? ` (${d.vendor.contactEmail})` : ''}.`, actorName: name });
  d.status = 'awaiting_vendor';
  d.dueDate = new Date(Date.now() + 7 * 86400000);
  await d.save();
  await activity.log(req.companyId, 'negotiation', `${d.reference} sent to ${d.vendor?.name}; reply due in 7 days`, { actorName: name, refType: 'Dispute', refId: d._id });
  res.json(await load(req));
});

// Log a vendor's reply; the agent decides: resolved / partial / push back
router.post('/:id/reply', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: "Paste the vendor's reply first." });
  const d = await load(req);
  if (!d) return res.status(404).json({ error: 'Dispute not found.' });
  d.thread.push({ direction: 'vendor_reply', body: text, actorName: d.vendor?.name });
  const a = await assessReply(d, text);
  if (a.decision === 'RESOLVED' || a.decision === 'PARTIAL') {
    d.thread.push({ direction: 'system', body: `${a.decision === 'PARTIAL' ? 'Partly settled' : 'Settled'}: ${a.summary || 'vendor agreed.'} ${fmt(a.recoveredAmount)} recovered.` });
    if (a.decision === 'RESOLVED') {
      d.status = 'resolved';
      d.recoveredAmount = a.recoveredAmount;
      d.resolution = { outcome: a.outcome || 'credit_note', note: a.summary, resolvedBy: 'Concord negotiation agent', resolvedAt: new Date() };
    } else {
      d.recoveredAmount = a.recoveredAmount;
      if (a.reply) {
        d.thread.push({ direction: 'outbound_draft', body: a.reply, generatedBy: a.generatedBy, actorName: 'Concord agent' });
        d.status = 'pending_approval';
      }
    }
  } else {
    d.thread.push({ direction: 'system', body: `Vendor pushed back: ${a.summary || 'no evidence provided.'} Follow-up drafted for approval.` });
    if (a.reply) d.thread.push({ direction: 'outbound_draft', body: a.reply, generatedBy: a.generatedBy, actorName: 'Concord agent' });
    d.status = 'pending_approval';
  }
  await d.save();
  await refreshVendorStats(d.vendor._id);
  await activity.log(req.companyId, 'negotiation', `${d.vendor?.name} replied on ${d.reference} — ${a.decision.toLowerCase()}${a.recoveredAmount ? `, ${fmt(a.recoveredAmount)} agreed` : ''}`, {
    actorName: d.vendor?.name,
    amount: a.recoveredAmount,
    refType: 'Dispute',
    refId: d._id,
  });
  res.json({ dispute: await load(req), assessment: a });
});

router.post('/:id/resolve', async (req, res) => {
  const d = await load(req);
  if (!d) return res.status(404).json({ error: 'Dispute not found.' });
  const { outcome = 'credit_note', recoveredAmount, note } = req.body || {};
  const amt = Math.max(0, Math.min(d.totalFinancialImpact, Number(recoveredAmount ?? d.totalFinancialImpact) || 0));
  const name = await actorName(req);
  d.status = 'resolved';
  d.recoveredAmount = amt;
  d.resolution = { outcome, note, resolvedBy: name, resolvedAt: new Date() };
  d.thread.push({ direction: 'system', body: `Marked resolved by ${name}: ${outcome.replace(/_/g, ' ')}, ${fmt(amt)} recovered.${note ? ` ${note}` : ''}` });
  await d.save();
  await refreshVendorStats(d.vendor._id);
  await activity.log(req.companyId, 'dispute', `${d.reference} resolved — ${fmt(amt)} recovered from ${d.vendor?.name}`, { actorName: name, amount: amt, refType: 'Dispute', refId: d._id });
  res.json(await load(req));
});

router.post('/:id/dismiss', async (req, res) => {
  const d = await load(req);
  if (!d) return res.status(404).json({ error: 'Dispute not found.' });
  const name = await actorName(req);
  d.status = 'dismissed';
  d.resolution = { outcome: req.body?.outcome || 'vendor_justified', note: req.body?.note, resolvedBy: name, resolvedAt: new Date() };
  d.thread.push({ direction: 'system', body: `Dismissed by ${name}.${req.body?.note ? ` ${req.body.note}` : ''}` });
  await d.save();
  if (d.match) {
    await Match.updateOne({ _id: d.match }, { status: d.deliveryNote ? 'matched' : 'awaiting_documents', matchedAt: new Date(), touchless: false });
  }
  await refreshVendorStats(d.vendor._id);
  await activity.log(req.companyId, 'dispute', `${d.reference} dismissed by ${name}`, { actorName: name, refType: 'Dispute', refId: d._id });
  res.json(await load(req));
});

router.post('/:id/reopen', async (req, res) => {
  const d = await load(req);
  if (!d) return res.status(404).json({ error: 'Dispute not found.' });
  const name = await actorName(req);
  d.status = 'open';
  d.recoveredAmount = 0;
  d.resolution = undefined;
  d.thread.push({ direction: 'system', body: `Reopened by ${name}.` });
  await d.save();
  if (d.match) await Match.updateOne({ _id: d.match }, { status: 'disputed' });
  await refreshVendorStats(d.vendor._id);
  res.json(await load(req));
});

router.post('/:id/note', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Write a note first.' });
  const d = await load(req);
  if (!d) return res.status(404).json({ error: 'Dispute not found.' });
  d.thread.push({ direction: 'note', body: text, actorName: await actorName(req) });
  await d.save();
  res.json(await load(req));
});

router.get('/:id/credit-note', async (req, res) => {
  const d = await load(req);
  if (!d) return res.status(404).json({ error: 'Dispute not found.' });
  const pdf = await generateCreditNotePDF(d);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="concord-${d.reference || d._id}-debit-note.pdf"`);
  res.send(pdf);
});

// One consolidated email for several open disputes with the same vendor
router.post('/batch-draft', async (req, res) => {
  const ids = Array.isArray(req.body?.disputeIds) ? req.body.disputeIds : [];
  if (ids.length < 2) return res.status(400).json({ error: 'Select at least two disputes.' });
  const disputes = await Dispute.find({ _id: { $in: ids }, company: req.companyId, status: { $nin: CLOSED } })
    .populate('vendor', 'name')
    .populate('po invoice', 'docNumber')
    .populate('company', 'name settings');
  if (disputes.length < 2) return res.status(400).json({ error: 'At least two of these disputes must still be open.' });
  if (new Set(disputes.map((d) => String(d.vendor._id))).size > 1) return res.status(400).json({ error: 'All disputes in one email must be with the same vendor.' });
  const { body, generatedBy } = await draftBatch(disputes, { tone: req.body?.tone });
  for (const d of disputes) {
    d.thread.push({ direction: 'outbound_draft', body: `[Combined email covering ${disputes.length} disputes]\n\n${body}`, generatedBy, actorName: 'Concord agent' });
    d.status = 'pending_approval';
    await d.save();
  }
  await activity.log(req.companyId, 'negotiation', `Combined email drafted to ${disputes[0].vendor.name} covering ${disputes.length} disputes`, { actorName: await actorName(req) });
  res.json({ body, generatedBy, disputeIds: disputes.map((d) => d._id) });
});

module.exports = router;
