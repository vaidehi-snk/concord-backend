const PDFDocument = require('pdfkit');
const { makeGSTIN } = require('./gstin');

/**
 * Generates realistic Indian-format sample documents (PO, delivery challan,
 * GST tax invoice) as real PDFs. They go through the exact same extraction
 * pipeline as anything a user uploads — this is how someone evaluating
 * Concord can see the real engine work in one click without having their
 * own documents to hand.
 */

const fmt = (n) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function render(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

function table(doc, y, headers, widths, rows) {
  let x = 48;
  doc.font('Helvetica-Bold').fontSize(9);
  headers.forEach((h, i) => {
    doc.text(h, x, y, { width: widths[i] - 6, align: i === 0 ? 'left' : 'right' });
    x += widths[i];
  });
  y += 16;
  doc.moveTo(48, y - 4).lineTo(547, y - 4).strokeColor('#999').stroke();
  doc.font('Helvetica').fontSize(9);
  for (const row of rows) {
    x = 48;
    row.forEach((cell, i) => {
      doc.text(String(cell), x, y, { width: widths[i] - 6, align: i === 0 ? 'left' : 'right' });
      x += widths[i];
    });
    y += 16;
  }
  return y;
}

// Random 5-digit pack number: two sample packs must never share a PO or invoice number,
// or they'd be grouped into one purchase / flagged as duplicates.
function scenario(kind = 'short_delivery', seed = 10000 + require('crypto').randomInt(90000)) {
  const n = String(seed);
  const vendor = {
    name: 'Shree Ganesh Engineering Works Pvt. Ltd.',
    gstin: makeGSTIN('27', 'AAKCS4821M'),
    address: 'Plot 42, MIDC Bhosari, Pune 411026',
  };
  const buyer = { name: 'Your Company', gstin: makeGSTIN('27', 'AADCY7731P'), address: 'Chakan Industrial Area, Pune 410501' };
  // vary quantities per pack so two sample packs never look like duplicate bills
  const k = 1 + (Number(n) % 9) / 10;
  const items = [
    { description: 'MS Bracket 40x40 (Zinc plated)', hsn: '7326', qty: Math.round(500 * k), rate: 48 },
    { description: 'Hex Bolt M10 x 50 Gr 8.8', hsn: '7318', qty: Math.round(2000 * k / 10) * 10, rate: 6.5 },
    { description: 'Rubber Gasket 65mm EPDM', hsn: '4016', qty: Math.round(300 * k), rate: 22 },
  ];
  const poNumber = `PO-${n}`;
  const delivered = items.map((it) => it.qty);
  const invoiced = items.map((it) => ({ ...it }));
  let invoiceGstin = vendor.gstin;
  let taxPct = 18;

  if (kind === 'short_delivery') delivered[0] = Math.round(items[0].qty * 0.84); // 80 brackets never arrived, all 500 billed
  if (kind === 'price_drift') invoiced[1].rate = 7.25; // bolt price crept up vs agreed PO rate
  if (kind === 'gst_error') invoiceGstin = vendor.gstin.slice(0, 14) + (vendor.gstin[14] === 'A' ? 'B' : 'A'); // check digit typo
  if (kind === 'mixed') {
    delivered[2] = Math.round(items[2].qty * 0.83);
    invoiced[0].rate = 51;
  }

  return { n, vendor, buyer, items, poNumber, delivered, invoiced, invoiceGstin, taxPct, kind };
}

async function purchaseOrder(s) {
  return render((doc) => {
    doc.font('Helvetica-Bold').fontSize(18).text('PURCHASE ORDER', 48, 48);
    doc.font('Helvetica').fontSize(9).text(`${s.buyer.name}   GSTIN: ${s.buyer.gstin}`, 48, 74).text(s.buyer.address, 48, 86);
    doc.font('Helvetica').fontSize(10);
    doc.text(`PO Number: ${s.poNumber}`, 360, 74).text('PO Date: 02-09-2026', 360, 88);
    doc.font('Helvetica-Bold').text('Vendor:', 48, 120).font('Helvetica').text(s.vendor.name, 110, 120);
    doc.text(`GSTIN: ${s.vendor.gstin}`, 110, 134).text(s.vendor.address, 110, 148);
    const rows = s.items.map((it) => [it.description, it.hsn, it.qty, fmt(it.rate), fmt(it.qty * it.rate)]);
    let y = table(doc, 190, ['Description', 'HSN', 'Qty', 'Rate', 'Amount'], [230, 60, 60, 70, 80], rows);
    const sub = s.items.reduce((a, it) => a + it.qty * it.rate, 0);
    const tax = sub * (s.taxPct / 100);
    y += 10;
    doc.text(`Sub Total   ${fmt(sub)}`, 360, y, { width: 187, align: 'right' });
    doc.text(`GST @ ${s.taxPct}%   ${fmt(tax)}`, 360, y + 16, { width: 187, align: 'right' });
    doc.font('Helvetica-Bold').text(`Grand Total   Rs. ${fmt(sub + tax)}`, 300, y + 34, { width: 247, align: 'right' });
    doc.font('Helvetica').fontSize(8).text('Payment terms: 30 days from receipt of goods. Delivery within 10 days.', 48, y + 70);
  });
}

async function deliveryChallan(s) {
  return render((doc) => {
    doc.font('Helvetica-Bold').fontSize(16).text(s.vendor.name, 48, 48);
    doc.font('Helvetica').fontSize(9).text(`${s.vendor.address}   GSTIN: ${s.vendor.gstin}`, 48, 70);
    doc.font('Helvetica-Bold').fontSize(14).text('DELIVERY CHALLAN', 48, 100);
    doc.font('Helvetica').fontSize(10);
    doc.text(`Challan No: DC-${s.n}`, 360, 100).text('Date: 09-09-2026', 360, 114);
    doc.text(`Against PO: ${s.poNumber}`, 48, 124).text(`Consignee: ${s.buyer.name}`, 48, 138);
    const rows = s.items.map((it, i) => [it.description, it.hsn, it.qty, s.delivered[i]]);
    table(doc, 180, ['Description', 'HSN', 'Qty Ordered', 'Qty Delivered'], [250, 70, 90, 90], rows);
    doc.fontSize(8).text('Received the above goods in good condition.   Receiver signature: ____________', 48, 300);
  });
}

async function taxInvoice(s) {
  return render((doc) => {
    doc.font('Helvetica-Bold').fontSize(16).text(s.vendor.name, 48, 48);
    doc.font('Helvetica').fontSize(9).text(`${s.vendor.address}   GSTIN: ${s.invoiceGstin}`, 48, 70);
    doc.font('Helvetica-Bold').fontSize(14).text('TAX INVOICE', 48, 100);
    doc.font('Helvetica').fontSize(10);
    doc.text(`Invoice No: INV-${s.n}`, 360, 100).text('Invoice Date: 12-09-2026', 360, 114).text('Due Date: 12-10-2026', 360, 128);
    doc.text(`Buyer: ${s.buyer.name}   GSTIN: ${s.buyer.gstin}`, 48, 124).text(`Against PO: ${s.poNumber}`, 48, 138);
    const rows = s.invoiced.map((it) => [it.description, it.hsn, it.qty, fmt(it.rate), fmt(it.qty * it.rate)]);
    let y = table(doc, 180, ['Description', 'HSN', 'Qty', 'Rate', 'Amount'], [230, 60, 60, 70, 80], rows);
    const sub = s.invoiced.reduce((a, it) => a + it.qty * it.rate, 0);
    const tax = sub * (s.taxPct / 100);
    y += 10;
    doc.text(`Sub Total   ${fmt(sub)}`, 360, y, { width: 187, align: 'right' });
    doc.text(`GST @ ${s.taxPct}%   ${fmt(tax)}`, 360, y + 16, { width: 187, align: 'right' });
    doc.font('Helvetica-Bold').text(`Grand Total   Rs. ${fmt(sub + tax)}`, 300, y + 34, { width: 247, align: 'right' });
    doc.font('Helvetica').fontSize(8).text('Bank: HDFC Bank, A/c 50200012345678, IFSC HDFC0000123. Interest @18% p.a. on overdue payments.', 48, y + 70);
  });
}

async function samplePack(kind, seed) {
  const s = Number.isInteger(seed) && seed >= 10000 && seed < 100000 ? scenario(kind, seed) : scenario(kind);
  return {
    scenario: s,
    files: [
      { filename: `${s.poNumber}.pdf`, buffer: await purchaseOrder(s) },
      { filename: `DC-${s.n}.pdf`, buffer: await deliveryChallan(s) },
      { filename: `INV-${s.n}.pdf`, buffer: await taxInvoice(s) },
    ],
  };
}

module.exports = { samplePack, scenario, purchaseOrder, deliveryChallan, taxInvoice };
