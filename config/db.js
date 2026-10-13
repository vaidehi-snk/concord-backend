const mongoose = require('mongoose');

// Never log the full connection string — it contains the database password,
// and Render's logs are visible to anyone with dashboard access.
function redact(uri) {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
}

async function connectDB(uriOverride) {
  const uri = uriOverride || process.env.MONGO_URI || 'mongodb://localhost:27017/concord';
  try {
    await mongoose.connect(uri);
    console.log('MongoDB connected:', redact(uri));
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

module.exports = connectDB;
