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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
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

// POST /api/negotiate/:disputeId/reply
// The negotiation loop: log the vendor's actual reply, then have the agent
// decide whether the dispute is resolved or needs a follow-up — and if a
// follow-up is needed, draft it, instead of the dispute sitting stuck after
// one email like before. This is what makes it a loop rather than one shot.
router.post('/:disputeId/reply', async (req, res) => {
  try {
    const { replyText } = req.body;
    if (!replyText || !replyText.trim()) {
      return res.status(400).json({ error: 'replyText is required' });
    }

    const dispute = await Dispute.findById(req.params.disputeId)
      .populate('vendor', 'name')
      .populate('po deliveryNote invoice');
    if (!dispute) return res.status(404).json({ error: 'Dispute not found' });

    dispute.thread.push({ direction: 'vendor_reply', body: replyText.trim() });

    const threadSoFar = dispute.thread
      .map((t) => `[${t.direction}]: ${t.body}`)
      .join('\n\n');

    const flagText = dispute.flags.map((f) => f.description).join(' ');
    const prompt = `You are Concord's autonomous negotiation agent for a B2B invoice dispute. Below is the full email thread so far, ending with the vendor's latest reply. Decide the outcome and respond in this EXACT format, nothing else:

STATUS: <one word — either RESOLVED or ESCALATE>
MESSAGE: <if RESOLVED, a short one-sentence internal note confirming what was agreed. If ESCALATE, a professional follow-up email to the vendor (with Subject line) addressing their reply and restating the ask.>

Original discrepancy: ${flagText}
Financial impact: ₹${dispute.totalFinancialImpact}
PO Number: ${dispute.po.docNumber || dispute.po._id}

Thread so far:
${threadSoFar}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      console.error('Unexpected Gemini response on reply:', JSON.stringify(data));
      throw new Error('Empty response from model');
    }

    const statusMatch = raw.match(/STATUS:\s*(RESOLVED|ESCALATE)/i);
    const messageMatch = raw.match(/MESSAGE:\s*([\s\S]*)/i);
    const decidedStatus = statusMatch ? statusMatch[1].toUpperCase() : 'ESCALATE';
    const message = messageMatch ? messageMatch[1].trim() : raw.trim();

    if (decidedStatus === 'RESOLVED') {
      dispute.status = 'resolved';
      dispute.thread.push({ direction: 'outbound_sent', body: `[Internal note] ${message}` });
    } else {
      dispute.status = 'awaiting_vendor';
      dispute.thread.push({ direction: 'outbound_draft', body: message });
    }

    await dispute.save();
    res.json({ decidedStatus, message, dispute });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process vendor reply' });
  }
});

module.exports = router;
