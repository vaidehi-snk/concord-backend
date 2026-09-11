const mongoose = require('mongoose');

// Vendor = the supplier a company is disputing invoices with.
// riskScore fields are written by the Phase 8-9 scorecard job, not computed here.
const vendorSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true },
    contactEmail: { type: String },
    gstin: { type: String },

    // Rolling stats, updated whenever a dispute involving this vendor is created/resolved.
    // Kept denormalized on the vendor doc so the dashboard can list vendors sorted by risk
    // without aggregating the whole Disputes collection on every page load.
    stats: {
      totalDisputes: { type: Number, default: 0 },
      totalDisputedAmount: { type: Number, default: 0 },
      lastDisputeAt: { type: Date },
      riskScore: { type: Number, default: 0 }, // 0-100, higher = more disputes/history of issues
    },
  },
  { timestamps: true }
);

vendorSchema.index({ company: 1, name: 1 });

module.exports = mongoose.model('Vendor', vendorSchema);
