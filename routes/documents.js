const express = require('express');
const multer = require('multer');
const Document = require('../models/Document');
const Match = require('../models/Match');
const User = require('../models/User');
const { ingestDocument, attachToMatch, evaluateMatch } = require('../services/matcher');
const { normalizeKey } = require('../services/extract');
const { samplePack } = require('../services/samplePdfs');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 30 },
  fileFilter: (req, file, cb) => cb(null, /pdf|jpe?g|png|webp/i.test(file.mimetype) || /\.(pdf|jpe?g|png|webp)$/i.test(file.originalname)),
});

async function actor(req) {
  const u = await User.findById(req.userId).select('name');
  return u?.name || 'Someone';
}

function summarize(r) {
  return {
    document: r.document,
    error: r.error,
    vendor: r.vendor ? { _id: r.vendor._id, name: r.vendor.name } : null,
    vendorCreated: r.vendorCreated,
    hold: r.hold || null,
    match: r.match ? { _id: r.match._id, poNumber: r.match.poNumber, status: r.match.status } : null,
    dispute: r.dispute ? { _id: r.dispute._id, reference: r.dispute.reference, totalFinancialImpact: r.dispute.totalFinancialImpact, flags: r.dispute.flags.length } : null,
  };
}

// POST /api/documents — drop any number of PDFs, in any order, of any type.
// Type is auto-detected unless the caller passes ?type=PO|DN|INVOICE.
router.post('/', upload.array('files', 30), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Attach at least one PDF or photo (JPG/PNG).' });
  const typeHint = ['PO', 'DN', 'INVOICE'].includes(req.body.type) ? req.body.type : undefined;
  const actorName = await actor(req);
  // Order doesn't matter: each document joins its purchase and the purchase is
  // re-checked every time a new piece arrives.
  const results = [];
  for (const file of files) {
    results.push(await ingestDocument({ companyId: req.companyId, userId: req.userId, actorName, buffer: file.buffer, filename: file.originalname, typeHint }));
  }
  res.status(201).json({ results: results.map(summarize) });
});

// POST /api/documents/sample-pack — generate a realistic PO + challan + invoice
// as real PDFs and push them through the same pipeline as an upload.
router.post('/sample-pack', async (req, res) => {
  const kinds = ['short_delivery', 'price_drift', 'gst_error', 'mixed', 'clean'];
  const kind = kinds.includes(req.body?.kind) ? req.body.kind : kinds[Math.floor(Math.random() * 4)];
  const pack = await samplePack(kind);
  const actorName = await actor(req);
  const results = [];
  for (const f of pack.files) {
    results.push(await ingestDocument({ companyId: req.companyId, userId: req.userId, actorName, buffer: f.buffer, filename: f.filename, source: 'demo' }));
  }
  res.status(201).json({ kind, results: results.map(summarize) });
});

// GET /api/documents/sample-pack/:kind/:index — download the raw sample PDFs
// ?seed=12345 keeps the three files of one pack consistent across separate requests
router.get('/sample-pack/:kind/:index', async (req, res) => {
  const pack = await samplePack(req.params.kind, Number(req.query.seed));
  const f = pack.files[Number(req.params.index)] || pack.files[0];
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
  res.send(f.buffer);
});

router.get('/', async (req, res) => {
  const filter = { company: req.companyId };
  if (req.query.type) filter.type = req.query.type;
  if (req.query.status) filter.parseStatus = req.query.status;
  if (req.query.vendor) filter.vendor = req.query.vendor;
  const docs = await Document.find(filter)
    .select('-extracted.raw')
    .populate('vendor', 'name')
    .populate('match', 'poNumber status')
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(req.query.limit) || 100, 300));
  res.json(docs);
});

router.get('/:id', async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, company: req.companyId }).populate('vendor', 'name gstin').populate('match', 'poNumber status');
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  res.json(doc);
});

// PATCH /api/documents/:id — correct what the reader got wrong (type, numbers,
// PO reference, line items). The purchase is re-matched and re-checked.
router.patch('/:id', async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, company: req.companyId });
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const { type, docNumber, poReference, lineItems, totalAmount, taxPercent, vendor } = req.body || {};
  const oldMatch = doc.match;
  if (type && ['PO', 'DN', 'INVOICE'].includes(type)) {
    doc.type = type;
    doc.typeSource = 'user';
  }
  if (docNumber !== undefined) doc.docNumber = docNumber;
  if (poReference !== undefined) doc.poReference = poReference;
  if (vendor) doc.vendor = vendor;
  if (Array.isArray(lineItems)) doc.extracted.lineItems = lineItems;
  if (totalAmount !== undefined) doc.extracted.totalAmount = totalAmount;
  if (taxPercent !== undefined) doc.extracted.taxPercent = taxPercent;
  doc.matchKey = normalizeKey(doc.type === 'PO' ? doc.docNumber || doc.poReference : doc.poReference);
  doc.extractionMethod = 'manual';
  doc.parseStatus = 'parsed';
  await doc.save();

  if (oldMatch) {
    const m = await Match.findById(oldMatch);
    if (m && m.matchKey !== doc.matchKey) {
      for (const slot of ['po', 'deliveryNote', 'invoice']) if (String(m[slot]) === String(doc._id)) m[slot] = undefined;
      await m.save();
      await evaluateMatch(m._id);
    }
  }
  const outcome = await attachToMatch(doc);
  res.json({ document: doc, match: outcome.match, dispute: outcome.dispute });
});

router.delete('/:id', async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, company: req.companyId });
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  if (doc.match) {
    const m = await Match.findById(doc.match);
    if (m) {
      for (const slot of ['po', 'deliveryNote', 'invoice']) if (String(m[slot]) === String(doc._id)) m[slot] = undefined;
      await m.save();
      if (!m.po && !m.deliveryNote && !m.invoice && !m.dispute) await m.deleteOne();
      else await evaluateMatch(m._id);
    }
  }
  await doc.deleteOne();
  res.json({ ok: true });
});

module.exports = router;
