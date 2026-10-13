const mongoose = require('mongoose');

// Company-level tolerance rules. These are what make Concord usable on real
// data: a ₹0.40 rounding difference should never become a "dispute" that a
// human has to dismiss. Every check in services/checks.js reads from here.
const settingsSchema = new mongoose.Schema(
  {
    priceTolerancePct: { type: Number, default: 1 }, // ignore unit-price drift below this %
    qtyTolerancePct: { type: Number, default: 0 }, // goods: usually zero tolerance
    amountToleranceAbs: { type: Number, default: 5 }, // ₹ — rounding noise on totals
    autoApproveBelow: { type: Number, default: 0 }, // disputes under this ₹ skip manager approval (0 = always require)
    duplicateWindowDays: { type: Number, default: 45 },
    defaultPaymentTermsDays: { type: Number, default: 30 },
    // Autopilot: when a vendor is silent past the reply date, draft a firm follow-up automatically
    autopilotFollowUps: { type: Boolean, default: true },
  },
  { _id: false }
);

const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true }, // legacy, unused — auth lives on User
    gstin: { type: String },
    state: { type: String },
    industry: { type: String },
    // onboarding profile, used to tailor the first-run checklist
    teamSize: { type: String },
    monthlyInvoices: { type: String },
    accountingSoftware: { type: String },
    painPoints: [{ type: String }],
    settings: { type: settingsSchema, default: () => ({}) },
    isDemo: { type: Boolean, default: false },
    isDemoTemplate: { type: Boolean, default: false },
    plan: { type: String, enum: ['free', 'growth', 'scale'], default: 'free' },
    // Machine access: ERPs, scripts and email-forwarding services push documents with these.
    // Only a SHA-256 hash is stored; the key itself is shown once at creation.
    apiKeys: [
      {
        name: String,
        prefix: String,
        hash: { type: String, index: true },
        createdBy: String,
        createdAt: { type: Date, default: Date.now },
        lastUsedAt: Date,
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Company', companySchema);
