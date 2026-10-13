const express = require('express');
const { tallyDebitNotesXML, savingsReportPDF } = require('../services/exports');

const router = express.Router();

router.get('/tally-debit-notes', async (req, res) => {
  const out = await tallyDebitNotesXML(req.companyId, { purchaseLedger: req.query.purchaseLedger || undefined, taxLedger: req.query.taxLedger || undefined, since: req.query.since });
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="concord-tally-debit-notes-${new Date().toISOString().slice(0, 10)}.xml"`);
  res.setHeader('X-Voucher-Count', String(out.count));
  res.send(out.xml);
});

router.get('/savings', async (req, res) => {
  const pdf = await savingsReportPDF(req.companyId);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="concord-savings-report-${new Date().toISOString().slice(0, 10)}.pdf"`);
  res.send(pdf);
});

module.exports = router;
