const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { apiKeyAuth } = require('../middleware/apiKey');
const { ingestDocument } = require('../services/matcher');

/**
 * Programmatic intake — documents arrive without anyone opening Concord.
 *
 *   POST /api/v1/documents          X-API-Key, multipart "files" (+ optional "type")
 *     for ERPs, Tally add-ons, scanners, scripts.
 *   POST /api/inbound/email?key=…   multipart with any attachment fields
 *     point SendGrid Inbound Parse / Mailgun Routes / Postmark inbound at this,
 *     so a vendor (or your own team) can simply forward bills to an address.
 */
const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const ACCEPT = /\.(pdf|jpe?g|png|webp)$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 30 },
  fileFilter: (req, file, cb) => cb(null, ACCEPT.test(file.originalname || '') || /pdf|jpe?g|png|webp/i.test(file.mimetype)),
});

async function run(req, res, source) {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No PDF or image attachments found.' });
  const typeHint = ['PO', 'DN', 'INVOICE'].includes(req.body?.type) ? req.body.type : undefined;
  const actorName = source === 'email' ? `Email from ${String(req.body?.from || 'forwarding address').slice(0, 80)}` : `API (${req.apiKeyName})`;
  const results = [];
  for (const f of files) {
    const r = await ingestDocument({ companyId: req.companyId, actorName, buffer: f.buffer, filename: f.originalname || 'attachment', typeHint, source });
    results.push({
      filename: f.originalname,
      error: r.error || null,
      type: r.document?.type,
      docNumber: r.document?.docNumber,
      purchase: r.match ? { id: r.match._id, poNumber: r.match.poNumber, status: r.match.status } : null,
      dispute: r.dispute ? { id: r.dispute._id, reference: r.dispute.reference, amount: r.dispute.totalFinancialImpact } : null,
      paymentHold: r.hold ? r.hold.detail : null,
    });
  }
  res.status(201).json({ received: files.length, results });
}

router.post('/v1/documents', limiter, apiKeyAuth, upload.array('files', 30), (req, res) => run(req, res, 'api'));
router.post('/inbound/email', limiter, apiKeyAuth, upload.any(), (req, res) => run(req, res, 'email'));

module.exports = router;
