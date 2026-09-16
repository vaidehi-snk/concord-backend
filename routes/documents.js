const express = require('express');
const multer = require('multer');
const path = require('path');
const Document = require('../models/Document');
const { parseDocument } = require('../services/parseDocument');

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, '..', 'uploads') });

// POST /api/documents — upload one PO/DN/Invoice file, parse it, store the result.
// companyId now comes from the authenticated user's token (req.companyId,
// set by middleware/auth.js) — not from the request body, which anyone could
// have set to any value before real auth existed.
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const { type, vendorId } = req.body;
    if (!['PO', 'DN', 'INVOICE'].includes(type)) {
      return res.status(400).json({ error: 'type must be PO, DN, or INVOICE' });
    }
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const parsed = await parseDocument(req.file.path);

    const doc = await Document.create({
      company: req.companyId,
      vendor: vendorId,
      type,
      fileUrl: req.file.path,
      originalFilename: req.file.originalname,
      docNumber: parsed.extracted.docNumber,
      extracted: parsed.extracted,
      parseStatus: parsed.parseStatus,
      parseConfidence: parsed.parseConfidence,
    });

    res.status(201).json(doc);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to parse/store document' });
  }
});

router.get('/', async (req, res) => {
  const docs = await Document.find({ company: req.companyId }).sort({ createdAt: -1 });
  res.json(docs);
});

module.exports = router;
