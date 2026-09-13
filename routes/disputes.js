const express = require('express');
const crypto = require('crypto');
const Document = require('../models/Document');
const Dispute = require('../models/Dispute');
const Vendor = require('../models/Vendor');
const { reconcile } = require('../services/reconcile');
const { generateCreditNotePDF } = require('../services/creditNote');

const router = express.Router();

// POST /api/disputes/reconcile
// Body: { poId, deliveryNoteId, invoiceId, companyId, vendorId }
// Runs the reconciliation engine on 3 already-uploaded Documents and creates
// a Dispute if any mismatch is found. This is the endpoint the "Reconcile" button
// on the frontend calls once real ingestion (Week 2-3) is wired to the UI.
router.post('/reconcile', async (req, res) => {
  try {
    const { poId, deliveryNoteId, invoiceId, companyId, vendorId } = req.body;
    const [po, deliveryNote, invoice] = await Promise.all([
      Document.findById(poId),
      Document.findById(deliveryNoteId),
      Document.findById(invoiceId),
    ]);
    if (!po || !deliveryNote || !invoice) {
      return res.status(404).json({ error: 'One or more documents not found' });
    }

    const { flags, totalFinancialImpact, hasDispute, insufficientData, uncheckedFields } = reconcile({
      po,
      deliveryNote,
      invoice,
    });

    if (!hasDispute) {
      if (insufficientData) {
        // Don't claim a verified match when almost nothing could actually be
        // compared — that's misleading for a tool whose entire job is catching
        // financial discrepancies. Be explicit about what wasn't checked.
        return res.json({
          hasDispute: false,
          insufficientData: true,
          message:
            'Could not verify most fields — extraction found too little usable data on these documents to reconcile them (not the same as confirming they match).',
          uncheckedFields,
        });
      }
      return res.json({ hasDispute: false, message: 'All documents match — no dispute found.' });
    }

    const dispute = await Dispute.create({
      company: companyId,
      vendor: vendorId,
      po: po._id,
      deliveryNote: deliveryNote._id,
      invoice: invoice._id,
      flags,
      totalFinancialImpact,
      status: 'open',
      publicToken: crypto.randomBytes(24).toString('hex'),
    });

    // Keep the vendor's rolling stats in sync — this is what the Phase 8-9
    // risk scorecard reads from, so it doesn't need to re-aggregate all disputes.
    await Vendor.findByIdAndUpdate(vendorId, {
      $inc: { 'stats.totalDisputes': 1, 'stats.totalDisputedAmount': totalFinancialImpact },
      $set: { 'stats.lastDisputeAt': new Date() },
    });

    res.status(201).json({ hasDispute: true, dispute });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Reconciliation failed' });
  }
});

// GET /api/disputes — dashboard list, newest first
router.get('/', async (req, res) => {
  const { companyId, status } = req.query;
  const filter = {};
  if (companyId) filter.company = companyId;
  if (status) filter.status = status;
  const disputes = await Dispute.find(filter)
    .populate('vendor', 'name')
    .populate('po deliveryNote invoice')
    .sort({ createdAt: -1 });
  res.json(disputes);
});

// GET /api/disputes/:id — single dispute detail, for the dispute detail page
router.get('/:id', async (req, res) => {
  const dispute = await Dispute.findById(req.params.id)
    .populate('vendor', 'name contactEmail')
    .populate('po deliveryNote invoice');
  if (!dispute) return res.status(404).json({ error: 'Dispute not found' });
  res.json(dispute);
});

// GET /api/disputes/report — monthly savings/impact summary. "Savings" here
// means the financial impact of RESOLVED disputes specifically — money that
// was actually recovered or corrected, not just flagged. This is the number
// that matters to a business owner, built entirely from data already
// collected by the reconciliation engine and the negotiation loop.
router.get('/report/summary', async (req, res) => {
  const { companyId } = req.query;
  const match = companyId ? { company: new (require('mongoose').Types.ObjectId)(companyId) } : {};

  const monthly = await Dispute.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
        },
        totalFlagged: { $sum: 1 },
        totalFlaggedAmount: { $sum: '$totalFinancialImpact' },
        resolvedCount: { $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] } },
        resolvedAmount: {
          $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, '$totalFinancialImpact', 0] },
        },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  const overall = await Dispute.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalFlagged: { $sum: 1 },
        totalFlaggedAmount: { $sum: '$totalFinancialImpact' },
        resolvedCount: { $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] } },
        resolvedAmount: {
          $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, '$totalFinancialImpact', 0] },
        },
      },
    },
  ]);

  res.json({
    overall: overall[0] || { totalFlagged: 0, totalFlaggedAmount: 0, resolvedCount: 0, resolvedAmount: 0 },
    monthly: monthly.map((m) => ({
      year: m._id.year,
      month: m._id.month,
      totalFlagged: m.totalFlagged,
      totalFlaggedAmount: m.totalFlaggedAmount,
      resolvedCount: m.resolvedCount,
      resolvedAmount: m.resolvedAmount,
    })),
  });
});

// GET /api/disputes/:id/credit-note — generates and streams a formatted PDF
// credit note for this dispute. A real document, not just email text —
// distinct from the negotiation draft, which is correspondence, not a
// filing-ready accounting document.
router.get('/:id/credit-note', async (req, res) => {
  try {
    const dispute = await Dispute.findById(req.params.id)
      .populate('vendor', 'name')
      .populate('po deliveryNote invoice');
    if (!dispute) return res.status(404).json({ error: 'Dispute not found' });

    const pdfBuffer = await generateCreditNotePDF(dispute);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="credit-note-${dispute._id}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate credit note' });
  }
});

module.exports = router;
