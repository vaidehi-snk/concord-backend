const Dispute = require('../models/Dispute');
const Company = require('../models/Company');
const { draft } = require('./negotiation');
const activity = require('./activity');

/**
 * Autopilot: chasing vendors is the part of AP nobody has time for. When a
 * vendor is silent past the reply date, Concord drafts a firmer follow-up and
 * puts it in the approval queue. A human still approves every email (unless it
 * is under the company's auto-approve threshold). Runs hourly and whenever the
 * overview is opened.
 */
const DOC_FIELDS = 'docNumber type extracted.totalAmount extracted.taxPercent extracted.lineItems';
const lastRun = new Map();

async function runAutopilot(companyId, { force = false } = {}) {
  const key = String(companyId);
  if (!force && Date.now() - (lastRun.get(key) || 0) < 10 * 60 * 1000) return 0;
  lastRun.set(key, Date.now());
  const company = await Company.findById(companyId).select('settings name isDemoTemplate');
  if (!company || company.isDemoTemplate || company.settings?.autopilotFollowUps === false) return 0;
  const overdue = await Dispute.find({ company: companyId, status: 'awaiting_vendor', dueDate: { $lt: new Date() } })
    .populate('vendor', 'name contactName contactEmail')
    .populate('po deliveryNote invoice', DOC_FIELDS)
    .populate('company', 'name gstin settings');
  let drafted = 0;
  for (const d of overdue) {
    const days = Math.max(1, Math.round((Date.now() - new Date(d.dueDate).getTime()) / 86400000));
    let body;
    let generatedBy;
    try {
      ({ body, generatedBy } = await draft(d, { tone: 'firm' }));
    } catch {
      continue;
    }
    d.thread.push({ direction: 'system', body: `Autopilot: no reply from ${d.vendor?.name} ${days} day${days > 1 ? 's' : ''} after the due date. A firmer follow-up has been drafted.`, actorName: 'Concord autopilot' });
    d.thread.push({ direction: 'outbound_draft', body, generatedBy, actorName: 'Concord autopilot' });
    const threshold = company.settings?.autoApproveBelow || 0;
    if (threshold > 0 && d.totalFinancialImpact < threshold) {
      d.thread.push({ direction: 'approved', body: `Auto-approved: amount is below the ₹${Math.round(threshold).toLocaleString('en-IN')} approval threshold.`, actorName: 'Concord' });
      d.status = 'email_drafted';
    } else d.status = 'pending_approval';
    await d.save();
    await activity.log(companyId, 'negotiation', `Autopilot drafted a follow-up on ${d.reference}: ${d.vendor?.name} is ${days} day${days > 1 ? 's' : ''} past the reply date`, { actorName: 'Concord autopilot', refType: 'Dispute', refId: d._id });
    drafted++;
  }
  return drafted;
}

async function runAutopilotEverywhere() {
  const ids = await Dispute.distinct('company', { status: 'awaiting_vendor', dueDate: { $lt: new Date() } });
  let n = 0;
  for (const id of ids) n += await runAutopilot(id).catch(() => 0);
  return n;
}

module.exports = { runAutopilot, runAutopilotEverywhere };
