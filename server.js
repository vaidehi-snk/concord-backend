require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const connectDB = require('./config/db');

// multer needs this directory to exist before any upload request. On Render's
// free tier the filesystem is ephemeral (wiped on restart/redeploy), but that's
// fine here — files are parsed synchronously right after upload and only the
// extracted data is kept in MongoDB, not the raw file itself long-term.
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const documentsRouter = require('./routes/documents');
const disputesRouter = require('./routes/disputes');
const negotiateRouter = require('./routes/negotiate');
const vendorsRouter = require('./routes/vendors');
const publicRouter = require('./routes/public');
const authRouter = require('./routes/auth');
const auditTrailRouter = require('./routes/auditTrail');
const auth = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRouter);

// Everything below requires a valid token — companyId/vendorId now come from
// the authenticated user (req.companyId), not from whatever the client sends.
app.use('/api/documents', auth, documentsRouter);
app.use('/api/disputes', auth, disputesRouter);
app.use('/api/negotiate', auth, negotiateRouter);
app.use('/api/vendors', auth, vendorsRouter);
app.use('/api/audit-trail', auth, auditTrailRouter);

// The vendor-facing response link is intentionally public — a vendor has no
// Concord account, so it can't require a token. Access is instead controlled
// by the unguessable per-dispute token in the URL itself.
app.use('/api/public/disputes', publicRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, () => console.log(`Concord backend running on port ${PORT}`));
});
