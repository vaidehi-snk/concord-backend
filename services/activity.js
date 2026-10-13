const Activity = require('../models/Activity');

async function log(companyId, kind, message, extra = {}) {
  try {
    await Activity.create({ company: companyId, kind, message, ...extra });
  } catch (err) {
    console.warn('[activity] failed to log:', err.message);
  }
}

module.exports = { log };
