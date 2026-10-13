const express = require('express');
const Activity = require('../models/Activity');
const Company = require('../models/Company');
const User = require('../models/User');
const { overview } = require('../services/analytics');
const { ask } = require('../services/copilot');
const { recheckCompany } = require('../services/matcher');
const activity = require('../services/activity');
const llm = require('../services/llm');
const { newKey } = require('../middleware/apiKey');
const { runAutopilot } = require('../services/autopilot');

const router = express.Router();

router.get('/overview', async (req, res) => {
  await runAutopilot(req.companyId).catch(() => 0);
  res.json(await overview(req.companyId, { weeks: Number(req.query.weeks) || 10 }));
});

router.get('/activity', async (req, res) => {
  const items = await Activity.find({ company: req.companyId }).sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit) || 40, 200));
  res.json(items);
});

router.post('/ask', async (req, res) => {
  const q = String(req.body?.question || '').trim();
  if (!q) return res.status(400).json({ error: 'Ask a question first.' });
  res.json(await ask(req.companyId, q.slice(0, 500), Array.isArray(req.body?.history) ? req.body.history : []));
});

router.get('/settings', async (req, res) => {
  const c = await Company.findById(req.companyId);
  res.json({
    company: { name: c.name, gstin: c.gstin, state: c.state, industry: c.industry, plan: c.plan, isDemo: c.isDemo },
    settings: c.settings,
    ai: { configured: llm.isConfigured() },
    apiKeys: (c.apiKeys || []).map((k) => ({ name: k.name, prefix: k.prefix, createdBy: k.createdBy, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })),
  });
});

router.put('/settings', async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Only an admin can change company settings.' });
  const c = await Company.findById(req.companyId);
  const { company = {}, settings = {} } = req.body || {};
  for (const k of ['name', 'gstin', 'state', 'industry']) if (company[k] !== undefined) c[k] = company[k];
  if (typeof settings.autopilotFollowUps === 'boolean') c.settings.autopilotFollowUps = settings.autopilotFollowUps;
  for (const k of ['priceTolerancePct', 'qtyTolerancePct', 'amountToleranceAbs', 'autoApproveBelow', 'duplicateWindowDays', 'defaultPaymentTermsDays']) {
    if (settings[k] !== undefined && Number.isFinite(Number(settings[k])) && Number(settings[k]) >= 0) c.settings[k] = Number(settings[k]);
  }
  await c.save();
  const u = await User.findById(req.userId).select('name');
  await activity.log(req.companyId, 'settings', `${u?.name} updated matching rules`, { actorName: u?.name });
  // Rules changed → re-run every unresolved purchase against the new rules
  const rechecked = await recheckCompany(req.companyId);
  res.json({ settings: c.settings, rechecked });
});

// API keys for ERPs, scripts and email forwarding. The full key is returned once.
router.post('/settings/api-keys', async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Only an admin can create API keys.' });
  const name = String(req.body?.name || '').trim().slice(0, 60) || 'Unnamed key';
  const c = await Company.findById(req.companyId);
  if ((c.apiKeys || []).length >= 10) return res.status(400).json({ error: 'Up to 10 keys per workspace. Revoke one first.' });
  const u = await User.findById(req.userId).select('name');
  const { key, hash, prefix } = newKey();
  c.apiKeys.push({ name, prefix, hash, createdBy: u?.name });
  await c.save();
  await activity.log(req.companyId, 'settings', `${u?.name} created API key “${name}”`, { actorName: u?.name });
  res.status(201).json({ key, name, prefix });
});

router.delete('/settings/api-keys/:prefix', async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Only an admin can revoke API keys.' });
  const c = await Company.findById(req.companyId);
  const before = c.apiKeys.length;
  c.apiKeys = c.apiKeys.filter((k) => k.prefix !== req.params.prefix);
  if (c.apiKeys.length === before) return res.status(404).json({ error: 'Key not found.' });
  await c.save();
  res.json({ ok: true });
});

module.exports = router;
