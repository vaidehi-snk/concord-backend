const { validateGSTIN } = require('./gstin');

/**
 * The rulebook. Takes the PO, delivery note (optional) and invoice for one
 * purchase and runs every check, returning:
 *   checks: [{ code, label, status: 'pass'|'fail'|'skip', detail }]  — the full checklist, shown in the UI
 *   flags:  [{ code, severity, field, item, description, expected, actual, ... financialImpact }]
 *
 * Every flag carries the evidence it came from, so "why was this flagged?"
 * is answered by data, not by re-reading a sentence.
 *
 * Money is never double counted: quantity problems on an item are charged
 * once (billed − min(ordered, delivered)), and price drift is charged only on
 * the quantity actually accepted.
 */

const CHECKS = [
  ['PO_PRESENT', 'Invoice is backed by a purchase order'],
  ['ITEM_NOT_ON_PO', 'Every billed item was ordered'],
  ['QTY_OVER_PO', 'Billed quantity within ordered quantity'],
  ['SHORT_DELIVERY', 'Billed quantity was actually delivered'],
  ['PRICE_MISMATCH', 'Unit prices match the agreed PO rates'],
  ['TAX_RATE_MISMATCH', 'GST rate matches the PO'],
  ['LINE_ARITHMETIC', 'Each line: quantity × rate = amount'],
  ['TOTAL_ARITHMETIC', 'Invoice totals add up'],
  ['TOTAL_OVER_PO', 'Invoice total within PO value'],
  ['GSTIN_INVALID', "Supplier GSTIN passes the government check digit"],
  ['GSTIN_MISMATCH', "Supplier GSTIN matches the vendor's registered GSTIN"],
  ['DUPLICATE_INVOICE', 'Not a duplicate of an invoice already received'],
  ['DN_UNVERIFIABLE', 'Delivery challan is readable for every billed item'],
];

const round2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) => `₹${round2(n).toLocaleString('en-IN')}`;

function tokens(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !['the', 'and', 'of', 'for', 'with', 'pcs', 'nos'].includes(t));
}

function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

