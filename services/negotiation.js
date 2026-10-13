const llm = require('./llm');

/**
 * The negotiation agent. Three jobs:
 *   draft()        — the settlement email for one dispute, in a chosen tone
 *   draftBatch()   — one consolidated email for several disputes with one vendor
 *   assessReply()  — read the vendor's answer and decide: resolved / partial / push back
 *
 * Each has a deterministic fallback. Gemini overloads happen (we've seen
 * "high demand" errors in production); a finance tool can't go blank when
 * they do. Every thread entry records whether it came from the LLM or the
 * template, so nobody is misled about what wrote it.
 */

const fmt = (n) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`;

const TONES = {
  collaborative: 'warm and collaborative — assume an honest mistake, keep the relationship strong',
  firm: 'firm and precise — polite, but clear that payment is held until this is corrected',
  final: 'final notice — formal, state that the disputed amount will be short-paid if not corrected within 5 working days',
};

const ASK = {
  SHORT_DELIVERY: 'a credit note for the undelivered quantity, or delivery of the balance',
  QTY_OVER_PO: 'a revised invoice limited to the ordered quantity',
  PRICE_MISMATCH: 'a revised invoice at the agreed PO rate',
  ITEM_NOT_ON_PO: 'removal of the item that was not ordered, or the PO amendment that authorised it',
  TAX_RATE_MISMATCH: 'confirmation of the HSN code and GST rate, and a corrected invoice',
  LINE_ARITHMETIC: 'a corrected invoice',
  TOTAL_ARITHMETIC: 'a corrected invoice',
  TOTAL_OVER_PO: 'an explanation of the excess over the PO value',
  GSTIN_INVALID: 'a re-issued invoice with your correct GSTIN, so we can claim input tax credit',
  GSTIN_MISMATCH: 'confirmation of your registered GSTIN and a re-issued invoice',
  DUPLICATE_INVOICE: 'confirmation that this invoice is a duplicate and can be cancelled',
  DN_UNVERIFIABLE: 'a signed copy of the delivery challan / proof of delivery',
  PO_PRESENT: 'the purchase order number this supply was made against',
};

function context(d) {
  return {
    vendor: d.vendor?.name || 'the vendor',
    po: d.po?.docNumber || '',
    invoice: d.invoice?.docNumber || '',
    dn: d.deliveryNote?.docNumber || '',
    company: d.company?.name || 'our accounts team',
    total: d.totalFinancialImpact,
  };
}

function templateDraft(d, tone = 'collaborative') {
  const c = context(d);
  const lines = d.flags.map((f, i) => `${i + 1}. ${f.description}${f.financialImpact > 0 ? ` (${fmt(f.financialImpact)})` : ''}`);
  const asks = [...new Set(d.flags.map((f) => ASK[f.code]).filter(Boolean))];
  const opener =
    tone === 'final'
      ? `This is a final reminder regarding invoice ${c.invoice}. We have not yet received a correction for the discrepancies below.`
      : tone === 'firm'
        ? `We have placed invoice ${c.invoice} on hold. While matching it against ${c.po}${c.dn ? ` and delivery challan ${c.dn}` : ''}, we found the following:`
        : `Thank you for invoice ${c.invoice}. While matching it against ${c.po}${c.dn ? ` and delivery challan ${c.dn}` : ''}, we noticed a few differences we'd like to clear up:`;
  const close =
    tone === 'final'
      ? `If we don't receive a correction within 5 working days, we will pay the undisputed balance and short-pay ${fmt(c.total)}.`
      : `Once we receive this, we will release payment for the balance straight away.`;
  return `Subject: ${tone === 'final' ? 'Final notice' : 'Discrepancy'} on invoice ${c.invoice} (${c.po}) — ${fmt(c.total)}

Dear ${c.vendor} accounts team,

${opener}

${lines.join('\n')}

Total under discussion: ${fmt(c.total)}.

Could you please share ${asks.length ? asks.join('; ') : 'a corrected invoice'}? ${close}

You can also review the line-by-line comparison and respond directly using the secure link included with this email.

Regards,
Accounts Payable
${c.company}`;
}

