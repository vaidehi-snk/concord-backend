const mongoose = require('mongoose');

// One row from an uploaded bank / UPI statement, and what Concord concluded
// about it. This is the fourth leg of the match: did the money that actually
// left the account equal the invoice total minus any credit we won?
const paymentSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    batchId: { type: String, index: true },
    date: { type: Date },
    rawDate: { type: String },
    description: { type: String },
    reference: { type: String },
    amount: { type: Number, required: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
    expectedAmount: { type: Number },
    status: {
      type: String,
      enum: ['matched', 'underpaid', 'overpaid', 'duplicate_payment', 'unmatched'],
      required: true,
    },
    matchedBy: { type: String, enum: ['invoice_number', 'amount', 'vendor_amount', 'none'] },
    difference: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payment', paymentSchema);
