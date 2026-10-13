const mongoose = require('mongoose');

// Every flag carries the evidence that produced it (expected vs actual and
// which document each came from), so "Explain this flag" and the audit trail
// never have to reverse-engineer a sentence.
const flagSchema = new mongoose.Schema(
  {
    code: { type: String }, // e.g. SHORT_DELIVERY, PRICE_MISMATCH, GSTIN_INVALID
    severity: { type: String, enum: ['HIGH', 'MED', 'LOW'], required: true },
    field: { type: String, required: true },
    item: { type: String },
    description: { type: String, required: true },
    expected: { type: mongoose.Schema.Types.Mixed },
    actual: { type: mongoose.Schema.Types.Mixed },
    expectedSource: { type: String },
    actualSource: { type: String },
    formula: { type: String },
    financialImpact: { type: Number, default: 0 },
  },
  { _id: false }
);

const threadEntrySchema = new mongoose.Schema(
  {
    direction: {
      type: String,
      enum: ['outbound_draft', 'outbound_sent', 'vendor_reply', 'approved', 'note', 'system'],
      required: true,
    },
    actorName: { type: String },
    body: { type: String, required: true },
    generatedBy: { type: String }, // 'llm' | 'template' — honest about where a draft came from
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const disputeSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    match: { type: mongoose.Schema.Types.ObjectId, ref: 'Match' },
    reference: { type: String }, // human-friendly id, e.g. DSP-0042

    po: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
    deliveryNote: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },

    flags: [flagSchema],
    totalFinancialImpact: { type: Number, default: 0 },
    recoveredAmount: { type: Number, default: 0 },
    priority: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },

    status: {
      type: String,
      enum: ['open', 'pending_approval', 'email_drafted', 'awaiting_vendor', 'resolved', 'dismissed'],
      default: 'open',
    },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolution: {
      outcome: { type: String, enum: ['credit_note', 'revised_invoice', 'short_payment', 'vendor_justified', 'written_off', 'other'] },
      note: { type: String },
      resolvedBy: { type: String },
      resolvedAt: { type: Date },
    },
    dueDate: { type: Date }, // SLA: when the vendor should have answered by

    thread: [threadEntrySchema],
    publicToken: { type: String, unique: true, sparse: true },
  },
  { timestamps: true }
);

disputeSchema.index({ company: 1, status: 1 });
disputeSchema.index({ vendor: 1 });

module.exports = mongoose.model('Dispute', disputeSchema);
