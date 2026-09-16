const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Company = require('../models/Company');
const User = require('../models/User');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { userId: user._id, companyId: user.company, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// POST /api/auth/register
// Creates a new Company AND its first User in one step — that first user is
// always 'admin', since someone has to be able to invite/manage the rest of
// the team. Body: { companyName, name, email, password }
router.post('/register', async (req, res) => {
  try {
    const { companyName, name, email, password } = req.body;
    if (!companyName || !name || !email || !password) {
      return res.status(400).json({ error: 'companyName, name, email, and password are all required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const company = await Company.create({
      name: companyName,
      email: email.toLowerCase(),
      passwordHash: 'unused-see-user-model', // Company itself no longer holds a password — kept only for schema back-compat
    });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      company: company._id,
      name,
      email: email.toLowerCase(),
      passwordHash,
      role: 'admin',
    });

    const token = signToken(user);
    res.status(201).json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
      company: { id: company._id, name: company.name },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const user = await User.findOne({ email: email.toLowerCase() }).populate('company', 'name');
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signToken(user);
    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
      company: { id: user.company._id, name: user.company.name },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/invite — an existing admin adds a teammate to the same company.
// Requires the inviter's token (checked via the auth middleware in server.js).
router.post('/invite', require('../middleware/auth'), async (req, res) => {
  try {
    if (req.role !== 'admin') return res.status(403).json({ error: 'Only an admin can add team members' });

    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required' });
    if (!['admin', 'manager', 'member'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      company: req.companyId,
      name,
      email: email.toLowerCase(),
      passwordHash,
      role: role || 'member',
    });

    res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add team member' });
  }
});

module.exports = router;
