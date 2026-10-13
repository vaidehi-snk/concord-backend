const express = require('express');
const multer = require('multer');
const Payment = require('../models/Payment');
const User = require('../models/User');
const { reconcileStatement } = require('../services/payments');
const { payRun, bankFileCSV, forecast } = require('../services/payables');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// POST /api/payments/statement — CSV bank statement (file field "file", or { text })
router.post('/statement', upload.single('file'), async (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf-8') : req.body?.text;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Attach a CSV bank statement export.' });
  const u = await User.findById(req.userId).select('name');
  try {
    const out = await reconcileStatement(req.companyId, text, { actorName: u?.name });
    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  const payments = await Payment.find({ company: req.companyId }).populate('invoice', 'docNumber').populate('vendor', 'name').sort({ createdAt: -1, date: -1 }).limit(300);
  res.json(payments);
});

// What to pay this week, what to hold back, MSME §43B(h) deadlines
router.get('/payrun', async (req, res) => {
  res.json(await payRun(req.companyId, { horizonDays: Number(req.query.days) || 14 }));
});

router.get('/payrun/bank-file', async (req, res) => {
  const run = await payRun(req.companyId, { horizonDays: Number(req.query.days) || 14 });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="concord-payrun-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(bankFileCSV(run.rows));
});

router.get('/forecast', async (req, res) => {
  res.json(await forecast(req.companyId, { weeks: Math.min(13, Number(req.query.weeks) || 8) }));
});

module.exports = router;
