const express = require('express');
const multer = require('multer');
const path = require('path');
const Document = require('../models/Document');
const { parseDocument } = require('../services/parseDocument');

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, '..', 'uploads') });

// POST /api/documents  — upload one PO/DN/Invoice file, parse it, store the result.
// Auth is stubbed for the MVP per the plan (one hardcoded company) — swap
// req.body.companyId for req.user.companyId once real auth is wired in.
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const { type, companyId, vendorId } = req.body;
    if (!['PO', 'DN', 'INVOICE'].includes(type)) {
      return res.status(400).json({ error: 'type must be PO, DN, or INVOICE' });
    }
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const parsed = await parseDocument(req.file.path);

    const doc = await Document.create({
      company: companyId,
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
  const { companyId } = req.query;
  const docs = await Document.find(companyId ? { company: companyId } : {}).sort({ createdAt: -1 });
  res.json(docs);
});

module.exports = router;
