const Document = require('../models/Document');
const Vendor = require('../models/Vendor');
const Gstr2bRun = require('../models/Gstr2bRun');
const activity = require('./activity');

/**
 * GSTR-2B reconciliation — the 4th document in every purchase.
 *
 * Input tax credit can only be claimed on an invoice if the SUPPLIER reported
 * it in their GSTR-1, which then shows up in the buyer's GSTR-2B. When a vendor
 * doesn't file, the buyer silently loses the GST it already paid. Concord
 * compares the 2B (official JSON from the portal, or a CSV export) with the
 * invoices it has received:
 *   matched         in both, values agree
 *   value_mismatch  in both, values differ beyond ₹1 / 0.5%
 *   missing_in_2b   we have the invoice, the supplier hasn't filed → ITC at risk
 *   not_in_books    supplier filed it, we never received it → check for a missed
 *                   delivery or a bill raised in your name you don't recognise
 */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const normInv = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
const normGstin = (s) => String(s || '').toUpperCase().replace(/\s/g, '');

function parseDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const m = String(s).match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// Official GSTR-2B JSON: data.docdata.b2b[].{ctin, trdnm, inv[].{inum, dt, val, txval, igst, cgst, sgst, cess}}
function parseJSON2B(obj) {
  const data = obj?.data || obj;
  const b2b = data?.docdata?.b2b || data?.b2b || [];
  const rows = [];
  for (const sup of b2b) {
    for (const inv of sup.inv || []) {
      const items = inv.items || inv.itms || [];
      const sumOf = (k) => (inv[k] != null ? Number(inv[k]) : items.reduce((a, it) => a + Number(it[k] || it.itm_det?.[k] || 0), 0));
      rows.push({
        supplierGstin: normGstin(sup.ctin),
        supplierName: sup.trdnm,
        invoiceNumber: inv.inum,
        invoiceDate: parseDate(inv.dt || inv.idt),
        value: Number(inv.val) || 0,
        tax: sumOf('igst') + sumOf('cgst') + sumOf('sgst') + sumOf('cess'),
      });
    }
  }
  return { period: data?.rtnprd || null, rows };
}

function splitCSV(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parseCSV2B(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const hi = lines.findIndex((l) => /gstin/i.test(l) && /invoice|inv/i.test(l));
  if (hi < 0) throw new Error('Couldn’t find the header row. It needs columns for supplier GSTIN, invoice number and invoice value.');
  const head = splitCSV(lines[hi]).map((h) => h.toLowerCase());
  const col = (...res) => head.findIndex((h) => res.some((re) => re.test(h)));
  const c = {
    gstin: col(/gstin/),
    name: col(/trade|legal|supplier name|name/),
    num: col(/invoice\s*(no|number)|inv(oice)?\s*#|^inum$/),
    date: col(/invoice\s*date|^date|^dt$/),
    value: col(/invoice\s*value|^val(ue)?$|total/),
    igst: col(/^igst|integrated/),
    cgst: col(/^cgst|central/),
    sgst: col(/^sgst|state|ut tax/),
    tax: col(/^tax$|total tax|tax amount/),
  };
  if (c.gstin < 0 || c.num < 0 || c.value < 0) throw new Error('The CSV needs supplier GSTIN, invoice number and invoice value columns.');
  const n = (row, i) => (i >= 0 ? parseFloat(String(row[i] || '').replace(/[₹,\s]/g, '')) || 0 : 0);
  const rows = lines.slice(hi + 1).map((l) => {
    const r = splitCSV(l);
    return {
      supplierGstin: normGstin(r[c.gstin]),
      supplierName: c.name >= 0 ? r[c.name] : undefined,
      invoiceNumber: r[c.num],
      invoiceDate: parseDate(r[c.date]),
      value: n(r, c.value),
      tax: c.tax >= 0 ? n(r, c.tax) : n(r, c.igst) + n(r, c.cgst) + n(r, c.sgst),
    };
  });
  return { period: null, rows: rows.filter((r) => r.supplierGstin && r.invoiceNumber) };
}

function periodRange(period, rows) {
  if (period && /^\d{6}$/.test(period)) {
    const m = Number(period.slice(0, 2)) - 1;
    const y = Number(period.slice(2));
    return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1) - 1) };
  }
  const dates = rows.map((r) => r.invoiceDate).filter(Boolean).sort((a, b) => a - b);
  if (!dates.length) return { start: null, end: null };
  return { start: dates[0], end: new Date(dates[dates.length - 1].getTime() + 86399999) };
}

const taxOf = (doc) => {
  const e = doc.extracted || {};
  if (e.taxAmount) return e.taxAmount;
  if (e.subtotal && e.totalAmount) return e.totalAmount - e.subtotal;
  if (e.taxPercent && e.totalAmount) return (e.totalAmount * e.taxPercent) / (100 + e.taxPercent);
  return 0;
};

