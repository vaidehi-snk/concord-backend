/**
 * Line-item-aware reconciliation. Earlier versions compared a single flat
 * "quantity"/"unitPrice" per document, which is an ambiguous, often-wrong
 * question for any real invoice with more than one item on it — there's no
 * single right answer to "what's the quantity" when a PO has both 10 chairs
 * and 5 mice. This version matches items between documents by description
 * and compares them individually, the way real reconciliation actually works.
 *
 * Falls back to the old flat-field comparison when a document has no
 * lineItems (e.g. regex-only extraction on a simple single-item document).
 */

function normalize(desc) {
  return (desc || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function findMatch(item, list) {
  const norm = normalize(item.description);
  return list.find((i) => normalize(i.description) === norm);
}

function compareLineItems(poItems, invoiceItems) {
  const flags = [];

  poItems.forEach((poItem) => {
    const invItem = findMatch(poItem, invoiceItems);
    if (!invItem) {
      flags.push({
        severity: 'MED',
        field: 'lineItem',
        description: `"${poItem.description}" appears on the PO but not on the Invoice.`,
        financialImpact: 0,
      });
      return;
    }
    if (poItem.quantity != null && invItem.quantity != null && poItem.quantity !== invItem.quantity) {
      const diff = invItem.quantity - poItem.quantity;
      const impact = Math.abs(diff) * (invItem.unitPrice || poItem.unitPrice || 0);
      flags.push({
        severity: Math.abs(diff / poItem.quantity) > 0.1 ? 'HIGH' : 'MED',
        field: 'quantity',
        description: `"${poItem.description}": PO ordered ${poItem.quantity}, Invoice bills for ${invItem.quantity}.`,
        financialImpact: impact,
      });
    }
    if (poItem.unitPrice != null && invItem.unitPrice != null && poItem.unitPrice !== invItem.unitPrice) {
      const diff = invItem.unitPrice - poItem.unitPrice;
      const impact = Math.abs(diff) * (invItem.quantity || poItem.quantity || 1);
      flags.push({
        severity: Math.abs(diff / poItem.unitPrice) > 0.1 ? 'HIGH' : 'MED',
        field: 'unitPrice',
        description: `"${poItem.description}": PO price ₹${poItem.unitPrice}, Invoice price ₹${invItem.unitPrice}.`,
        financialImpact: impact,
      });
    }
  });

  invoiceItems.forEach((invItem) => {
    if (!findMatch(invItem, poItems)) {
      flags.push({
        severity: 'HIGH',
        field: 'lineItem',
        description: `"${invItem.description}" is billed on the Invoice but does not appear on the PO.`,
        financialImpact: invItem.total || 0,
      });
    }
  });

  return flags;
}

function compareDeliveryPerItem(invoiceItems, dnItems) {
  const flags = [];
  let uncheckedCount = 0;

  invoiceItems.forEach((invItem) => {
    const dnItem = findMatch(invItem, dnItems);
    const delivered = dnItem?.quantity;
    const billed = invItem.quantity;
    if (delivered == null || billed == null) {
      // Previously this silently returned — meaning a Delivery Note that
      // failed to parse produced NO signal at all, which is what caused a
      // real dispute (a 6-unit shortfall) to be reported as "all match."
      // A check that couldn't run must say so, not go quiet.
      uncheckedCount++;
      return;
    }
    if (delivered !== billed) {
      const shortfall = billed - delivered;
      const impact = Math.abs(shortfall) * (invItem.unitPrice || 0);
      flags.push({
        severity: shortfall > 0 ? 'HIGH' : 'LOW',
        field: 'deliveredQuantity',
        description: `"${invItem.description}": Invoice bills for ${billed}, Delivery Note confirms ${delivered} received.`,
        financialImpact: impact,
      });
    }
  });

  // If every item's delivery check was unverifiable (the DN didn't parse
  // usefully at all), say so explicitly rather than reporting a clean match.
  if (uncheckedCount > 0 && uncheckedCount === invoiceItems.length) {
    flags.push({
      severity: 'MED',
      field: 'deliveredQuantity',
      description: `Could not verify delivered quantities — the Delivery Note did not parse with usable item data. This is not confirmation that delivery matches the invoice.`,
      financialImpact: 0,
    });
  }

  return flags;
}

// Old single-value comparison — kept as a fallback for documents that only
// have flat fields (no lineItems), so simple single-item documents still work.
function compareFlatFields(po, deliveryNote, invoice) {
  const flags = [];
  const uncheckedFields = [];
  const FIELD_LABELS = { quantity: 'Quantity', unitPrice: 'Unit Price', taxPercent: 'Tax %' };

  ['quantity', 'unitPrice', 'taxPercent'].forEach((field) => {
    const poVal = po.extracted[field];
    const invVal = invoice.extracted[field];
    if (poVal == null || invVal == null) {
      uncheckedFields.push(field);
      return;
    }
    if (poVal === invVal) return;
    const pctDiff = poVal !== 0 ? Math.abs(invVal - poVal) / poVal : 1;
    flags.push({
      severity: pctDiff > 0.1 ? 'HIGH' : pctDiff > 0.02 ? 'MED' : 'LOW',
      field,
      description: `${FIELD_LABELS[field]} mismatch: PO has ${poVal}, Invoice has ${invVal}.`,
      financialImpact: 0,
    });
  });

  const delivered = deliveryNote.extracted.deliveredQuantity ?? deliveryNote.extracted.quantity;
  const billed = invoice.extracted.quantity;
  if (delivered == null || billed == null) {
    uncheckedFields.push('deliveredQuantity');
  } else if (delivered !== billed) {
    const shortfall = billed - delivered;
    const unitPrice = invoice.extracted.unitPrice || 0;
    flags.push({
      severity: shortfall > 0 ? 'HIGH' : 'LOW',
      field: 'deliveredQuantity',
      description: `Invoice bills for ${billed} units but Delivery Note confirms only ${delivered} received.`,
      financialImpact: Math.abs(shortfall * unitPrice),
    });
  }

  const qty = invoice.extracted.quantity || 1;
  flags.forEach((f) => {
    if (f.financialImpact === 0 && f.field === 'unitPrice') {
      const diff = (invoice.extracted.unitPrice || 0) - (po.extracted.unitPrice || 0);
      f.financialImpact = Math.abs(diff * qty);
    }
  });

  return { flags, uncheckedFields };
}

function reconcile({ po, deliveryNote, invoice }) {
  const poItems = po.extracted.lineItems || [];
  const invItems = invoice.extracted.lineItems || [];
  const dnItems = deliveryNote.extracted.lineItems || [];

  let flags;
  let insufficientData;

  if (poItems.length > 0 && invItems.length > 0) {
    // Line-item path — the real fix.
    flags = [...compareLineItems(poItems, invItems), ...compareDeliveryPerItem(invItems, dnItems)];
    insufficientData = false;
  } else {
    // Fallback path for simple single-item documents with no lineItems extracted.
    const result = compareFlatFields(po, deliveryNote, invoice);
    flags = result.flags;
    insufficientData = result.uncheckedFields.length >= 4;
  }

  const totalFinancialImpact = flags.reduce((sum, f) => sum + (f.financialImpact || 0), 0);

  return {
    flags,
    totalFinancialImpact,
    hasDispute: flags.length > 0,
    insufficientData,
    uncheckedFields: [],
  };
}

module.exports = { reconcile };
