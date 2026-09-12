const mongoose = require('mongoose');

// One Document = one uploaded file (a PO, a Delivery Note, or an Invoice).
// extracted holds whatever the parsing pipeline (services/parseDocument.js) pulls out —
// it's intentionally loose (Mixed) in the MVP since real vendor documents won't all have
// the same fields, and locking this down early would break on the first weird invoice layout.
const documentSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },

    type: { type: String, enum: ['PO', 'DN', 'INVOICE'], required: true },
    docNumber: { type: String }, // e.g. "PO-4471", "INV-8823" — filled after parsing when found
    fileUrl: { type: String, required: true }, // path/URL to the stored original file
    originalFilename: { type: String },

    extracted: {
      quantity: { type: Number }, // kept for single-item documents / backward compatibility
      unitPrice: { type: Number },
      taxPercent: { type: Number },
      totalAmount: { type: Number },
      deliveredQuantity: { type: Number }, // relevant for DN docs only, single-item case
      // Real invoices usually have multiple items — this is what reconciliation
      // actually compares against when present. Added after discovering that
      // "the quantity" / "the unit price" as single flat fields is an
      // ambiguous, wrong question for any document with more than one line.
      lineItems: [
        {
          description: { type: String },
          quantity: { type: Number },
          unitPrice: { type: Number },
          total: { type: Number },
          _id: false,
        },
      ],
      raw: { type: mongoose.Schema.Types.Mixed }, // full raw parse output, for debugging bad extractions
    },

    parseStatus: {
      type: String,
      enum: ['pending', 'parsed', 'needs_review', 'failed'],
      default: 'pending',
    },
    parseConfidence: { type: Number }, // 0-1, from the parsing service — low confidence routes to needs_review
  },
  { timestamps: true }
);

documentSchema.index({ company: 1, docNumber: 1 });

module.exports = mongoose.model('Document', documentSchema);
