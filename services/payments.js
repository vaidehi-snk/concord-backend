const crypto = require('crypto');
const Document = require('../models/Document');
const Dispute = require('../models/Dispute');
const Payment = require('../models/Payment');
const Vendor = require('../models/Vendor');
const activity = require('./activity');
const { cleanName } = require('./vendors');

/**
 * Bank / UPI statement reconciliation — the fourth leg of the match.
 * PO, challan and invoice can all agree and the business can still lose money
 * by paying the wrong amount, or paying twice. Upload a statement export
 * (CSV from any Indian bank's netbanking) and each outgoing payment is
 * matched to an invoice:
 *   1. invoice number in the narration (most reliable)
 *   2. vendor name in the narration + amount
 *   3. amount alone, if exactly one unpaid invoice has that expected amount
 * Expected amount = invoice total − whatever we recovered on its dispute.
 */

function splitCSVLine(line) {
  const cells = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if ((ch === ',' || ch === '\t' || ch === ';') && !q) {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const amountOf = (s) => {
  if (!s) return 0;
  const n = parseFloat(String(s).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

function parseDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[-/.](\d{1,2}|[A-Za-z]{3})[-/.](\d{2,4})/);
  if (m) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const mon = isNaN(m[2]) ? months[m[2].toLowerCase()] : +m[2] - 1;
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const d = new Date(Date.UTC(y, mon, +m[1]));
    return isNaN(d) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function parseStatement(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  // find the header row (bank exports often have a preamble)
  const headerIdx = lines.findIndex((l) => /date/i.test(l) && /(amount|debit|withdrawal|credit|dr\b)/i.test(l));
  if (headerIdx < 0) throw new Error('Could not find a header row with Date and Amount/Debit columns.');
  const header = splitCSVLine(lines[headerIdx]).map((h) => h.toLowerCase());
  const col = (re) => header.findIndex((h) => re.test(h));
  const dateI = col(/date/);
  const descI = col(/narration|description|particular|remark|details/);
  const refI = col(/ref|cheque|utr|chq/);
  const debitI = col(/debit|withdrawal|dr\b|paid out/);
  const amountI = col(/^amount|amount\s*\(|txn amount|transaction amount/);

  return lines
    .slice(headerIdx + 1)
    .map(splitCSVLine)
    .map((c) => {
      const amount = debitI >= 0 ? amountOf(c[debitI]) : Math.abs(amountOf(c[amountI]));
      return {
        rawDate: c[dateI],
        date: parseDate(c[dateI]),
        description: descI >= 0 ? c[descI] : c.join(' '),
        reference: refI >= 0 ? c[refI] : '',
        amount,
      };
    })
    .filter((r) => r.amount > 0);
}

async function expectedFor(invoice) {
  const disputes = await Dispute.find({ invoice: invoice._id, status: 'resolved' }).select('recoveredAmount');
  const recovered = disputes.reduce((a, d) => a + (d.recoveredAmount || 0), 0);
  return Math.round(((invoice.extracted?.totalAmount || 0) - recovered) * 100) / 100;
}

async function reconcileStatement(companyId, text, { actorName } = {}) {
  const rows = parseStatement(text);
  const invoices = await Document.find({ company: companyId, type: 'INVOICE', 'extracted.totalAmount': { $gt: 0 } }).populate('vendor', 'name aliases');
  const expected = new Map();
  for (const inv of invoices) expected.set(String(inv._id), await expectedFor(inv));
  const batchId = crypto.randomBytes(6).toString('hex');
  const paidInBatch = new Map();
  const results = [];

  for (const row of rows) {
    const narr = `${row.description} ${row.reference}`.toUpperCase().replace(/\s+/g, ' ');
    const narrCompact = narr.replace(/[^A-Z0-9]/g, '');
    let inv = invoices.find((i) => i.docNumber && i.docNumber.replace(/[^A-Z0-9]/gi, '').length >= 4 && narrCompact.includes(i.docNumber.toUpperCase().replace(/[^A-Z0-9]/g, '')));
    let matchedBy = inv ? 'invoice_number' : 'none';
    if (!inv) {
      const narrClean = cleanName(narr);
      inv = invoices.find((i) => {
        const names = [i.vendor?.name, ...(i.vendor?.aliases || [])].filter(Boolean).map(cleanName);
        const nameHit = names.some((n) => n && n.split(' ').filter((w) => w.length > 3).some((w) => narrClean.includes(w)));
        return nameHit && Math.abs(expected.get(String(i._id)) - row.amount) <= 1;
      });
      if (inv) matchedBy = 'vendor_amount';
    }
    if (!inv) {
      const candidates = invoices.filter((i) => i.paymentStatus !== 'paid' && Math.abs(expected.get(String(i._id)) - row.amount) <= 1);
      if (candidates.length === 1) {
        inv = candidates[0];
        matchedBy = 'amount';
      }
    }

    let status = 'unmatched';
    let exp = null;
    let diff = 0;
    if (inv) {
      exp = expected.get(String(inv._id));
      const alreadyPaid = (inv.amountPaid || 0) + (paidInBatch.get(String(inv._id)) || 0);
      diff = Math.round((row.amount - exp) * 100) / 100;
      if (alreadyPaid >= exp - 1) status = 'duplicate_payment';
      else if (Math.abs(row.amount + alreadyPaid - exp) <= 1) status = 'matched';
      else if (row.amount + alreadyPaid < exp) status = 'underpaid';
      else status = 'overpaid';
      paidInBatch.set(String(inv._id), (paidInBatch.get(String(inv._id)) || 0) + row.amount);
    }
    const payment = await Payment.create({
      company: companyId,
      batchId,
      date: row.date,
      rawDate: row.rawDate,
      description: row.description,
      reference: row.reference,
      amount: row.amount,
      invoice: inv?._id,
      vendor: inv?.vendor?._id,
      expectedAmount: exp,
      status,
      matchedBy,
      difference: diff,
    });
    results.push(payment);
  }

  // Update invoice payment state
  for (const [invId, paid] of paidInBatch) {
    const inv = invoices.find((i) => String(i._id) === invId);
    const exp = expected.get(invId);
    inv.amountPaid = Math.round(((inv.amountPaid || 0) + paid) * 100) / 100;
    inv.paymentStatus = inv.amountPaid > exp + 1 ? 'overpaid' : inv.amountPaid >= exp - 1 ? 'paid' : 'partial';
    await inv.save();
  }

  const summary = {
    total: results.length,
    matched: results.filter((r) => r.status === 'matched').length,
    underpaid: results.filter((r) => r.status === 'underpaid').length,
    overpaid: results.filter((r) => r.status === 'overpaid').length,
    duplicate: results.filter((r) => r.status === 'duplicate_payment').length,
    unmatched: results.filter((r) => r.status === 'unmatched').length,
    leakage: Math.round(
      results.reduce((a, r) => a + (r.status === 'duplicate_payment' ? r.amount : r.status === 'overpaid' ? Math.max(0, r.difference) : 0), 0) * 100
    ) / 100,
  };
  await activity.log(
    companyId,
    'payment',
    `Bank statement reconciled: ${summary.matched}/${summary.total} payments matched${summary.duplicate ? `, ${summary.duplicate} duplicate payment(s)` : ''}${summary.overpaid ? `, ${summary.overpaid} overpaid` : ''}`,
    { actorName, amount: summary.leakage }
  );
  return { batchId, summary, results };
}

module.exports = { reconcileStatement, parseStatement };
