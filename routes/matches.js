const express = require('express');
const Match = require('../models/Match');
const Company = require('../models/Company');
const Document = require('../models/Document');
const User = require('../models/User');
const { evaluateMatch } = require('../services/matcher');
const { runChecks } = require('../services/checks');
const activity = require('../services/activity');

const router = express.Router();
const DOC_FIELDS = 'docNumber type extracted.totalAmount extracted.lineItems extracted.taxPercent extracted.vendorGstin extracted.subtotal extracted.taxAmount parseStatus parseConfidence extractionMethod originalFilename createdAt docDate';

// GET /api/matches — the matching board: every purchase and which of its documents have arrived
router.get('/', async (req, res) => {
  const filter = { company: req.companyId };
  if (req.query.status) filter.status = req.query.status;
  const matches = await Match.find(filter)
    .populate('vendor', 'name')
    .populate('po deliveryNote invoice', 'docNumber extracted.totalAmount parseStatus createdAt')
    .populate('dispute', 'reference status totalFinancialImpact')
    .sort({ updatedAt: -1 })
    .limit(300);
  res.json(matches);
});

// GET /api/matches/:id — one purchase with the full checklist re-derived live
router.get('/:id', async (req, res) => {
  const match = await Match.findOne({ _id: req.params.id, company: req.companyId })
    .populate('vendor', 'name gstin')
    .populate('po deliveryNote invoice', DOC_FIELDS)
    .populate('dispute', 'reference status totalFinancialImpact');
  if (!match) return res.status(404).json({ error: 'Purchase not found.' });
  let checks = null;
  if (match.po && match.invoice) {
    const company = await Company.findById(req.companyId);
    const others = await Document.find({ company: req.companyId, vendor: match.vendor?._id, type: 'INVOICE', _id: { $ne: match.invoice._id } }).select('docNumber extracted.totalAmount createdAt');
    checks = runChecks({ po: match.po, dn: match.deliveryNote, invoice: match.invoice, settings: company.settings, vendor: match.vendor, otherInvoices: others }).checks;
  }
  res.json({ match, checks });
});

router.post('/:id/recheck', async (req, res) => {
  const m = await Match.findOne({ _id: req.params.id, company: req.companyId });
  if (!m) return res.status(404).json({ error: 'Purchase not found.' });
  const out = await evaluateMatch(m._id);
  res.json(out);
});

// POST /api/matches/:id/release — services / no challan expected: approve on a 2-way match
router.post('/:id/release', async (req, res) => {
  if (!['admin', 'manager'].includes(req.role)) return res.status(403).json({ error: 'Only a manager or admin can release a purchase without a delivery challan.' });
  const m = await Match.findOne({ _id: req.params.id, company: req.companyId });
  if (!m) return res.status(404).json({ error: 'Purchase not found.' });
  if (!m.po || !m.invoice) return res.status(400).json({ error: 'Both the PO and the invoice are needed before releasing.' });
  if (m.status === 'disputed') return res.status(400).json({ error: 'This purchase has an open dispute — resolve it first.' });
  m.status = 'matched';
  m.matchType = 'two_way';
  m.matchedAt = new Date();
  m.touchless = false;
  await m.save();
  const u = await User.findById(req.userId).select('name');
  await activity.log(req.companyId, 'match', `${u?.name} released ${m.poNumber} on a 2-way match (no delivery challan)`, { actorName: u?.name, refType: 'Match', refId: m._id });
  res.json(m);
});

module.exports = router;
