const mongoose = require('mongoose');

// A Match is one purchase, identified by its PO number, and whichever of its
// three documents have arrived so far. It exists from the moment the first
// document lands, so the matching board can show "Invoice in, waiting for the
// delivery challan" — and the touchless-rate metric (clean matches with no
// human involvement) is computed from these.
const matchSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
    matchKey: { type: String, required: true },
    poNumber: { type: String },
    po: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
    deliveryNote: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
    status: {
      type: String,
      enum: ['awaiting_documents', 'matched', 'disputed', 'needs_review'],
      default: 'awaiting_documents',
    },
    matchType: { type: String, enum: ['two_way', 'three_way'] },
    checksRun: { type: Number, default: 0 },
    checksPassed: { type: Number, default: 0 },
    invoiceTotal: { type: Number },
    dispute: { type: mongoose.Schema.Types.ObjectId, ref: 'Dispute' },
    matchedAt: { type: Date },
    touchless: { type: Boolean, default: false },
  },
  { timestamps: true }
);

matchSchema.index({ company: 1, matchKey: 1 }, { unique: true });
matchSchema.index({ company: 1, status: 1 });

module.exports = mongoose.model('Match', matchSchema);
