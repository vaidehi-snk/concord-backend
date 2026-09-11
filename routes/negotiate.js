const express = require('express');
const Dispute = require('../models/Dispute');

const router = express.Router();

// POST /api/negotiate/:disputeId/draft
// Same prompt/logic as before, now calling Gemini's free-tier API instead of Claude.
// Requires GEMINI_API_KEY in the environment (free from aistudio.google.com/apikey,
// no credit card needed).
router.post('/:disputeId/draft', async (req, res) => {
  try {
    const dispute = await Dispute.findById(req.params.disputeId)
      .populate('vendor', 'name')
      .populate('po deliveryNote invoice');
    if (!dispute) return res.status(404).json({ error: 'Dispute not found' });

    const flagText = dispute.flags.map((f) => f.description).join(' ');
    const prompt = `You are Concord's autonomous negotiation agent for B2B invoice disputes. Draft a concise, professional settlement email to a vendor's accounts team about a billing discrepancy. Be firm but collaborative, cite exact figures, and propose a clear resolution (credit note, corrected invoice, or clarification). Keep it under 160 words. Address it generically to "the Accounts team".

Vendor: ${dispute.vendor.name}
PO Number: ${dispute.po.docNumber || dispute.po._id}
Invoice Number: ${dispute.invoice.docNumber || dispute.invoice._id}
Discrepancy: ${flagText}
Financial impact: ₹${dispute.totalFinancialImpact}

Output only the email, starting with a Subject line.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error('Unexpected Gemini response:', JSON.stringify(data));
      throw new Error('Empty response from model');
    }

    dispute.thread.push({ direction: 'outbound_draft', body: text.trim() });
    dispute.status = 'email_drafted';
    await dispute.save();

    res.json({ draft: text.trim(), dispute });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to draft settlement email' });
  }
});

module.exports = router;