async function reconcile2B(companyId, { text, filename, actorName, source }) {
  let parsed;
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('The file is empty.');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      throw new Error('That JSON file couldn’t be read. Download GSTR-2B again from the GST portal (Returns → GSTR-2B → Download JSON).');
    }
    parsed = parseJSON2B(obj);
    source = source || 'json';
  } else {
    parsed = parseCSV2B(trimmed);
    source = source || 'csv';
  }
  if (!parsed.rows.length) throw new Error('No B2B invoices found in this file.');

  const { start, end } = periodRange(parsed.period, parsed.rows);
  const docs = await Document.find({ company: companyId, type: 'INVOICE' }).populate('vendor', 'name gstin').select('docNumber docDate createdAt extracted.totalAmount extracted.taxAmount extracted.subtotal extracted.taxPercent extracted.vendorGstin vendor');
  const inPeriod = (d) => {
    const when = d.docDate || d.createdAt;
    return !start || (when >= start && when <= end);
  };
  const books = docs.filter(inPeriod);
  const vendors = await Vendor.find({ company: companyId }).select('name gstin');
  const vendorByGstin = new Map(vendors.filter((v) => v.gstin).map((v) => [normGstin(v.gstin), v]));

  const key = (g, n) => `${normGstin(g)}|${normInv(n)}`;
  // Match 2B rows against every invoice (dates on paper and on the portal often differ);
  // only invoices dated inside the period can be reported as missing.
  const bookMap = new Map();
  for (const d of docs) {
    const g = d.extracted?.vendorGstin || d.vendor?.gstin;
    if (d.docNumber) bookMap.set(key(g, d.docNumber), d);
  }
  // also allow a match on the vendor's registered GSTIN if the invoice printed a typo
  const bookByVendorNum = new Map();
  for (const d of docs) if (d.vendor?.gstin && d.docNumber) bookByVendorNum.set(key(d.vendor.gstin, d.docNumber), d);

  const used = new Set();
  const rows = [];
  for (const p of parsed.rows) {
    const k = key(p.supplierGstin, p.invoiceNumber);
    const d = bookMap.get(k) || bookByVendorNum.get(k);
    const v = vendorByGstin.get(p.supplierGstin);
    if (!d) {
      rows.push({ status: 'not_in_books', supplierGstin: p.supplierGstin, supplierName: v?.name || p.supplierName, vendor: v?._id, invoiceNumber: p.invoiceNumber, invoiceDate: p.invoiceDate, portalValue: r2(p.value), portalTax: r2(p.tax), itcAtRisk: 0, note: 'The supplier reported this invoice, but it isn’t in Concord. Was it delivered, or is it a bill you don’t recognise?' });
      continue;
    }
    used.add(String(d._id));
    const bv = d.extracted?.totalAmount || 0;
    const diff = Math.abs(bv - p.value);
    const ok = diff <= Math.max(1, bv * 0.005);
    rows.push({
      status: ok ? 'matched' : 'value_mismatch',
      supplierGstin: p.supplierGstin,
      supplierName: d.vendor?.name || p.supplierName,
      vendor: d.vendor?._id,
      invoiceNumber: d.docNumber,
      invoiceDate: p.invoiceDate || d.docDate,
      document: d._id,
      booksValue: r2(bv),
      portalValue: r2(p.value),
      booksTax: r2(taxOf(d)),
      portalTax: r2(p.tax),
      itcAtRisk: ok ? 0 : r2(Math.max(0, taxOf(d) - p.tax)),
      note: ok ? undefined : `Supplier filed ₹${Math.round(p.value).toLocaleString('en-IN')}, your invoice says ₹${Math.round(bv).toLocaleString('en-IN')}. ITC is limited to what they filed.`,
    });
  }
  for (const d of books) {
    if (used.has(String(d._id))) continue;
    const tax = r2(taxOf(d));
    rows.push({
      status: 'missing_in_2b',
      supplierGstin: normGstin(d.extracted?.vendorGstin || d.vendor?.gstin),
      supplierName: d.vendor?.name,
      vendor: d.vendor?._id,
      invoiceNumber: d.docNumber,
      invoiceDate: d.docDate || d.createdAt,
      document: d._id,
      booksValue: r2(d.extracted?.totalAmount),
      booksTax: tax,
      itcAtRisk: tax,
      note: 'Not in your GSTR-2B: the supplier hasn’t filed it in GSTR-1, so this GST can’t be claimed yet.',
    });
  }

  const order = { missing_in_2b: 0, value_mismatch: 1, not_in_books: 2, matched: 3 };
  rows.sort((a, b) => order[a.status] - order[b.status] || (b.itcAtRisk || 0) - (a.itcAtRisk || 0));
  const count = (s) => rows.filter((r) => r.status === s).length;
  const byVendor = {};
  for (const r of rows.filter((x) => x.status === 'missing_in_2b' || x.status === 'value_mismatch')) {
    const k = r.supplierGstin || r.supplierName;
    byVendor[k] = byVendor[k] || { vendor: r.vendor, name: r.supplierName, gstin: r.supplierGstin, invoices: [], itcAtRisk: 0 };
    byVendor[k].invoices.push(r.invoiceNumber);
    byVendor[k].itcAtRisk = r2(byVendor[k].itcAtRisk + (r.itcAtRisk || 0));
  }
  const summary = {
    invoicesInPortal: parsed.rows.length,
    invoicesInBooks: books.length,
    matched: count('matched'),
    valueMismatch: count('value_mismatch'),
    missingIn2b: count('missing_in_2b'),
    notInBooks: count('not_in_books'),
    itcClaimable: r2(rows.filter((r) => r.status === 'matched').reduce((a, r) => a + (r.portalTax || 0), 0)),
    itcAtRisk: r2(rows.reduce((a, r) => a + (r.itcAtRisk || 0), 0)),
    vendorsToChase: Object.values(byVendor).sort((a, b) => b.itcAtRisk - a.itcAtRisk),
  };
  const run = await Gstr2bRun.create({ company: companyId, period: parsed.period, periodStart: start, periodEnd: end, source, filename, uploadedBy: actorName, rows, summary });
  await activity.log(companyId, 'payment', `GSTR-2B reconciled: ${summary.matched} matched, ${summary.missingIn2b} not filed by suppliers — ₹${Math.round(summary.itcAtRisk).toLocaleString('en-IN')} of input tax credit at risk`, { actorName, amount: summary.itcAtRisk });
  return run;
}

