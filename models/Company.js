const mongoose = require('mongoose');

// Company = the business using Concord (single-tenant for MVP, but modeled
// as multi-tenant from day one so Phase 4's vendor portal doesn't need a schema rewrite)
const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    gstin: { type: String }, // useful later for GST-aware reconciliation
  },
  { timestamps: true }
);

module.exports = mongoose.model('Company', companySchema);
