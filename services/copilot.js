const llm = require('./llm');
const Dispute = require('../models/Dispute');
const Vendor = require('../models/Vendor');
const Match = require('../models/Match');
const Payment = require('../models/Payment');
const { overview } = require('./analytics');
const { payRun } = require('./payables');
const Gstr2bRun = require('../models/Gstr2bRun');

/**
 * "Ask Concord" — plain-language questions about your own payables
 * ("which vendor overbilled us most this quarter?", "what's overdue?").
 * The model only sees a compact snapshot of THIS company's data and is told
 * to answer from it alone, citing dispute references so every claim can be
 * clicked through and checked.
 */

const fmt = (n) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`;

async function snapshot(companyId) {
  const [stats, disputes, vendors, matches, payments, run, gst] = await Promise.all([
    overview(companyId),
    Dispute.find({ company: companyId }).sort({ createdAt: -1 }).limit(60).populate('vendor', 'name').populate('invoice po', 'docNumber'),
    Vendor.find({ company: companyId }).select('name gstin gstinValid stats'),
    Match.find({ company: companyId, status: 'awaiting_documents' }).select('poNumber po deliveryNote invoice createdAt').limit(30),
    Payment.find({ company: companyId, status: { $ne: 'matched' } }).sort({ createdAt: -1 }).limit(20).populate('invoice', 'docNumber'),
    payRun(companyId, { horizonDays: 14 }),
    Gstr2bRun.findOne({ company: companyId }).sort({ createdAt: -1 }).select('summary createdAt'),
  ]);
  return {
    today: new Date().toISOString().slice(0, 10),
    kpis: stats.kpis,
    issueBreakdown: stats.issueBreakdown,
    vendors: vendors.map((v) => ({ name: v.name, risk: v.stats?.riskScore, disputes: v.stats?.totalDisputes, disputed: v.stats?.totalDisputedAmount, recovered: v.stats?.recoveredAmount, gstinValid: v.gstinValid })),
    disputes: disputes.map((d) => ({
      ref: d.reference,
      vendor: d.vendor?.name,
      invoice: d.invoice?.docNumber,
      po: d.po?.docNumber,
      amount: d.totalFinancialImpact,
      recovered: d.recoveredAmount,
      status: d.status,
      priority: d.priority,
      opened: d.createdAt?.toISOString().slice(0, 10),
      due: d.dueDate?.toISOString().slice(0, 10),
      issues: d.flags.map((f) => f.code),
    })),
    waitingForDocuments: matches.map((m) => ({ po: m.poNumber, missing: [!m.po && 'PO', !m.deliveryNote && 'delivery challan', !m.invoice && 'invoice'].filter(Boolean) })),
    paymentExceptions: payments.map((p) => ({ status: p.status, amount: p.amount, invoice: p.invoice?.docNumber, difference: p.difference, narration: p.description })),
    paymentHoldsForBankChange: stats.holds,
    payRun: { safeToPayNext14Days: run.summary.payNow, heldOnDisputes: run.summary.held, msmeAtRisk: run.summary.msmeAtRisk, msmeBreached: run.summary.msmeBreached, msmeTaxCostIfMissed: run.summary.deductionAtRisk, blockedForBankChange: run.summary.blocked },
    gstr2b: gst ? { asOf: gst.createdAt?.toISOString().slice(0, 10), ...gst.summary, vendorsToChase: (gst.summary?.vendorsToChase || []).map((v) => ({ name: v.name, invoices: v.invoices, itcAtRisk: v.itcAtRisk })) } : 'not uploaded yet',
  };
}

function fallbackAnswer(q, snap) {
  const k = snap.kpis;
  const lower = q.toLowerCase();
  if (/gst|itc|2b|input tax|filed|gstr/.test(lower)) {
    if (typeof snap.gstr2b === 'string') return 'No GSTR-2B uploaded yet. Upload it on the GST page and I can tell you which suppliers haven’t filed and how much input tax credit is at risk.';
    const g = snap.gstr2b;
    return `${fmt(g.itcAtRisk)} of input tax credit is at risk: ${g.missingIn2b} invoice(s) aren’t in your GSTR-2B yet${g.valueMismatch ? ` and ${g.valueMismatch} were filed with a different value` : ''}. Chase ${g.vendorsToChase.map((v) => `${v.name} (${fmt(v.itcAtRisk)})`).join(', ') || 'no one'}.`;
  }
  if (/bank|account|fraud|hold|blocked/.test(lower)) {
    const h = snap.paymentHoldsForBankChange || [];
    return h.length ? `${h.length} invoice(s) are on hold because the vendor’s bank account changed: ${h.map((x) => `${x.invoice} from ${x.vendor} (${fmt(x.amount)})`).join('; ')}. Call the vendor on a number you already have before releasing payment.` : 'No payments are on hold for changed bank details.';
  }
  if (/pay|cash|this week|due/.test(lower) && snap.payRun) {
    const p = snap.payRun;
    return `Over the next 14 days, ${fmt(p.safeToPayNext14Days)} is verified and safe to pay; ${fmt(p.heldOnDisputes)} stays held on disputed lines.${p.msmeAtRisk + p.msmeBreached ? ` ${p.msmeAtRisk + p.msmeBreached} MSME invoice(s) are near or past the 45-day limit (tax cost if missed: ${fmt(p.msmeTaxCostIfMissed)}).` : ''}${p.blockedForBankChange ? ` ${p.blockedForBankChange} invoice(s) are blocked for a bank-detail change.` : ''}`;
  }
  if (/vendor|supplier|worst|risk/.test(lower) && snap.vendors.length) {
    const v = [...snap.vendors].sort((a, b) => (b.disputed || 0) - (a.disputed || 0))[0];
    return `${v.name} has the most money in dispute: ${fmt(v.disputed)} across ${v.disputes} dispute(s), risk score ${v.risk}/100. ${fmt(v.recovered)} recovered so far.`;
  }
  if (/overdue|late|follow/.test(lower)) {
    const od = snap.disputes.filter((d) => d.due && d.due < snap.today && !['resolved', 'dismissed'].includes(d.status));
    return od.length ? `${od.length} dispute(s) are past their response date: ${od.map((d) => `${d.ref} (${d.vendor}, ${fmt(d.amount)})`).join('; ')}.` : 'Nothing is overdue right now.';
  }
  return `Right now: ${k.openDisputes} open dispute(s) with ${fmt(k.moneyAtRisk)} at risk, ${fmt(k.moneyRecovered)} recovered to date, and ${Math.round(k.touchlessRate * 100)}% of purchases matched with no human involvement. (The AI assistant is busy, so this is a summary rather than a full answer — try again in a moment.)`;
}

async function ask(companyId, question, history = []) {
  const snap = await snapshot(companyId);
  if (!llm.isConfigured()) return { answer: fallbackAnswer(question, snap), generatedBy: 'template' };
  const prompt = `You are Concord, an accounts-payable analyst for an Indian business. Answer the user's question using ONLY the JSON data below about their own invoices, disputes, vendors and payments.
Rules: be concise (under 140 words), lead with the direct answer, use ₹ with Indian digit grouping, cite dispute references like DSP-0004 when relevant, and if the data can't answer it, say exactly what's missing. Never invent numbers. Plain text; short bullet lines with "- " are fine.

DATA:
${JSON.stringify(snap)}

${history.slice(-4).map((h) => `${h.role === 'user' ? 'User' : 'Concord'}: ${h.content}`).join('\n')}
User: ${question}
Concord:`;
  try {
    const answer = (await llm.generateText(prompt, { temperature: 0.2, maxOutputTokens: 700 })).trim();
    return { answer, generatedBy: 'llm' };
  } catch (err) {
    console.warn('[copilot] fallback:', err.message);
    return { answer: fallbackAnswer(question, snap), generatedBy: 'template' };
  }
}

module.exports = { ask, snapshot };