/**
 * A realistic 2B for this company's own invoices, so anyone can try the feature
 * without a GST login: most invoices filed, one supplier silent, one value off,
 * one invoice the buyer never received.
 */
async function sample2B(companyId) {
  const docs = (await Document.find({ company: companyId, type: 'INVOICE' }).populate('vendor', 'name gstin').sort({ createdAt: -1 }).limit(40)).filter((d) => d.docNumber && (d.extracted?.vendorGstin || d.vendor?.gstin));
  if (!docs.length) throw new Error('Upload a few invoices first — the sample 2B is built from them.');
  // One supplier "hasn't filed": prefer a small MSME-style vendor; with a single vendor, leave out its latest invoice
  const gstins = [...new Set(docs.map((d) => normGstin(d.vendor?.gstin || d.extracted?.vendorGstin)))];
  const named = docs.find((d) => /om sai|vardhman/i.test(d.vendor?.name || ''));
  const silent = gstins.length > 1 ? normGstin(named?.vendor?.gstin || named?.extracted?.vendorGstin || gstins[gstins.length - 1]) : null;
  const skipId = gstins.length > 1 || docs.length < 2 ? null : String(docs[0]._id);
  const bySup = new Map();
  docs.forEach((d, i) => {
    const g = normGstin(d.extracted?.vendorGstin || d.vendor?.gstin);
    if (!g || String(d._id) === skipId || (silent && normGstin(d.vendor?.gstin || d.extracted?.vendorGstin) === silent)) return;
    const val = d.extracted?.totalAmount || 0;
    const tax = taxOf(d);
    const off = i === 2 ? 0.9 : 1; // one supplier under-reported
    if (!bySup.has(g)) bySup.set(g, { ctin: g, trdnm: d.vendor?.name?.toUpperCase(), inv: [] });
    const dt = d.docDate || d.createdAt;
    bySup.get(g).inv.push({ inum: d.docNumber, dt: `${String(dt.getUTCDate()).padStart(2, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${dt.getUTCFullYear()}`, val: r2(val * off), txval: r2((val - tax) * off), igst: 0, cgst: r2((tax / 2) * off), sgst: r2((tax / 2) * off), cess: 0 });
  });
  const first = [...bySup.values()][0];
  if (first?.inv.length) first.inv.push({ inum: `${first.inv[0]?.inum?.split('/')[0] || 'INV'}/9917`, dt: first.inv[0]?.dt, val: 41300, txval: 35000, igst: 0, cgst: 3150, sgst: 3150, cess: 0 });
  return { data: { gstin: '', rtnprd: null, version: '1.0', docdata: { b2b: [...bySup.values()] } } };
}

module.exports = { reconcile2B, sample2B, parseCSV2B, parseJSON2B };
