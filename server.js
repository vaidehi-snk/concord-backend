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

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/documents', documentsRouter);
app.use('/api/disputes', disputesRouter);
app.use('/api/negotiate', negotiateRouter);
app.use('/api/vendors', vendorsRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, () => console.log(`Concord backend running on port ${PORT}`));
});
