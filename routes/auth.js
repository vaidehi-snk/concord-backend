const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Company = require('../models/Company');
const User = require('../models/User');
const auth = require('../middleware/auth');
const activity = require('../services/activity');
const { cloneDemoWorkspace, cleanupOldDemos } = require('../services/demoSeed');
const { validateGSTIN } = require('../services/gstin');

const router = express.Router();

function signToken(user, expiresIn = '30d') {
  return jwt.sign({ userId: user._id, companyId: user.company, role: user.role }, process.env.JWT_SECRET, { expiresIn });
}

function session(user, company, token) {
  return {
    token,
    user: { id: user._id, name: user.name, email: user.email, role: user.role },
    company: { id: company._id, name: company.name, isDemo: !!company.isDemo, gstin: company.gstin, plan: company.plan, painPoints: company.painPoints || [] },
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', async (req, res) => {
  const { companyName, name, email, password, gstin, industry, teamSize, monthlyInvoices, accountingSoftware, painPoints } = req.body || {};
  if (!companyName || !name || !email || !password) return res.status(400).json({ error: 'Company name, your name, email and password are all required.' });
  if (!EMAIL.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (await User.findOne({ email: email.toLowerCase() })) return res.status(409).json({ error: 'An account with this email already exists. Log in instead.' });

  const g = gstin ? validateGSTIN(gstin) : null;
  if (gstin && !g.valid) return res.status(400).json({ error: `That GSTIN doesn’t look right: ${g.reason}.` });
  const PAINS = ['short_delivery', 'price_creep', 'gst_itc', 'msme', 'duplicates', 'vendor_followup', 'bank_fraud'];
  const company = await Company.create({
    name: companyName,
    email: email.toLowerCase(),
    passwordHash: 'unused',
    gstin: g?.gstin || undefined,
    state: g?.state,
    industry: industry ? String(industry).slice(0, 80) : undefined,
    teamSize: teamSize ? String(teamSize).slice(0, 20) : undefined,
    monthlyInvoices: monthlyInvoices ? String(monthlyInvoices).slice(0, 20) : undefined,
    accountingSoftware: accountingSoftware ? String(accountingSoftware).slice(0, 40) : undefined,
    painPoints: Array.isArray(painPoints) ? painPoints.filter((x) => PAINS.includes(x)) : [],
  });
  const user = await User.create({ company: company._id, name, email: email.toLowerCase(), passwordHash: await bcrypt.hash(password, 10), role: 'admin' });
  await activity.log(company._id, 'team', `${name} created the ${companyName} workspace`, { actorName: name });
  res.status(201).json(session(user, company, signToken(user)));
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'That email and password combination is not correct.' });
  const company = await Company.findById(user.company);
  res.json(session(user, company, signToken(user)));
});

// One click → a fully populated sample company. Lets anyone evaluate the
// product (investors, a review panel, a prospect) without uploading anything.
router.post('/demo', async (req, res) => {
  cleanupOldDemos().catch(() => {});
  const { company, user } = await cloneDemoWorkspace();
  // "Explore as" a manager or member to see what each role can do
  const role = ['manager', 'member'].includes(req.body?.role) ? req.body.role : 'admin';
  const who = role === 'admin' ? user : (await User.findOne({ company: company._id, role })) || user;
  res.status(201).json(session(who, company, signToken(who, '24h')));
});

router.get('/me', auth, async (req, res) => {
  const user = await User.findById(req.userId);
  const company = await Company.findById(req.companyId);
  if (!user || !company) return res.status(401).json({ error: 'Session no longer valid.' });
  res.json(session(user, company, undefined));
});

router.get('/team', auth, async (req, res) => {
  const users = await User.find({ company: req.companyId }).select('name email role createdAt').sort({ createdAt: 1 });
  res.json(users);
});

router.post('/invite', auth, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Only an admin can add team members.' });
  const { name, email, password, role = 'member' } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and a temporary password are required.' });
  if (!['admin', 'manager', 'member'].includes(role)) return res.status(400).json({ error: 'Role must be admin, manager or member.' });
  if (password.length < 8) return res.status(400).json({ error: 'Temporary password must be at least 8 characters.' });
  if (await User.findOne({ email: email.toLowerCase() })) return res.status(409).json({ error: 'An account with this email already exists.' });
  const user = await User.create({ company: req.companyId, name, email: email.toLowerCase(), passwordHash: await bcrypt.hash(password, 10), role });
  const inviter = await User.findById(req.userId);
  await activity.log(req.companyId, 'team', `${inviter?.name} added ${name} as ${role}`, { actorName: inviter?.name });
  res.status(201).json({ _id: user._id, name: user.name, email: user.email, role: user.role });
});

router.patch('/team/:id', auth, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Only an admin can change roles.' });
  const { role } = req.body || {};
  if (!['admin', 'manager', 'member'].includes(role)) return res.status(400).json({ error: 'Role must be admin, manager or member.' });
  if (String(req.params.id) === String(req.userId)) return res.status(400).json({ error: "You can't change your own role." });
  const user = await User.findOneAndUpdate({ _id: req.params.id, company: req.companyId }, { role }, { new: true }).select('name email role');
  if (!user) return res.status(404).json({ error: 'Team member not found.' });
  res.json(user);
});

// Change your own password
router.post('/change-password', auth, async (req, res) => {
  const { current, next } = req.body || {};
  if (!next || String(next).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  const user = await User.findById(req.userId);
  if (!user || !(await bcrypt.compare(String(current || ''), user.passwordHash))) return res.status(400).json({ error: 'Current password is not correct.' });
  user.passwordHash = await bcrypt.hash(String(next), 10);
  await user.save();
  res.json({ ok: true });
});

// Admin sets a temporary password for a teammate who forgot theirs
router.patch('/team/:id/password', auth, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Only an admin can reset passwords.' });
  const { password } = req.body || {};
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Temporary password must be at least 8 characters.' });
  const user = await User.findOne({ _id: req.params.id, company: req.companyId });
  if (!user) return res.status(404).json({ error: 'Team member not found.' });
  user.passwordHash = await bcrypt.hash(String(password), 10);
  await user.save();
  const admin = await User.findById(req.userId).select('name');
  await activity.log(req.companyId, 'team', `${admin?.name} reset the password for ${user.name}`, { actorName: admin?.name });
  res.json({ ok: true });
});

module.exports = router;