async function draft(d, { tone = 'collaborative' } = {}) {
  if (!llm.isConfigured()) return { body: templateDraft(d, tone), generatedBy: 'template' };
  const c = context(d);
  const prompt = `You are the accounts-payable negotiation agent for ${c.company}, an Indian business. Write a settlement email to the supplier about invoice discrepancies.

Tone: ${TONES[tone] || TONES.collaborative}.
Supplier: ${c.vendor}
Invoice: ${c.invoice} | PO: ${c.po}${c.dn ? ` | Delivery challan: ${c.dn}` : ''}
Discrepancies found by automated 3-way matching (each with its evidence):
${d.flags.map((f, i) => `${i + 1}. [${f.code}] ${f.description}${f.formula ? ` Calculation: ${f.formula}.` : ''}`).join('\n')}
Total amount in dispute: ${fmt(c.total)} (amounts include GST where applicable).

Requirements:
- Start with "Subject: ..." on the first line.
- Cite every figure exactly as given; do not invent numbers, dates or names.
- For each issue, ask for the specific fix (credit note / revised invoice / proof of delivery / corrected GSTIN) that resolves it.
- Say payment of the undisputed balance will be released once corrected.
- Mention that they can respond via the secure link included with this email.
- Under 220 words. Sign off as "Accounts Payable, ${c.company}". Plain text, no markdown.`;
  try {
    const body = (await llm.generateText(prompt, { temperature: 0.4, maxOutputTokens: 900 })).trim();
    return { body, generatedBy: 'llm' };
  } catch (err) {
    console.warn('[negotiation] draft fell back to template:', err.message);
    return { body: templateDraft(d, tone), generatedBy: 'template' };
  }
}

async function draftBatch(disputes, { tone = 'collaborative' } = {}) {
  const vendor = disputes[0]?.vendor?.name || 'the vendor';
  const company = disputes[0]?.company?.name || 'Accounts Payable';
  const total = disputes.reduce((a, d) => a + d.totalFinancialImpact, 0);
  const summary = disputes
    .map((d, i) => `${i + 1}. ${d.reference || ''} — Invoice ${d.invoice?.docNumber} / ${d.po?.docNumber}: ${d.flags.map((f) => f.description).join(' ')} (${fmt(d.totalFinancialImpact)})`)
    .join('\n');
  const fallback = `Subject: ${disputes.length} open invoice discrepancies — ${fmt(total)}

Dear ${vendor} accounts team,

Rather than write to you separately about each one, here are all the open discrepancies on your recent invoices:

${summary}

Combined amount under discussion: ${fmt(total)}.

Could you please send credit notes or revised invoices for these together? We'll release the undisputed balances as soon as they're corrected. Each item also has a secure link where you can respond individually.

Regards,
Accounts Payable
${company}`;
  if (!llm.isConfigured()) return { body: fallback, generatedBy: 'template' };
  try {
    const body = (
      await llm.generateText(
        `You are the accounts-payable negotiation agent for ${company} (India). Write ONE consolidated email to ${vendor} covering all of these invoice discrepancies, instead of separate emails. Tone: ${TONES[tone] || TONES.collaborative}.
${summary}
Combined total: ${fmt(total)}.
Start with "Subject: ...". List each issue on its own line with its reference and amount, exactly as given. Ask for credit notes / revised invoices. Under 280 words, plain text, sign off "Accounts Payable, ${company}".`,
        { temperature: 0.4, maxOutputTokens: 1100 }
      )
    ).trim();
    return { body, generatedBy: 'llm' };
  } catch (err) {
    return { body: fallback, generatedBy: 'template' };
  }
}

const AGREE = /\b(agree|accept|apolog|will issue|issuing|have issued|credit note|revised invoice|corrected invoice|sorry|our mistake|our error|attached (the )?(credit|revised))\b/i;
const PARTIAL = /\b(partial|part of|some of|only for|except)\b/i;

