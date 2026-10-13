const mongoose = require('mongoose');

const vendorSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true },
    // Other spellings seen on documents ("Meridian Comp. Pvt Ltd", "MERIDIAN
    // COMPONENTS") so the inbox can attach new documents to the right vendor.
    aliases: [{ type: String }],
    contactName: { type: String },
    contactEmail: { type: String },
    phone: { type: String },
    gstin: { type: String },
    gstinValid: { type: Boolean },
    paymentTermsDays: { type: Number },
    // MSME (Udyam-registered) suppliers must be paid within 45 days of
    // acceptance (15 if no written agreement) — Income Tax Act §43B(h).
    // Paying late makes the expense non-deductible for the buyer that year.
    msme: { type: Boolean, default: false },
    udyamNumber: { type: String },
    msmeCategory: { type: String, enum: ['micro', 'small', 'medium'] },
    hasWrittenAgreement: { type: Boolean, default: true },

    // Every payee account seen on this vendor's invoices. The first one is the
    // baseline; a new one puts the invoice on hold until verified by phone.
    bankAccounts: [
      {
        account: String,
        ifsc: String,
        status: { type: String, enum: ['trusted', 'unverified', 'rejected'], default: 'unverified' },
        firstSeenAt: Date,
        firstSeenDoc: String,
        verifiedBy: String,
        verifiedAt: Date,
      },
    ],

    stats: {
      totalDisputes: { type: Number, default: 0 },
      totalDisputedAmount: { type: Number, default: 0 },
      recoveredAmount: { type: Number, default: 0 },
      documentsProcessed: { type: Number, default: 0 },
      cleanMatches: { type: Number, default: 0 },
      lastDisputeAt: { type: Date },
      riskScore: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

vendorSchema.index({ company: 1, name: 1 });

module.exports = mongoose.model('Vendor', vendorSchema);
