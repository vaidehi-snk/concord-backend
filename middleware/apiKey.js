const crypto = require('crypto');
const Company = require('../models/Company');

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

// Machine-to-machine auth for ERPs, scripts and email-forwarding webhooks.
// Key comes from the X-API-Key header (or ?key= for webhook services that can't set headers).
async function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || !/^cnc_live_[a-f0-9]{32}$/.test(key)) return res.status(401).json({ error: 'Missing or malformed API key.' });
  const hash = hashKey(key);
  const company = await Company.findOne({ 'apiKeys.hash': hash }).select('apiKeys name');
  if (!company) return res.status(401).json({ error: 'Unknown API key.' });
  const entry = company.apiKeys.find((k) => k.hash === hash);
  entry.lastUsedAt = new Date();
  await company.save();
  req.companyId = company._id;
  req.role = 'member';
  req.apiKeyName = entry?.name || 'API key';
  next();
}

function newKey() {
  const key = `cnc_live_${crypto.randomBytes(16).toString('hex')}`;
  return { key, hash: hashKey(key), prefix: key.slice(0, 13) };
}

module.exports = { apiKeyAuth, newKey, hashKey };
