require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const auth = require('./middleware/auth');

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Refusing to start — tokens would be unsigned.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Render / Vercel sit behind a proxy
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
// CORS_ORIGINS: comma-separated origins; "*" wildcards allowed, e.g.
// https://concord-frontend-five.vercel.app,https://concord-frontend-*.vercel.app
// Unset = allow any origin. Safe here: auth is a bearer token, not a cookie.
const allowed = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean)
  .map((o) => new RegExp(`^${o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`, 'i'));
app.use(
  cors({
    origin: (origin, cb) => cb(null, !allowed.length || !origin || allowed.some((re) => re.test(origin))),
    exposedHeaders: ['Content-Disposition'],
  })
);
app.use(express.json({ limit: '1mb' }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: true, legacyHeaders: false });
const demoLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many demo workspaces from this network — try again in an hour.' } });

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'concord', time: new Date().toISOString() }));
app.use('/api/auth/demo', demoLimiter);
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/public/disputes', require('./routes/public'));
// machine intake (API key, not a login): ERPs, scripts, email forwarding
app.use('/api', require('./routes/ingest'));

app.use('/api/documents', auth, require('./routes/documents'));
app.use('/api/matches', auth, require('./routes/matches'));
app.use('/api/disputes', auth, require('./routes/disputes'));
app.use('/api/vendors', auth, require('./routes/vendors'));
app.use('/api/payments', auth, require('./routes/payments'));
app.use('/api/audit-trail', auth, require('./routes/auditTrail'));
app.use('/api/gst', auth, require('./routes/gst'));
app.use('/api/reports', auth, require('./routes/reports'));
app.use('/api', auth, require('./routes/insights'));

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));
// Express 5 forwards async errors here
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.name === 'CastError') return res.status(404).json({ error: 'Not found.' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is larger than 15 MB.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
});

const PORT = process.env.PORT || 5000;
if (require.main === module) {
  connectDB().then(() => {
    app.listen(PORT, () => console.log(`Concord API listening on ${PORT}`));
    require('./services/demoSeed').warmDemoTemplate();
    // Autopilot: chase silent vendors every hour
    const { runAutopilotEverywhere } = require('./services/autopilot');
    setInterval(() => runAutopilotEverywhere().catch((e) => console.warn('[autopilot]', e.message)), 60 * 60 * 1000).unref();
  });
}

module.exports = app;
