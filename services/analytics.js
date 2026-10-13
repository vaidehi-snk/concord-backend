const mongoose = require('mongoose');
const Gstr2bRun = require('../models/Gstr2bRun');
const Document = require('../models/Document');
const Match = require('../models/Match');
const Dispute = require('../models/Dispute');
const Vendor = require('../models/Vendor');
const Payment = require('../models/Payment');

const r2 = (n) => Math.round((n || 0) * 100) / 100;

// Rough, stated assumption used for the "hours saved" metric. Shown in the UI
// next to the number so nobody mistakes it for a measurement.
const MINUTES_PER_MANUAL_MATCH = 12;

function weekStart(d) {
  const x = new Date(d);
  const day = (x.getUTCDay() + 6) % 7; // Monday start
  x.setUTCHours(0, 0, 0, 0);
  x.setUTCDate(x.getUTCDate() - day);
  return x;
}

async function overview(companyId, { weeks = 10 } = {}) {
  const company = new mongoose.Types.ObjectId(String(companyId));
  const latest2b = await Gstr2bRun.findOne({ company }).sort({ createdAt: -1 }).select('summary createdAt');
  const [docs, matches, disputes, vendors, payments] = await Promise.all([
    Document.find({ company }).select('type parseStatus extractionMethod createdAt extracted.totalAmount paymentStatus paymentHold docNumber vendor').populate('vendor', 'name'),
    Match.find({ company }).select('status touchless matchedAt createdAt invoiceTotal matchType'),
    Dispute.find({ company }).populate('vendor', 'name').select('status totalFinancialImpact recoveredAmount flags createdAt updatedAt resolution priority vendor reference dueDate'),
    Vendor.find({ company }).select('name stats gstin gstinValid'),
    Payment.find({ company }).select('status amount difference createdAt'),
  ]);

  const holds = docs.filter((d) => d.paymentHold?.reason && !d.paymentHold.clearedAt);
  const evaluated = matches.filter((m) => m.status !== 'awaiting_documents');
  const touchless = evaluated.filter((m) => m.status === 'matched' && m.touchless).length;
  const open = disputes.filter((d) => !['resolved', 'dismissed'].includes(d.status));
  const resolved = disputes.filter((d) => d.status === 'resolved');
  const atRisk = open.reduce((a, d) => a + d.totalFinancialImpact, 0);
  const recovered = disputes.reduce((a, d) => a + (d.recoveredAmount || 0), 0);
  const flaggedTotal = disputes.reduce((a, d) => a + d.totalFinancialImpact, 0);
  const resolutionDays = resolved
    .filter((d) => d.resolution?.resolvedAt)
    .map((d) => (new Date(d.resolution.resolvedAt) - new Date(d.createdAt)) / 86400000);
  const paymentLeak = payments.reduce((a, p) => a + (p.status === 'duplicate_payment' ? p.amount : p.status === 'overpaid' ? Math.max(0, p.difference) : 0), 0);
  const overdue = open.filter((d) => d.dueDate && new Date(d.dueDate) < new Date()).length;

  // weekly series
  const now = weekStart(new Date());
  const series = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(now.getTime() - i * 7 * 86400000);
    const end = new Date(start.getTime() + 7 * 86400000);
    const inWeek = (d) => d >= start && d < end;
    series.push({
      week: start.toISOString().slice(0, 10),
      documents: docs.filter((d) => inWeek(d.createdAt)).length,
      matched: matches.filter((m) => m.matchedAt && inWeek(m.matchedAt)).length,
      flagged: r2(disputes.filter((d) => inWeek(d.createdAt)).reduce((a, d) => a + d.totalFinancialImpact, 0)),
      recovered: r2(disputes.filter((d) => d.resolution?.resolvedAt && inWeek(new Date(d.resolution.resolvedAt))).reduce((a, d) => a + (d.recoveredAmount || 0), 0)),
    });
  }

  // what kinds of problems
  const byCode = {};
  for (const d of disputes) {
    for (const f of d.flags || []) {
      const k = f.code || f.field;
      byCode[k] = byCode[k] || { code: k, count: 0, amount: 0 };
      byCode[k].count++;
      byCode[k].amount += f.financialImpact || 0;
    }
  }

  const topVendors = vendors
    .filter((v) => v.stats?.totalDisputes)
    .sort((a, b) => (b.stats.totalDisputedAmount || 0) - (a.stats.totalDisputedAmount || 0))
    .slice(0, 6)
    .map((v) => ({ id: v._id, name: v.name, risk: v.stats.riskScore, disputes: v.stats.totalDisputes, amount: r2(v.stats.totalDisputedAmount), recovered: r2(v.stats.recoveredAmount) }));

  const needsAttention = open
    .map((d) => ({
      id: d._id,
      reference: d.reference,
      vendor: d.vendor?.name,
      amount: r2(d.totalFinancialImpact),
      status: d.status,
      priority: d.priority,
      overdue: d.dueDate && new Date(d.dueDate) < new Date(),
      headline: d.flags?.[0]?.description,
    }))
    .sort((a, b) => (b.overdue - a.overdue) || ({ high: 3, medium: 2, low: 1 }[b.priority] - { high: 3, medium: 2, low: 1 }[a.priority]) || b.amount - a.amount)
    .slice(0, 6);

  return {
    kpis: {
      documentsProcessed: docs.length,
      autoReadRate: docs.length ? r2(docs.filter((d) => d.parseStatus === 'parsed').length / docs.length) : 0,
      purchasesChecked: evaluated.length,
      touchlessRate: evaluated.length ? r2(touchless / evaluated.length) : 0,
      awaitingDocuments: matches.filter((m) => m.status === 'awaiting_documents').length,
      openDisputes: open.length,
      overdueDisputes: overdue,
      moneyAtRisk: r2(atRisk),
      moneyFlagged: r2(flaggedTotal),
      moneyRecovered: r2(recovered),
      recoveryRate: flaggedTotal ? r2(recovered / flaggedTotal) : 0,
      avgResolutionDays: resolutionDays.length ? r2(resolutionDays.reduce((a, b) => a + b, 0) / resolutionDays.length) : null,
      paymentLeakage: r2(paymentLeak),
      hoursSaved: r2((evaluated.length * MINUTES_PER_MANUAL_MATCH) / 60),
      minutesPerManualMatchAssumed: MINUTES_PER_MANUAL_MATCH,
      vendors: vendors.length,
      invalidGstinVendors: vendors.filter((v) => v.gstin && v.gstinValid === false).length,
      paymentHolds: holds.length,
      paymentHoldAmount: r2(holds.reduce((a, d) => a + (d.extracted?.totalAmount || 0), 0)),
      itcAtRisk: latest2b ? r2(latest2b.summary?.itcAtRisk) : null,
      gstVendorsToChase: latest2b ? (latest2b.summary?.vendorsToChase || []).length : null,
    },
    series,
    issueBreakdown: Object.values(byCode).map((x) => ({ ...x, amount: r2(x.amount) })).sort((a, b) => b.amount - a.amount || b.count - a.count),
    statusFunnel: ['open', 'pending_approval', 'email_drafted', 'awaiting_vendor', 'resolved', 'dismissed'].map((s) => ({ status: s, count: disputes.filter((d) => d.status === s).length })),
    topVendors,
    needsAttention,
    holds: holds.map((d) => ({ id: d._id, invoice: d.docNumber, vendor: d.vendor?.name, vendorId: d.vendor?._id, amount: r2(d.extracted?.totalAmount), detail: d.paymentHold.detail })),
  };
}

module.exports = { overview, MINUTES_PER_MANUAL_MATCH };
