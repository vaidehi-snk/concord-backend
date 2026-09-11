require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Company = require('./models/Company');
const Vendor = require('./models/Vendor');

// Auth isn't built yet (by design, per the MVP scope). This script creates one
// demo Company and Vendor so the frontend has real IDs to work against.
// Run with: node seed.js
async function seed() {
  await connectDB();

  let company = await Company.findOne({ email: 'demo@concord.local' });
  if (!company) {
    company = await Company.create({
      name: 'Demo Company Pvt. Ltd.',
      email: 'demo@concord.local',
      passwordHash: 'not-used-yet',
    });
    console.log('Created company:', company._id.toString());
  } else {
    console.log('Using existing company:', company._id.toString());
  }

  let vendor = await Vendor.findOne({ company: company._id, name: 'Sample Vendor Pvt. Ltd.' });
  if (!vendor) {
    vendor = await Vendor.create({
      company: company._id,
      name: 'Sample Vendor Pvt. Ltd.',
      contactEmail: 'accounts@samplevendor.example',
    });
    console.log('Created vendor:', vendor._id.toString());
  } else {
    console.log('Using existing vendor:', vendor._id.toString());
  }

  console.log('\nPaste these into the frontend Settings screen:');
  console.log('  Company ID:', company._id.toString());
  console.log('  Vendor ID :', vendor._id.toString());

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
