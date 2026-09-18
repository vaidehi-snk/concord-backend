const express = require('express');
const Dispute = require('../models/Dispute');

const router = express.Router();

/**
 * A real audit-trail export, not just a dashboard view: every action
 * (AI draft, manager approval, vendor reply, resolution) across every
 * dispute, as one row per action, in a downloadable CSV a company can
 * hand to an auditor or keep for GST recordkeeping. This is what turns
 * "trust the AI got it right" into "here's the paper trail."
 */

const ACTION_LABELS = {
  outbound_draft: 'AI drafted settlement email',
  approved: 'Manager/admin approved draft',
  outbound_sent: 'Internal note',
  vendor_reply: 'Vendor replied',
};

function csvEscape(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// GET /api/audit-trail/export — CSV download, scoped to the authenticated company
router.get('/export', async (req, res) => {
  const disputes = await Dispute.find({ company: req.companyId })
    .populate('vendor', 'name')
    .populate('po deliveryNote invoice', 'docNumber');

  const rows = [
    ['Timestamp', 'Dispute ID', 'Vendor', 'PO Number', 'Invoice Number', 'Action', 'Actor', 'Details', 'Financial Impact (Rs.)', 'Dispute Status at Export'],
  ];

  disputes.forEach((d) => {
    // One row per action in the thread — this is the actual audit trail,
    // not a one-row-per-dispute summary that would hide the history.
    d.thread.forEach((entry) => {
      rows.push([
        new Date(entry.createdAt).toISOString(),
        d._id.toString(),
        d.vendor?.name || '',
        d.po?.docNumber || '',
        d.invoice?.docNumber || '',
        ACTION_LABELS[entry.direction] || entry.direction,
        entry.actorName || (entry.direction === 'outbound_draft' ? 'AI Negotiation Agent' : entry.direction === 'vendor_reply' ? 'Vendor' : ''),
        entry.body.replace(/\n/g, ' ').slice(0, 300),
        d.totalFinancialImpact,
        d.status,
      ]);
    });

    // If a dispute has flags but no thread activity yet, still record that
    // it was flagged — the reconciliation decision itself is part of the trail.
    if (d.thread.length === 0) {
      rows.push([
        new Date(d.createdAt).toISOString(),
        d._id.toString(),
        d.vendor?.name || '',
        d.po?.docNumber || '',
        d.invoice?.docNumber || '',
        'Reconciliation flagged discrepancy',
        'Concord Reconciliation Engine',
        d.flags.map((f) => f.description).join(' | ').slice(0, 300),
        d.totalFinancialImpact,
        d.status,
      ]);
    }
  });

  const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="concord-audit-trail-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

module.exports = router;
