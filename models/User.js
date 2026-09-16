const mongoose = require('mongoose');

// A User belongs to exactly one Company and logs in individually. Roles exist
// specifically so approval workflows (next on the roadmap) have something
// real to check against — "manager" can approve a drafted email before it
// sends, "member" can upload and draft but not approve, "admin" can do both
// plus manage other users on the account.
const userSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'manager', 'member'], default: 'member' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
