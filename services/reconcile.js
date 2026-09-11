/**
 * This is the same comparison logic proven in the Concord-demo.html prototype,
 * ported to run on real Document records instead of hardcoded scenario objects.
 * Given a PO, Delivery Note, and Invoice (all Document instances for the same order),
 * returns the flags array to store on a Dispute.
 */

const FIELD_LABELS = {
  quantity: 'Quantity',
  unitPrice: 'Unit Price',
  taxPercent: 'Tax %',
};

// Fields this function could not compare because one or both sides failed to
// parse — tracked separately from "compared and matched", so the caller can
// tell the difference between "verified fine" and "couldn't actually check".
function compareField(field, po, invoice, uncheckedFields) {
  const poVal = po.extracted[field];
  const invVal = invoice.extracted[field];
  if (poVal == null || invVal == null) {
    uncheckedFields.push(field);
    return null;
  }
  if (poVal === invVal) return null;

  const pctDiff = poVal !== 0 ? Math.abs(invVal - poVal) / poVal : 1;
  const severity = pctDiff > 0.1 ? 'HIGH' : pctDiff > 0.02 ? 'MED' : 'LOW';

  return {
    severity,
    field,
    description: `${FIELD_LABELS[field]} mismatch: PO has ${poVal}, Invoice has ${invVal}.`,
    financialImpact: 0, // filled in below once we know which field this is
  };
}

function reconcile({ po, deliveryNote, invoice }) {
  const flags = [];
  const uncheckedFields = [];

  ['quantity', 'unitPrice', 'taxPercent'].forEach((field) => {
    const flag = compareField(field, po, invoice, uncheckedFields);
    if (flag) flags.push(flag);
  });

  // Delivered-quantity-vs-billed-quantity is the highest-value check — this is
  // the "partial shipment billed in full" scenario from the demo.
  const delivered = deliveryNote.extracted.deliveredQuantity ?? deliveryNote.extracted.quantity;
  const billed = invoice.extracted.quantity;
  if (delivered == null || billed == null) {
    uncheckedFields.push('deliveredQuantity');
  } else if (delivered !== billed) {
    const shortfall = billed - delivered;
    const unitPrice = invoice.extracted.unitPrice || 0;
    const impact = shortfall * unitPrice;
    flags.push({
      severity: shortfall > 0 ? 'HIGH' : 'LOW',
      field: 'deliveredQuantity',
      description: `Invoice bills for ${billed} units but Delivery Note confirms only ${delivered} received — ${Math.abs(
        shortfall
      )}-unit ${shortfall > 0 ? 'shortfall' : 'overage'}.`,
      financialImpact: Math.abs(impact),
    });
  }

  // Fill in financialImpact for the field-mismatch flags now that we know quantity.
  const qty = invoice.extracted.quantity || 1;
  flags.forEach((f) => {
    if (f.financialImpact === 0 && f.field === 'unitPrice') {
      const diff = (invoice.extracted.unitPrice || 0) - (po.extracted.unitPrice || 0);
      f.financialImpact = Math.abs(diff * qty);
    }
  });

  const totalFinancialImpact = flags.reduce((sum, f) => sum + (f.financialImpact || 0), 0);

  // A field only counts as "verified matching" if it was actually compared.
  // If everything meaningful was unchecked (e.g. extraction failed on both
  // sides), this is NOT the same as "all documents match" — the caller needs
  // to know reconciliation couldn't really be performed.
  const totalFieldsConsidered = 4; // quantity, unitPrice, taxPercent, deliveredQuantity
  const allFieldsUnchecked = uncheckedFields.length >= totalFieldsConsidered;

  return {
    flags,
    totalFinancialImpact,
    hasDispute: flags.length > 0,
    uncheckedFields,
    insufficientData: allFieldsUnchecked,
  };
}

module.exports = { reconcile };
