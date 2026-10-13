const mongoose = require('mongoose');

// A company-wide event log. Powers the activity feed and doubles as the raw
// material for "what happened this week" summaries.
const activitySchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    actorName: { type: String },
    kind: {
      type: String,
      enum: ['document', 'match', 'dispute', 'negotiation', 'approval', 'vendor', 'payment', 'settings', 'team'],
      required: true,
    },
    message: { type: String, required: true },
    amount: { type: Number },
    refType: { type: String },
    refId: { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

activitySchema.index({ company: 1, createdAt: -1 });

module.exports = mongoose.model('Activity', activitySchema);
