const Document = require('../models/Document');
const Dispute = require('../models/Dispute');
const Match = require('../models/Match');

/**
 * Pay run + MSME compliance.
 *
 * For every unpaid invoice Concord knows: what is safe to pay now, what must
 * be held back (and why), and when it is due — including the statutory MSME
 * deadline under Income Tax Act §43B(h): payment to a micro/small enterprise
 * beyond 45 days of acceptance (15 days without a written agreement) makes
 * that expense non-deductible in the year, i.e. the buyer pays income tax on
 * money it actually spent. Most small businesses don't track this per invoice.
 *
 * Deadline counting starts at the goods-acceptance date — the delivery
 * challan date when we have one, else the invoice date (stated assumption).
 */

const DAY = 86400000;
const r2 = (n) => Math.round((n || 0) * 100) / 100;
const CORPORATE_TAX_RATE = 0.2517; // 22% + surcharge + cess (s.115BAA) — used only for the "tax cost if missed" estimate

async function payRun(companyId, { horizonDays = 14 } = {}) {
  const invoices = await Document.find({ company: companyId, type: 'INVOICE', paymentStatus: { $in: ['unpaid', 'partial'] } })
    .populate('vendor', 'name msme msmeCategory hasWrittenAgreement paymentTermsDays gstin contactEmail')
    .populate({ path: 'match', select: 'status deliveryNote poNumber', populate: { path: 'deliveryNote', select: 'docDate createdAt' } })
    .select('docNumber docDate dueDate createdAt extracted.totalAmount extracted.bankAccount amountPaid vendor match paymentHold');
  const disputes = await Dispute.find({ company: companyId, invoice: { $in: invoices.map((i) => i._id) } }).select('invoice status totalFinancialImpact recoveredAmount reference');
  const now = Date.now();

  const rows = invoices.map((inv) => {
    const total = inv.extracted?.totalAmount || 0;
    const d = disputes.find((x) => String(x.invoice) === String(inv._id));
    const openDispute = d && !['resolved', 'dismissed'].includes(d.status);
    const credit = d?.status === 'resolved' ? d.recoveredAmount || 0 : 0;
    const payable = Math.max(0, total - credit - (inv.amountPaid || 0));
    const hold = openDispute ? Math.min(payable, d.totalFinancialImpact) : 0;
    const matchStatus = inv.match?.status;
    const verified = matchStatus === 'matched' || (matchStatus === 'disputed' && ['resolved', 'dismissed'].includes(d?.status));
    const bankHold = inv.paymentHold?.reason === 'bank_change' && !inv.paymentHold.clearedAt;
    const safeToPay = bankHold ? 0 : verified || openDispute ? r2(payable - hold) : 0;

    const acceptedOn = inv.match?.deliveryNote?.docDate || inv.match?.deliveryNote?.createdAt || inv.docDate || inv.createdAt;
    const terms = inv.vendor?.paymentTermsDays || 30;
    let dueDate = inv.dueDate || new Date(new Date(acceptedOn).getTime() + terms * DAY);
    let msmeDeadline = null;
    if (inv.vendor?.msme && ['micro', 'small', null, undefined].includes(inv.vendor.msmeCategory)) {
      const limit = inv.vendor.hasWrittenAgreement === false ? 15 : Math.min(45, terms);
      msmeDeadline = new Date(new Date(acceptedOn).getTime() + limit * DAY);
      if (msmeDeadline < dueDate) dueDate = msmeDeadline;
    }
    const daysLeft = Math.ceil((new Date(dueDate).getTime() - now) / DAY);
    const msmeDaysLeft = msmeDeadline ? Math.ceil((msmeDeadline.getTime() - now) / DAY) : null;

    let action;
    let reason;
    if (bankHold && payable > 0) {
      action = 'blocked';
      reason = 'Bank account changed — verify by phone before paying';
    } else if (verified && !openDispute && payable <= 0) {
      action = 'none';
      reason = credit > 0 ? `Nothing to pay: ${d?.reference} settled the full amount` : 'Already paid';
    } else if (!verified && !openDispute) {
      action = 'wait';
      reason = matchStatus === 'awaiting_documents' ? 'Not verified yet — waiting for the delivery challan or PO' : 'Not matched to a purchase order';
    } else if (openDispute && safeToPay <= 0) {
      action = 'hold';
      reason = `Fully disputed (${d.reference})`;
    } else if (openDispute) {
      action = 'pay_partial';
      reason = `Pay the undisputed part; hold ₹${Math.round(hold).toLocaleString('en-IN')} on ${d.reference}`;
    } else {
      action = 'pay';
      reason = credit > 0 ? `Verified; ₹${Math.round(credit).toLocaleString('en-IN')} credit already deducted` : 'Verified by 3-way match';
    }

    return {
      invoiceId: inv._id,
      invoice: inv.docNumber,
      poNumber: inv.match?.poNumber,
      vendor: inv.vendor ? { id: inv.vendor._id, name: inv.vendor.name, msme: !!inv.vendor.msme, gstin: inv.vendor.gstin } : null,
      total: r2(total),
      alreadyPaid: r2(inv.amountPaid),
      credit: r2(credit),
      hold: r2(hold),
      safeToPay,
      dispute: d ? { id: d._id, reference: d.reference, status: d.status } : null,
      acceptedOn,
      dueDate,
      daysLeft,
      msmeDeadline,
      msmeDaysLeft,
      msmeAtRisk: msmeDaysLeft != null && msmeDaysLeft <= 7,
      msmeBreached: msmeDaysLeft != null && msmeDaysLeft < 0,
      deductionAtRisk: msmeDaysLeft != null && msmeDaysLeft <= 7 ? r2(total * CORPORATE_TAX_RATE) : 0,
      action,
      reason,
      inThisRun: ['pay', 'pay_partial'].includes(action) && daysLeft <= horizonDays,
      bankHold: bankHold ? inv.paymentHold.detail : null,
    };
  });

  rows.sort((a, b) => a.daysLeft - b.daysLeft);
  const run = rows.filter((r) => r.inThisRun);
  return {
    horizonDays,
    rows,
    summary: {
      invoices: rows.length,
      payNow: r2(run.reduce((a, r) => a + r.safeToPay, 0)),
      payNowCount: run.length,
      held: r2(rows.reduce((a, r) => a + r.hold, 0)),
      waiting: rows.filter((r) => r.action === 'wait').length,
      blocked: rows.filter((r) => r.action === 'blocked').length,
      blockedAmount: r2(rows.filter((r) => r.action === 'blocked').reduce((a, r) => a + r.total - r.alreadyPaid, 0)),
      overdue: rows.filter((r) => r.daysLeft < 0 && r.action !== 'wait').length,
      msmeInvoices: rows.filter((r) => r.msmeDeadline).length,
      msmeAtRisk: rows.filter((r) => r.msmeAtRisk && !r.msmeBreached).length,
      msmeBreached: rows.filter((r) => r.msmeBreached).length,
      deductionAtRisk: r2(rows.reduce((a, r) => a + r.deductionAtRisk, 0)),
      corporateTaxRateAssumed: CORPORATE_TAX_RATE,
    },
  };
}

