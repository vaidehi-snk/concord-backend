const PDFDocument = require('pdfkit');
const Dispute = require('../models/Dispute');
const Company = require('../models/Company');
const { overview } = require('./analytics');
const { payRun } = require('./payables');
const Gstr2bRun = require('../models/Gstr2bRun');

const r2 = (n) => Math.round((n || 0) * 100) / 100;
const rs = (n) => `Rs. ${Math.round(n || 0).toLocaleString('en-IN')}`;
const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ymd = (d) => new Date(d).toISOString().slice(0, 10).replace(/-/g, '');

/**
 * Tally Prime import: one Debit Note voucher per settled dispute.
 * Party (vendor) ledger is debited with the full amount; the taxable part is
 * credited to the purchase-adjustment ledger and the GST part to the input-tax
 * ledger, so ITC is reversed correctly. Ledger names must exist in Tally —
 * they default to common names and can be overridden with query params.
 */
async function tallyDebitNotesXML(companyId, { purchaseLedger = 'Purchase Returns', taxLedger = 'Input GST', since } = {}) {
  const company = await Company.findById(companyId).select('name');
  const filter = { company: companyId, status: 'resolved', recoveredAmount: { $gt: 0 } };
  if (since) filter['resolution.resolvedAt'] = { $gte: new Date(since) };
  const disputes = await Dispute.find(filter).populate('vendor', 'name').populate('invoice po', 'docNumber extracted.taxPercent').sort({ 'resolution.resolvedAt': 1 });
  const vouchers = disputes.map((d) => {
    const amt = r2(d.recoveredAmount);
    const pct = d.invoice?.extracted?.taxPercent || 0;
    const taxable = r2(pct ? amt / (1 + pct / 100) : amt);
    const gst = r2(amt - taxable);
    const party = xml(d.vendor?.name);
    const lines = [
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${party}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${amt.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`,
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(purchaseLedger)}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${taxable.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`,
    ];
    if (gst > 0) lines.push(`<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(taxLedger)}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${gst.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`);
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Debit Note" ACTION="Create"><DATE>${ymd(d.resolution?.resolvedAt || d.updatedAt)}</DATE><VOUCHERTYPENAME>Debit Note</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(d.reference)}</VOUCHERNUMBER><REFERENCE>${xml(d.invoice?.docNumber)}</REFERENCE><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME><NARRATION>${xml(`Concord ${d.reference}: ${d.flags.map((f) => f.description).join('; ')}`.slice(0, 480))}</NARRATION>${lines.join('')}</VOUCHER></TALLYMESSAGE>`;
  });
  return {
    count: vouchers.length,
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xml(company?.name)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${vouchers.join('')}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`,
  };
}

const ISSUE = {
  SHORT_DELIVERY: 'Short delivery',
  QTY_OVER_PO: 'Billed above PO quantity',
  PRICE_MISMATCH: 'Price above PO rate',
  ITEM_NOT_ON_PO: 'Item never ordered',
  TAX_RATE_MISMATCH: 'Wrong GST rate',
  LINE_ARITHMETIC: 'Line maths wrong',
  TOTAL_ARITHMETIC: 'Totals do not add up',
  TOTAL_OVER_PO: 'Total above PO value',
  GSTIN_INVALID: 'Invalid GSTIN',
  GSTIN_MISMATCH: 'GSTIN differs from vendor',
  DUPLICATE_INVOICE: 'Duplicate invoice',
  DN_UNVERIFIABLE: 'Delivery not verifiable',
  PO_PRESENT: 'No purchase order',
};

/**
 * One-page savings report for the owner / CFO: what Concord found, what came
 * back, what's still at stake, and what's coming due. The page a finance head
 * forwards to justify the subscription.
 */
async function savingsReportPDF(companyId) {
  const [company, ov, run, gst, resolved] = await Promise.all([
    Company.findById(companyId).select('name gstin'),
    overview(companyId, { weeks: 12 }),
    payRun(companyId, { horizonDays: 14 }),
    Gstr2bRun.findOne({ company: companyId }).sort({ createdAt: -1 }).select('summary createdAt'),
    Dispute.find({ company: companyId, status: 'resolved' }).populate('vendor', 'name').sort({ recoveredAmount: -1 }).limit(6),
  ]);
  const k = ov.kpis;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const INK = '#141A33';
    const MUTED = '#646B82';
    const BLUE = '#4F5DE8';
    doc.rect(0, 0, 595, 120).fill('#0A0E18');
    doc.fillColor('#AAB3FF').font('Helvetica-Bold').fontSize(10).text('CONCORD', 48, 40);
    doc.fillColor('#FFFFFF').fontSize(22).text('Savings report', 48, 56);
    doc.fillColor('#B9BFD3').font('Helvetica').fontSize(10).text(`${company?.name || ''}${company?.gstin ? `   GSTIN ${company.gstin}` : ''}   ·   last 12 weeks to ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`, 48, 86);

    // headline figures
    const tiles = [
      ['Recovered', rs(k.moneyRecovered), `${Math.round(k.recoveryRate * 100)}% of everything flagged`],
      ['Flagged', rs(k.moneyFlagged), `${ov.issueBreakdown.reduce((a, x) => a + x.count, 0)} issues across ${k.purchasesChecked} purchases`],
      ['Still at stake', rs(k.moneyAtRisk), `${k.openDisputes} open disputes`],
      ['Paid twice, caught', rs(k.paymentLeakage), 'from bank statement checks'],
    ];
    tiles.forEach(([label, value, sub], i) => {
      const x = 48 + i * 125;
      doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(label.toUpperCase(), x, 146, { width: 118 });
      doc.fillColor(i === 0 ? '#14845A' : i === 2 ? '#C3302B' : INK).font('Helvetica-Bold').fontSize(15).text(value, x, 160, { width: 118 });
      doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(sub, x, 182, { width: 112 });
    });
    doc.moveTo(48, 214).lineTo(547, 214).strokeColor('#E2E5EE').lineWidth(1).stroke();

    let y = 232;
    const h = (t) => {
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(t, 48, y);
      y += 22;
    };
    h('Efficiency');
    [
      [`${Math.round(k.touchlessRate * 100)}%`, 'of purchases matched with no one touching them'],
      [`${Math.round(k.hoursSaved)} hours`, `of manual matching avoided (at ~${k.minutesPerManualMatchAssumed} min per 3-way match)`],
      [`${Math.round(k.autoReadRate * 100)}%`, `of ${k.documentsProcessed} documents read without correction`],
      [k.avgResolutionDays != null ? `${k.avgResolutionDays} days` : '—', 'average time to settle a dispute'],
    ].forEach(([a, b]) => {
      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(10).text(a, 48, y, { width: 90 });
      doc.fillColor(INK).font('Helvetica').fontSize(10).text(b, 140, y);
      y += 17;
    });
    y += 12;
    h('Where the money leaked');
    const maxAmt = Math.max(1, ...ov.issueBreakdown.map((x) => x.amount));
    ov.issueBreakdown.slice(0, 6).forEach((x) => {
      doc.fillColor(INK).font('Helvetica').fontSize(9.5).text(`${ISSUE[x.code] || x.code} (${x.count})`, 48, y, { width: 170 });
      doc.rect(220, y + 2, Math.max(2, (x.amount / maxAmt) * 250), 7).fill(BLUE);
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(rs(x.amount), 478, y, { width: 69, align: 'right' });
      y += 17;
    });
    y += 12;
    h('Largest recoveries');
    resolved.forEach((d) => {
      doc.fillColor(INK).font('Helvetica').fontSize(9.5).text(`${d.reference}  ${d.vendor?.name || ''}`, 48, y, { width: 300 });
      doc.fillColor(MUTED).fontSize(9).text((d.resolution?.outcome || '').replace(/_/g, ' '), 350, y, { width: 110 });
      doc.fillColor('#14845A').font('Helvetica-Bold').fontSize(9.5).text(rs(d.recoveredAmount), 460, y, { width: 87, align: 'right' });
      y += 16;
    });
    if (!resolved.length) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9.5).text('No disputes settled yet.', 48, y);
      y += 16;
    }
    y += 12;
    h('Next two weeks');
    const s = run.summary;
    [
      [`${rs(s.payNow)}`, `safe to pay across ${s.payNowCount} verified invoices`],
      [`${rs(s.held)}`, 'held back on disputed lines only'],
      [`${s.msmeAtRisk + s.msmeBreached}`, `MSME invoices near or past the 45-day limit (tax cost if missed: ${rs(s.deductionAtRisk)})`],
      [`${s.blocked || 0}`, 'invoices blocked because the vendor’s bank account changed'.replace('’', "'")],
      ...(gst ? [[rs(gst.summary.itcAtRisk), `input tax credit at risk: suppliers yet to file (GSTR-2B of ${new Date(gst.createdAt).toLocaleDateString('en-IN')})`]] : []),
    ].forEach(([a, b]) => {
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(a, 48, y, { width: 90 });
      doc.font('Helvetica').text(b, 140, y, { width: 407 });
      y += 17;
    });
    doc.page.margins.bottom = 0;
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text('Generated by Concord. Figures come from the documents, disputes and bank statements in this workspace. Tax figures are estimates, not tax advice.', 48, 790, { width: 499 });
    doc.end();
  });
}

module.exports = { tallyDebitNotesXML, savingsReportPDF };