// Best-match an item by SKU, then description similarity (≥ 0.6 overlap).
function findItem(item, list) {
  if (!item || !list?.length) return null;
  if (item.sku) {
    const bySku = list.find((x) => x.sku && x.sku.toLowerCase() === item.sku.toLowerCase());
    if (bySku) return bySku;
  }
  let best = null;
  let bestScore = 0;
  for (const cand of list) {
    const s = similarity(item.description, cand.description);
    if (s > bestScore) {
      best = cand;
      bestScore = s;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

function itemsOf(doc) {
  const ex = doc?.extracted || {};
  if (ex.lineItems?.length) return ex.lineItems.filter((li) => li && li.description);
  if (ex.quantity != null) return [{ description: 'Item', quantity: ex.deliveredQuantity ?? ex.quantity, unitPrice: ex.unitPrice, total: ex.totalAmount }];
  return [];
}

/**
 * @param {object} p
 * @param {Document} p.po
 * @param {Document} [p.dn]
 * @param {Document} p.invoice
 * @param {object} p.settings      company tolerance settings
 * @param {Vendor} [p.vendor]
 * @param {Document[]} [p.otherInvoices]  this vendor's other invoices (duplicate detection)
 */
function runChecks({ po, dn, invoice, settings = {}, vendor, otherInvoices = [] }) {
  const priceTol = (settings.priceTolerancePct ?? 1) / 100;
  const qtyTol = (settings.qtyTolerancePct ?? 0) / 100;
  const amtTol = settings.amountToleranceAbs ?? 5;
  const dupWindow = (settings.duplicateWindowDays ?? 45) * 86400000;

  const status = Object.fromEntries(CHECKS.map(([code]) => [code, { status: 'pass', detail: '' }]));
  const flags = [];
  const fail = (code, flag) => {
    status[code] = { status: 'fail', detail: flag.description };
    flags.push({ code, ...flag });
  };
  const skip = (code, detail) => {
    if (status[code].status !== 'fail') status[code] = { status: 'skip', detail };
  };

  const poNum = po?.docNumber || 'PO';
  const invNum = invoice?.docNumber || 'invoice';
  const dnNum = dn?.docNumber || 'delivery challan';
  const poItems = itemsOf(po);
  const invItems = itemsOf(invoice);
  const dnItems = itemsOf(dn);
  const inv = invoice?.extracted || {};
  const poEx = po?.extracted || {};

  // ---- PO present ----
  if (!po) {
    fail('PO_PRESENT', {
      severity: 'HIGH',
      field: 'po',
      description: `Invoice ${invNum} has no matching purchase order — nobody approved this spend.`,
      financialImpact: 0,
    });
  }

  // ---- item level ----
  const lineImpacts = [];
  if (po && invItems.length && poItems.length) {
    for (const it of invItems) {
      const poIt = findItem(it, poItems);
      const dnIt = dn ? findItem(it, dnItems) : null;
      const price = it.unitPrice ?? poIt?.unitPrice ?? 0;

      if (!poIt) {
        const impact = it.total ?? (it.quantity || 0) * (it.unitPrice || 0);
        fail('ITEM_NOT_ON_PO', {
          severity: 'HIGH',
          field: 'lineItem',
          item: it.description,
          description: `"${it.description}" is billed on ${invNum} but was never ordered on ${poNum}.`,
          expected: 'not ordered',
          actual: `${it.quantity} × ${fmt(price)}`,
          expectedSource: poNum,
          actualSource: invNum,
          formula: `${it.quantity} × ${fmt(price)} = ${fmt(impact)}`,
          financialImpact: round2(impact),
        });
        continue;
      }

      // Quantity: charge once, against the stricter of ordered/delivered.
      const billed = it.quantity ?? 0;
      const ordered = poIt.quantity ?? billed;
      const delivered = dnIt?.quantity;
      const overPO = billed > ordered * (1 + qtyTol) ? billed - ordered : 0;
      const short = delivered != null && billed > delivered * (1 + qtyTol) ? billed - delivered : 0;
      const acceptedQty = Math.min(billed, ordered, delivered ?? Infinity);
      const excessQty = billed - acceptedQty;

      if (short > 0) {
        fail('SHORT_DELIVERY', {
          severity: 'HIGH',
          field: 'deliveredQuantity',
          item: it.description,
          description: `"${it.description}": billed for ${billed}, but ${dnNum} shows only ${delivered} received.`,
          expected: delivered,
          actual: billed,
          expectedSource: dnNum,
          actualSource: invNum,
          formula: `(${billed} − ${Math.min(delivered, ordered)}) × ${fmt(price)} = ${fmt(excessQty * price)}`,
          financialImpact: round2(excessQty * price),
        });
      }
      if (overPO > 0) {
        fail('QTY_OVER_PO', {
          severity: short > 0 ? 'MED' : 'HIGH',
          field: 'quantity',
          item: it.description,
          description: `"${it.description}": billed for ${billed}, but ${poNum} only ordered ${ordered}.`,
          expected: ordered,
          actual: billed,
          expectedSource: poNum,
          actualSource: invNum,
          formula: short > 0 ? 'Included in the short-delivery amount above' : `(${billed} − ${ordered}) × ${fmt(price)} = ${fmt(excessQty * price)}`,
          financialImpact: short > 0 ? 0 : round2(excessQty * price),
        });
      }

      // Price: only overcharges, beyond tolerance, charged on accepted quantity
      if (poIt.unitPrice != null && it.unitPrice != null && it.unitPrice > poIt.unitPrice * (1 + priceTol)) {
        const diff = it.unitPrice - poIt.unitPrice;
        fail('PRICE_MISMATCH', {
          severity: diff / poIt.unitPrice > 0.05 ? 'HIGH' : 'MED',
          field: 'unitPrice',
          item: it.description,
          description: `"${it.description}": invoiced at ${fmt(it.unitPrice)}/unit vs agreed ${fmt(poIt.unitPrice)} on ${poNum} (+${((diff / poIt.unitPrice) * 100).toFixed(1)}%).`,
          expected: poIt.unitPrice,
          actual: it.unitPrice,
          expectedSource: poNum,
          actualSource: invNum,
          formula: `(${fmt(it.unitPrice)} − ${fmt(poIt.unitPrice)}) × ${acceptedQty} = ${fmt(diff * acceptedQty)}`,
          financialImpact: round2(diff * acceptedQty),
        });
      }

      // Line arithmetic on the invoice itself
      if (it.total != null && it.unitPrice != null && it.quantity != null) {
        const calc = it.quantity * it.unitPrice;
        if (it.total - calc > amtTol) {
          fail('LINE_ARITHMETIC', {
            severity: 'MED',
            field: 'lineTotal',
            item: it.description,
            description: `"${it.description}": ${it.quantity} × ${fmt(it.unitPrice)} = ${fmt(calc)}, but the line says ${fmt(it.total)}.`,
            expected: round2(calc),
            actual: it.total,
            expectedSource: 'calculated',
            actualSource: invNum,
            formula: `${fmt(it.total)} − ${fmt(calc)} = ${fmt(it.total - calc)}`,
            financialImpact: round2(it.total - calc),
          });
        }
      }
      lineImpacts.push(it);
    }
  } else if (po) {
    skip('ITEM_NOT_ON_PO', 'Line items could not be read from one of the documents');
    skip('QTY_OVER_PO', 'Line items could not be read from one of the documents');
    skip('PRICE_MISMATCH', 'Line items could not be read from one of the documents');
    skip('LINE_ARITHMETIC', 'Line items could not be read from the invoice');
  }

  // The buyer overpays the GST on any overbilled amount too — gross item-level
  // impacts up by the invoice GST rate so the ₹ figure is what actually leaves the bank.
  const taxPct = inv.taxPercent ?? poEx.taxPercent;
  if (taxPct > 0) {
    for (const f of flags) {
      if (['ITEM_NOT_ON_PO', 'SHORT_DELIVERY', 'QTY_OVER_PO', 'PRICE_MISMATCH', 'LINE_ARITHMETIC'].includes(f.code) && f.financialImpact > 0) {
        const gross = round2(f.financialImpact * (1 + taxPct / 100));
        f.formula = `${f.formula} + ${taxPct}% GST = ${fmt(gross)}`;
        f.financialImpact = gross;
      }
    }
  }

  // ---- delivery note coverage ----
  if (!dn) {
    skip('SHORT_DELIVERY', 'Waiting for the delivery challan / goods receipt');
    skip('DN_UNVERIFIABLE', 'Waiting for the delivery challan / goods receipt');
  } else {
    const unverified = invItems.filter((it) => findItem(it, poItems) && !findItem(it, dnItems));
    if (invItems.length && (unverified.length === invItems.length || !dnItems.length)) {
      fail('DN_UNVERIFIABLE', {
        severity: 'MED',
        field: 'deliveredQuantity',
        description: `${dnNum} could not be read item-by-item, so delivery can't be confirmed. This is not a confirmation that delivery matches.`,
        financialImpact: 0,
      });
    } else if (unverified.length) {
      fail('DN_UNVERIFIABLE', {
        severity: 'MED',
        field: 'deliveredQuantity',
        item: unverified.map((u) => u.description).join(', '),
        description: `${unverified.length} billed item(s) do not appear on ${dnNum}: ${unverified.map((u) => `"${u.description}"`).join(', ')}.`,
        financialImpact: 0,
      });
    }
  }

  // ---- tax rate ----
  if (po && poEx.taxPercent != null && inv.taxPercent != null) {
    if (Math.abs(inv.taxPercent - poEx.taxPercent) > 0.01) {
      const taxable = inv.subtotal ?? invItems.reduce((a, i) => a + (i.total || 0), 0);
      const impact = Math.max(0, ((inv.taxPercent - poEx.taxPercent) / 100) * taxable);
      fail('TAX_RATE_MISMATCH', {
        severity: inv.taxPercent > poEx.taxPercent ? 'HIGH' : 'LOW',
        field: 'taxPercent',
        description: `GST charged at ${inv.taxPercent}% on ${invNum}; ${poNum} specifies ${poEx.taxPercent}%. Check the HSN rate before paying.`,
        expected: poEx.taxPercent,
        actual: inv.taxPercent,
        expectedSource: poNum,
        actualSource: invNum,
        formula: `(${inv.taxPercent}% − ${poEx.taxPercent}%) × ${fmt(taxable)} = ${fmt(impact)}`,
        financialImpact: round2(impact),
      });
    }
  } else {
    skip('TAX_RATE_MISMATCH', 'GST rate not printed on one of the documents');
  }

  // ---- totals arithmetic ----
  const lineSum = invItems.reduce((a, i) => a + (i.total ?? (i.quantity || 0) * (i.unitPrice || 0)), 0);
  if (inv.subtotal != null && invItems.length && Math.abs(lineSum - inv.subtotal) > amtTol) {
    fail('TOTAL_ARITHMETIC', {
      severity: 'MED',
      field: 'subtotal',
      description: `Line items on ${invNum} add up to ${fmt(lineSum)}, but the subtotal says ${fmt(inv.subtotal)}.`,
      expected: round2(lineSum),
      actual: inv.subtotal,
      expectedSource: 'calculated',
      actualSource: invNum,
      formula: `${fmt(inv.subtotal)} − ${fmt(lineSum)}`,
      financialImpact: round2(Math.max(0, inv.subtotal - lineSum)),
    });
  } else if (inv.subtotal != null && inv.taxAmount != null && inv.totalAmount != null && Math.abs(inv.subtotal + inv.taxAmount - inv.totalAmount) > amtTol) {
    const calc = inv.subtotal + inv.taxAmount;
    fail('TOTAL_ARITHMETIC', {
      severity: 'MED',
      field: 'totalAmount',
      description: `${fmt(inv.subtotal)} + ${fmt(inv.taxAmount)} tax = ${fmt(calc)}, but ${invNum} totals ${fmt(inv.totalAmount)}.`,
      expected: round2(calc),
      actual: inv.totalAmount,
      expectedSource: 'calculated',
      actualSource: invNum,
      formula: `${fmt(inv.totalAmount)} − ${fmt(calc)}`,
      financialImpact: round2(Math.max(0, inv.totalAmount - calc)),
    });
  } else if (inv.totalAmount == null) {
    skip('TOTAL_ARITHMETIC', 'Invoice total not found');
  }

  // ---- total vs PO value (catch-all for what item checks couldn't see) ----
  if (po && poEx.totalAmount != null && inv.totalAmount != null) {
    const over = inv.totalAmount - poEx.totalAmount;
    const alreadyExplained = flags.reduce((a, f) => a + (f.financialImpact || 0), 0);
    if (over > Math.max(amtTol, poEx.totalAmount * priceTol) && over - alreadyExplained > amtTol) {
      fail('TOTAL_OVER_PO', {
        severity: 'MED',
        field: 'totalAmount',
        description: `${invNum} totals ${fmt(inv.totalAmount)}, ${fmt(over)} more than ${poNum} (${fmt(poEx.totalAmount)}).`,
        expected: poEx.totalAmount,
        actual: inv.totalAmount,
        expectedSource: poNum,
        actualSource: invNum,
        formula: alreadyExplained > 0 ? `${fmt(over)} over, of which ${fmt(alreadyExplained)} is explained above` : `${fmt(inv.totalAmount)} − ${fmt(poEx.totalAmount)}`,
        financialImpact: round2(Math.max(0, over - alreadyExplained)),
      });
    }
  } else if (po) {
    skip('TOTAL_OVER_PO', 'Totals not found on both documents');
  }

  // ---- GSTIN ----
  const invGstin = inv.vendorGstin;
  if (invGstin) {
    const v = validateGSTIN(invGstin);
    if (!v.valid) {
      const itcAtRisk = inv.taxAmount ?? (inv.taxPercent && inv.subtotal ? (inv.taxPercent / 100) * inv.subtotal : 0);
      fail('GSTIN_INVALID', {
        severity: 'HIGH',
        field: 'vendorGstin',
        description: `Supplier GSTIN ${invGstin} on ${invNum} is not a valid GSTIN (${v.reason}). Input tax credit of ${fmt(itcAtRisk)} cannot be claimed on this invoice as printed.`,
        expected: 'valid GSTIN',
        actual: invGstin,
        actualSource: invNum,
        formula: `ITC at risk = GST on invoice = ${fmt(itcAtRisk)}`,
        financialImpact: round2(itcAtRisk),
      });
    }
    const registered = vendor?.gstin || po?.extracted?.vendorGstin;
    if (registered && registered.toUpperCase() !== invGstin.toUpperCase()) {
      fail('GSTIN_MISMATCH', {
        severity: 'HIGH',
        field: 'vendorGstin',
        description: `${invNum} carries GSTIN ${invGstin}, but this vendor is registered as ${registered}. Confirm the invoice really came from them.`,
        expected: registered,
        actual: invGstin,
        expectedSource: vendor?.gstin ? 'vendor record' : poNum,
        actualSource: invNum,
        financialImpact: 0,
      });
    }
  } else {
    skip('GSTIN_INVALID', 'No GSTIN printed on the invoice');
    skip('GSTIN_MISMATCH', 'No GSTIN printed on the invoice');
  }

  // ---- duplicates ----
  // Only invoices that arrived BEFORE this one count — the first copy is the original, never the duplicate
  const createdAt = invoice?.createdAt ? new Date(invoice.createdAt).getTime() : Date.now();
  const others = otherInvoices.filter((o) => String(o._id) !== String(invoice?._id) && (!o.createdAt || new Date(o.createdAt).getTime() < createdAt));
  const sameNumber = invoice?.docNumber && others.find((o) => o.docNumber && o.docNumber.toUpperCase().replace(/\W/g, '') === invoice.docNumber.toUpperCase().replace(/\W/g, ''));
  if (sameNumber) {
    fail('DUPLICATE_INVOICE', {
      severity: 'HIGH',
      field: 'docNumber',
      description: `Invoice number ${invoice.docNumber} was already received from this vendor on ${new Date(sameNumber.createdAt).toLocaleDateString('en-IN')}. Paying it again would be a duplicate payment.`,
      expected: 'unique invoice number',
      actual: invoice.docNumber,
      actualSource: invNum,
      formula: 'Full invoice value at risk',
      financialImpact: round2(inv.totalAmount || 0),
    });
  } else if (inv.totalAmount) {
    const created = invoice?.createdAt ? new Date(invoice.createdAt).getTime() : Date.now();
    const lookalike = others.find(
      (o) => o.extracted?.totalAmount && Math.abs(o.extracted.totalAmount - inv.totalAmount) <= 1 && Math.abs(new Date(o.createdAt).getTime() - created) <= dupWindow
    );
    if (lookalike) {
      fail('DUPLICATE_INVOICE', {
        severity: 'MED',
        field: 'totalAmount',
        description: `Same vendor, same amount (${fmt(inv.totalAmount)}) as invoice ${lookalike.docNumber || 'received'} on ${new Date(lookalike.createdAt).toLocaleDateString('en-IN')}, under a different number. Possible re-billing.`,
        expected: 'distinct invoice',
        actual: `${invoice.docNumber} ≈ ${lookalike.docNumber}`,
        actualSource: invNum,
        financialImpact: 0,
      });
    }
  }

  // A re-sent invoice shouldn't be paid at all, so its full value is the amount at stake.
  // Line-level differences on it would double count, so the duplicate flag stands alone.
  if (sameNumber) {
    const dup = flags.find((f) => f.code === 'DUPLICATE_INVOICE');
    flags.length = 0;
    flags.push(dup);
  }
  const checks = CHECKS.map(([code, label]) => ({ code, label, ...status[code] }));
  const totalFinancialImpact = round2(flags.reduce((a, f) => a + (f.financialImpact || 0), 0));
  return {
    checks,
    flags,
    totalFinancialImpact,
    checksRun: checks.filter((c) => c.status !== 'skip').length,
    checksPassed: checks.filter((c) => c.status === 'pass').length,
    hasIssues: flags.some((f) => f.severity !== 'LOW' || f.financialImpact > amtTol),
  };
}

module.exports = { runChecks, CHECKS, findItem, similarity };