function heuristicAssessment(d, reply) {
  if (AGREE.test(reply) && !/\b(disagree|do not agree|don't agree|reject)\b/i.test(reply)) {
    const partial = PARTIAL.test(reply);
    const amt = reply.match(/₹\s?([\d,]+(?:\.\d+)?)|rs\.?\s?([\d,]+(?:\.\d+)?)/i);
    const offered = amt ? parseFloat((amt[1] || amt[2]).replace(/,/g, '')) : null;
    const recovered = offered && offered <= d.totalFinancialImpact ? offered : partial ? d.totalFinancialImpact / 2 : d.totalFinancialImpact;
    return {
      decision: partial || (offered && offered < d.totalFinancialImpact - 1) ? 'PARTIAL' : 'RESOLVED',
      recoveredAmount: Math.round(recovered * 100) / 100,
      outcome: /revised|corrected/i.test(reply) ? 'revised_invoice' : 'credit_note',
      summary: 'Vendor agreed to correct the invoice.',
      reply: null,
    };
  }
  return {
    decision: 'ESCALATE',
    recoveredAmount: 0,
    outcome: null,
    summary: 'Vendor did not accept the discrepancy.',
    reply: `Subject: Re: Invoice ${d.invoice?.docNumber}

Dear ${d.vendor?.name || ''} team,

Thank you for your reply. Our records still show:
${d.flags.map((f) => `- ${f.description}`).join('\n')}

If you believe our records are wrong, please share the supporting document (for example a signed proof of delivery for the full quantity, or the PO amendment). Otherwise, please issue a credit note for ${fmt(d.totalFinancialImpact)}. We will release the undisputed balance once this is settled.

Regards,
Accounts Payable`,
  };
}

async function assessReply(d, replyText) {
  if (!llm.isConfigured()) return { ...heuristicAssessment(d, replyText), generatedBy: 'template' };
  const thread = d.thread.slice(-6).map((t) => `[${t.direction}] ${t.body}`).join('\n\n');
  const prompt = `You are the accounts-payable negotiation agent. A supplier replied to an invoice dispute. Decide the outcome.

Dispute: ${d.flags.map((f) => f.description).join(' ')}
Total in dispute: ${fmt(d.totalFinancialImpact)}
Recent thread:
${thread}

Supplier's latest reply:
"""${replyText}"""

Return JSON:
{
 "decision": "RESOLVED" | "PARTIAL" | "ESCALATE",   // RESOLVED only if they commit to fixing everything; PARTIAL if they concede some; ESCALATE if they reject or give no evidence
 "recoveredAmount": number,       // ₹ they have agreed to credit/correct (0 if none). Never more than ${d.totalFinancialImpact}.
 "outcome": "credit_note" | "revised_invoice" | "short_payment" | "vendor_justified" | null,
 "summary": string,               // one sentence for the internal log
 "reply": string | null           // if not RESOLVED: the follow-up email (start with "Subject: Re: ..."), firm, asks for specific evidence or the credit; cite figures exactly; under 170 words. null if RESOLVED.
}
If the supplier provides credible evidence that our records are wrong (e.g. signed proof of delivery), use decision "RESOLVED" with outcome "vendor_justified" and recoveredAmount 0.`;
  try {
    const out = await llm.generateJSON(prompt);
    const decision = ['RESOLVED', 'PARTIAL', 'ESCALATE'].includes(out.decision) ? out.decision : 'ESCALATE';
    return {
      decision,
      recoveredAmount: Math.max(0, Math.min(d.totalFinancialImpact, Number(out.recoveredAmount) || 0)),
      outcome: out.outcome || null,
      summary: out.summary || '',
      reply: decision === 'RESOLVED' ? null : out.reply || heuristicAssessment(d, replyText).reply,
      generatedBy: 'llm',
    };
  } catch (err) {
    console.warn('[negotiation] assessReply fell back to heuristic:', err.message);
    return { ...heuristicAssessment(d, replyText), generatedBy: 'template' };
  }
}

module.exports = { draft, draftBatch, assessReply, templateDraft, TONES };
