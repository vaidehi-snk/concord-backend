require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const connectDB = require('./config/db');
const Company = require('./models/Company');
const User = require('./models/User');
const Vendor = require('./models/Vendor');

// Real auth now exists — you can just use the Register page instead of this
// script for a normal account. This is kept as a quick way to get a working
// login + a sample vendor for local testing without clicking through the UI.
// Run with: node seed.js
const DEMO_EMAIL = 'demo@concord.local';
const DEMO_PASSWORD = 'demopassword123';

async function seed() {
  await connectDB();

  let user = await User.findOne({ email: DEMO_EMAIL });
  let company;

  if (!user) {
    company = await Company.create({ name: 'Demo Company Pvt. Ltd.', email: DEMO_EMAIL, passwordHash: 'unused' });
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    user = await User.create({ company: company._id, name: 'Demo Admin', email: DEMO_EMAIL, passwordHash, role: 'admin' });
    console.log('Created demo account.');
  } else {
    company = await mongoose.model('Company').findById(user.company);
    console.log('Demo account already exists.');
  }

  let vendor = await Vendor.findOne({ company: company._id, name: 'Sample Vendor Pvt. Ltd.' });
  if (!vendor) {
    vendor = await Vendor.create({
      company: company._id,
      name: 'Sample Vendor Pvt. Ltd.',
      contactEmail: 'accounts@samplevendor.example',
    });
    console.log('Created a sample vendor.');
  }

  console.log('\nLog in at /login with:');
  console.log('  Email   :', DEMO_EMAIL);
  console.log('  Password:', DEMO_PASSWORD);

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
