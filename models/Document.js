const mongoose = require('mongoose');

const lineItemSchema = new mongoose.Schema(
  {
    description: { type: String },
    sku: { type: String },
    hsn: { type: String },
    quantity: { type: Number },
    unit: { type: String },
    unitPrice: { type: Number },
    taxPercent: { type: Number },
    total: { type: Number },
  },
  { _id: false }
);

// One Document = one uploaded file (PO, Delivery Note / GRN / challan, or Invoice).
const documentSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    type: { type: String, enum: ['PO', 'DN', 'INVOICE'], required: true },
    typeSource: { type: String, enum: ['user', 'auto'], default: 'user' },
    docNumber: { type: String },
    // The PO number this document belongs to. For a PO it's its own number;
    // for a DN/Invoice it's the "Against PO" / "PO Ref" printed on it. This is
    // the key the matcher groups on — it's what makes zero-touch matching work.
    poReference: { type: String },
    matchKey: { type: String, index: true },
    docDate: { type: Date },
    dueDate: { type: Date },

    fileUrl: { type: String },
    originalFilename: { type: String },
    source: { type: String, enum: ['upload', 'email', 'demo', 'api'], default: 'upload' },

    extracted: {
      quantity: { type: Number },
      unitPrice: { type: Number },
      taxPercent: { type: Number },
      totalAmount: { type: Number },
      deliveredQuantity: { type: Number },
      subtotal: { type: Number },
      taxAmount: { type: Number },
      currency: { type: String },
      vendorName: { type: String },
      vendorGstin: { type: String },
      buyerGstin: { type: String },
      // payee bank details printed on the invoice (fraud check: did they change?)
      bankAccount: { type: String },
      ifsc: { type: String },
      lineItems: [lineItemSchema],
      raw: { type: mongoose.Schema.Types.Mixed },
    },

    extractionMethod: { type: String, enum: ['rules', 'llm', 'rules+llm', 'vision', 'manual', 'demo'], default: 'rules' },
    parseStatus: { type: String, enum: ['pending', 'parsed', 'needs_review', 'failed'], default: 'pending' },
    parseConfidence: { type: Number },
    match: { type: mongoose.Schema.Types.ObjectId, ref: 'Match' },
    paymentStatus: { type: String, enum: ['unpaid', 'partial', 'paid', 'overpaid'], default: 'unpaid' },
    amountPaid: { type: Number, default: 0 },
    // Payment blocked until someone verifies it by phone, e.g. the vendor's
    // bank account on this invoice differs from every earlier one.
    paymentHold: {
      reason: { type: String, enum: ['bank_change'] },
      detail: { type: String },
      createdAt: { type: Date },
      clearedBy: { type: String },
      clearedAt: { type: Date },
    },
  },
  { timestamps: true }
);

documentSchema.index({ company: 1, docNumber: 1 });
documentSchema.index({ company: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model('Document', documentSchema);
