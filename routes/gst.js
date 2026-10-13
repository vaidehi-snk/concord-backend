const express = require('express');
const multer = require('multer');
const Gstr2bRun = require('../models/Gstr2bRun');
const User = require('../models/User');
const { reconcile2B, sample2B } = require('../services/gstr2b');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/2b', upload.single('file'), async (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf-8') : req.body?.text;
  const u = await User.findById(req.userId).select('name');
  try {
    const run = await reconcile2B(req.companyId, { text, filename: req.file?.originalname, actorName: u?.name });
    res.status(201).json(run);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/2b', async (req, res) => {
  const run = await Gstr2bRun.findOne({ company: req.companyId }).sort({ createdAt: -1 });
  res.json(run || null);
});

router.get('/2b/sample', async (req, res) => {
  try {
    const json = await sample2B(req.companyId);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="sample-gstr2b.json"');
    res.send(JSON.stringify(json, null, 2));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
