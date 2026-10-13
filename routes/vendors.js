const express = require('express');
const Vendor = require('../models/Vendor');
const Dispute = require('../models/Dispute');
const Match = require('../models/Match');
const Document = require('../models/Document');
const { scoreParts, refreshVendorStats } = require('../services/vendors');
const { validateGSTIN } = require('../services/gstin');
const { similarity } = require('../services/checks');

const User = require('../models/User');
const { decideAccount } = require('../services/fraud');
const router = express.Router();

async function partsFor(v) {
  const [matches, open] = await Promise.all([
    Match.countDocuments({ vendor: v._id, status: { $ne: 'awaiting_documents' } }),
    Dispute.countDocuments({ vendor: v._id, status: { $nin: ['resolved', 'dismissed'] } }),
  ]);
  return { ...scoreParts({ matches, disputes: v.stats?.totalDisputes || 0, disputedAmount: v.stats?.totalDisputedAmount || 0, open, lastDisputeAt: v.stats?.lastDisputeAt }), matches, open };
}

router.get('/', async (req, res) => {
  const vendors = await Vendor.find({ company: req.companyId }).sort({ 'stats.riskScore': -1, name: 1 });
  const out = [];
  for (const v of vendors) {
    const p = await partsFor(v);
    out.push({ ...v.toObject(), risk: { score: p.total, parts: p.parts, disputeRate: p.disputeRate, purchases: p.matches, openDisputes: p.open } });
  }
  res.json(out);
});

// Price history per item across every PO and invoice from this vendor —
// catches "price creep": rates drifting up order after order, even when
// each individual invoice matches its own PO.
function priceHistory(docs) {
  const series = [];
  for (const d of docs) {
    for (const li of d.extracted?.lineItems || []) {
      if (!li.unitPrice || !li.description) continue;
      let s = series.find((x) => similarity(x.item, li.description) >= 0.75);
      if (!s) {
        s = { item: li.description, points: [] };
        series.push(s);
      }
      s.points.push({ date: d.docDate || d.createdAt, price: li.unitPrice, doc: d.docNumber, type: d.type });
    }
  }
  return series
    .map((s) => {
      const pts = s.points.sort((a, b) => new Date(a.date) - new Date(b.date));
      const first = pts[0]?.price;
      const last = pts[pts.length - 1]?.price;
      return { ...s, points: pts, changePct: first ? Math.round(((last - first) / first) * 1000) / 10 : 0 };
    })
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
}

router.get('/:id', async (req, res) => {
  const v = await Vendor.findOne({ _id: req.params.id, company: req.companyId });
  if (!v) return res.status(404).json({ error: 'Vendor not found.' });
  const [disputes, matches, docs, p] = await Promise.all([
    Dispute.find({ vendor: v._id }).select('-thread -publicToken').populate('invoice', 'docNumber').sort({ createdAt: -1 }),
    Match.find({ vendor: v._id }).populate('invoice', 'docNumber extracted.totalAmount').sort({ updatedAt: -1 }).limit(50),
    Document.find({ vendor: v._id, type: { $in: ['PO', 'INVOICE'] } }).select('docNumber type docDate createdAt extracted.lineItems').sort({ createdAt: 1 }),
    partsFor(v),
  ]);
  const gst = v.gstin ? validateGSTIN(v.gstin) : null;
  res.json({
    vendor: v,
    risk: { score: p.total, parts: p.parts, disputeRate: p.disputeRate, purchases: p.matches, openDisputes: p.open },
    gst,
    disputes,
    matches,
    priceHistory: priceHistory(docs),
  });
});

router.post('/', async (req, res) => {
  const { name, contactEmail, contactName, gstin, msme, msmeCategory, udyamNumber, paymentTermsDays } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Vendor name is required.' });
  const v = await Vendor.create({
    company: req.companyId,
    name,
    contactEmail,
    contactName,
    gstin: gstin || undefined,
    gstinValid: gstin ? validateGSTIN(gstin).valid : undefined,
    msme: !!msme,
    msmeCategory: msme ? msmeCategory || 'micro' : undefined,
    udyamNumber,
    paymentTermsDays,
  });
  res.status(201).json(v);
});

router.patch('/:id', async (req, res) => {
  const v = await Vendor.findOne({ _id: req.params.id, company: req.companyId });
  if (!v) return res.status(404).json({ error: 'Vendor not found.' });
  for (const k of ['name', 'contactEmail', 'contactName', 'phone', 'gstin', 'msme', 'msmeCategory', 'udyamNumber', 'paymentTermsDays', 'hasWrittenAgreement']) {
    if (req.body[k] !== undefined) v[k] = req.body[k] === '' ? undefined : req.body[k];
  }
  if (req.body.gstin !== undefined) v.gstinValid = v.gstin ? validateGSTIN(v.gstin).valid : undefined;
  await v.save();
  await refreshVendorStats(v._id);
  res.json(v);
});

// After calling the vendor on a known number: trust or reject a new payee account
router.post('/:id/bank-accounts/decide', async (req, res) => {
  if (!['admin', 'manager'].includes(req.role)) return res.status(403).json({ error: 'Only a manager or admin can verify bank details.' });
  const { account, decision } = req.body || {};
  if (!['trust', 'reject'].includes(decision)) return res.status(400).json({ error: 'Decision must be trust or reject.' });
  const u = await User.findById(req.userId).select('name');
  try {
    const out = await decideAccount(req.companyId, req.params.id, String(account || ''), decision, u?.name || 'Someone');
    res.json({ bankAccounts: out.vendor.bankAccounts, released: out.released });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