/**
 * Cash-out forecast: what leaves the bank account each week for the next N
 * weeks, split into money that's verified, money that's still waiting on a
 * document, and money held back (disputes, bank-change holds).
 */
async function forecast(companyId, { weeks = 8 } = {}) {
  const { rows } = await payRun(companyId, { horizonDays: weeks * 7 });
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const buckets = [{ label: 'Overdue', start: null, verified: 0, unverified: 0, held: 0 }];
  for (let i = 0; i < weeks; i++) buckets.push({ label: `W${i + 1}`, start: new Date(start.getTime() + i * 7 * DAY), verified: 0, unverified: 0, held: 0 });
  for (const r of rows) {
    const idx = r.daysLeft < 0 ? 0 : Math.floor(r.daysLeft / 7) + 1;
    if (idx >= buckets.length) continue;
    const b = buckets[idx];
    const due = Math.max(0, r.total - r.credit - r.alreadyPaid);
    if (r.action === 'pay' || r.action === 'pay_partial') {
      b.verified += r.safeToPay;
      b.held += r.hold;
    } else if (r.action === 'wait') b.unverified += due;
    else if (r.action === 'hold' || r.action === 'blocked') b.held += due;
  }
  for (const b of buckets) for (const k of ['verified', 'unverified', 'held']) b[k] = r2(b[k]);
  const total = (k) => r2(buckets.reduce((a, b) => a + b[k], 0));
  return { weeks, buckets, totals: { verified: total('verified'), unverified: total('unverified'), held: total('held') } };
}

function bankFileCSV(rows) {
  const header = 'Beneficiary Name,Amount,Invoice Number,Narration';
  const lines = rows
    .filter((r) => r.inThisRun && r.safeToPay > 0)
    .map((r) => [r.vendor?.name, r.safeToPay.toFixed(2), r.invoice, `PAY ${r.invoice}${r.hold ? ' LESS DISPUTED' : ''}`].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  return [header, ...lines].join('\n');
}

module.exports = { payRun, bankFileCSV, forecast };
