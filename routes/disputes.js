const express = require('express');
const Document = require('../models/Document');
const Dispute = require('../models/Dispute');
const Vendor = require('../models/Vendor');
const { reconcile } = require('../services/reconcile');

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

module.exports = router;
