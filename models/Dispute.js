const mongoose = require('mongoose');

// A Dispute is created by the reconciliation engine (services/reconcile.js) whenever
// it finds a mismatch across a PO/DN/Invoice trio. This is the object the dashboard
// lists, the negotiation agent drafts emails against, and the risk scorecard aggregates.
const flagSchema = new mongoose.Schema(
  {
    severity: { type: String, enum: ['HIGH', 'MED', 'LOW'], required: true },
    field: { type: String, required: true }, // e.g. "quantity", "unitPrice", "taxPercent"
    description: { type: String, required: true },
    financialImpact: { type: Number, default: 0 },
  },
  { _id: false }
);

// One entry per email/reply in the negotiation thread — this is what Phase 8-9's
// "negotiation loop" appends to, instead of the dispute only ever having one draft.
const threadEntrySchema = new mongoose.Schema(
  {
    direction: { type: String, enum: ['outbound_draft', 'outbound_sent', 'vendor_reply'], required: true },
    body: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const disputeSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },

    po: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
    deliveryNote: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },

    flags: [flagSchema],
    totalFinancialImpact: { type: Number, default: 0 }, // sum of flags[].financialImpact, kept denormalized for sorting

    status: {
      type: String,
      enum: ['open', 'email_drafted', 'awaiting_vendor', 'resolved', 'dismissed'],
      default: 'open',
    },

    thread: [threadEntrySchema],
  },
  { timestamps: true }
);

disputeSchema.index({ company: 1, status: 1 });
disputeSchema.index({ vendor: 1 });

module.exports = mongoose.model('Dispute', disputeSchema);
