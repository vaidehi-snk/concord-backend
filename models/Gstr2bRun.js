const mongoose = require('mongoose');

// One upload of GSTR-2B (the GST portal's auto-drafted statement of input tax
// credit available to the buyer, built from what suppliers filed in GSTR-1).
const rowSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['matched', 'value_mismatch', 'missing_in_2b', 'not_in_books'] },
    supplierGstin: String,
    supplierName: String,
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
    invoiceNumber: String,
    invoiceDate: Date,
    document: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
    booksValue: Number,
    portalValue: Number,
    booksTax: Number,
    portalTax: Number,
    itcAtRisk: Number,
    note: String,
  },
  { _id: false }
);

const gstr2bRunSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    period: String, // MMYYYY
    periodStart: Date,
    periodEnd: Date,
    source: { type: String, enum: ['json', 'csv', 'demo'] },
    filename: String,
    uploadedBy: String,
    rows: [rowSchema],
    summary: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Gstr2bRun', gstr2bRunSchema);
