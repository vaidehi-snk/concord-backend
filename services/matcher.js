const crypto = require('crypto');
const Document = require('../models/Document');
const Match = require('../models/Match');
const Dispute = require('../models/Dispute');
const Company = require('../models/Company');
const Vendor = require('../models/Vendor');
const { extractDocument, normalizeKey } = require('./extract');
const { runChecks } = require('./checks');
const { resolveVendor, refreshVendorStats } = require('./vendors');
const { validateGSTIN } = require('./gstin');
const activity = require('./activity');
const { guardBankDetails } = require('./fraud');

const SLOT = { PO: 'po', DN: 'deliveryNote', INVOICE: 'invoice' };
const TYPE_LABEL = { PO: 'purchase order', DN: 'delivery challan', INVOICE: 'invoice' };
const fmt = (n) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`;

function priorityFor(impact, flags) {
  if (impact >= 10000 || flags.some((f) => ['DUPLICATE_INVOICE', 'GSTIN_INVALID', 'ITEM_NOT_ON_PO'].includes(f.code) && f.severity === 'HIGH')) return 'high';
  if (impact >= 1000) return 'medium';
  return 'low';
}

async function nextDisputeRef(companyId) {
  const count = await Dispute.countDocuments({ company: companyId });
  return `DSP-${String(count + 1).padStart(4, '0')}`;
}

/**
 * Upload pipeline: extract → classify → resolve vendor → store → attach to the
 * purchase it belongs to → re-run checks on that purchase.
 */
async function ingestDocument({ companyId, userId, actorName, buffer, filename, typeHint, source = 'upload' }) {
  const result = await extractDocument(buffer, { type: typeHint });
  if (!result.ok) {
    const doc = await Document.create({
      company: companyId,
      uploadedBy: userId,
      type: typeHint || 'INVOICE',
      typeSource: typeHint ? 'user' : 'auto',
      originalFilename: filename,
      source,
      parseStatus: 'failed',
      parseConfidence: 0,
      extracted: { raw: result.error },
    });
    await activity.log(companyId, 'document', `${filename} could not be read: ${result.error}`, { actorName, refType: 'Document', refId: doc._id });
    return { document: doc, error: result.error };
  }

  const f = result.fields;
  const { vendor, created } = await resolveVendor(companyId, { name: f.vendorName, gstin: f.vendorGstin });
  const matchKey = normalizeKey(result.type === 'PO' ? f.docNumber || f.poReference : f.poReference);

  const doc = await Document.create({
    company: companyId,
    vendor: vendor?._id,
    uploadedBy: userId,
    type: result.type,
    typeSource: typeHint ? 'user' : 'auto',
    docNumber: f.docNumber,
    poReference: f.poReference,
    matchKey,
    docDate: f.docDate || undefined,
    dueDate: f.dueDate || undefined,
    originalFilename: filename,
    source,
    extracted: { ...f, raw: result.text.slice(0, 4000) },
    extractionMethod: result.method,
    parseStatus: result.parseStatus,
    parseConfidence: result.confidence,
  });

  if (vendor) await Vendor.updateOne({ _id: vendor._id }, { $inc: { 'stats.documentsProcessed': 1 } });
  await activity.log(
    companyId,
    'document',
    `${TYPE_LABEL[doc.type][0].toUpperCase() + TYPE_LABEL[doc.type].slice(1)} ${doc.docNumber || filename} read${vendor ? ` from ${vendor.name}` : ''}${created ? ' (new vendor added)' : ''}`,
    { actorName, refType: 'Document', refId: doc._id }
  );

  const hold = await guardBankDetails(doc, vendor?._id, { actorName });
  const outcome = matchKey ? await attachToMatch(doc, { actorName }) : { match: null, dispute: null };
  return { document: doc, vendor, vendorCreated: created, hold, ...outcome };
}

async function attachToMatch(doc, { actorName } = {}) {
  if (!doc.matchKey) return { match: null, dispute: null };
  let match = await Match.findOne({ company: doc.company, matchKey: doc.matchKey });
  if (!match) {
    match = await Match.create({
      company: doc.company,
      matchKey: doc.matchKey,
      poNumber: doc.type === 'PO' ? doc.docNumber : doc.poReference,
      vendor: doc.vendor,
    });
  }
  match[SLOT[doc.type]] = doc._id;
  if (!match.vendor && doc.vendor) match.vendor = doc.vendor;
  if (doc.type === 'PO' && doc.docNumber) match.poNumber = doc.docNumber;
  await match.save();
  doc.match = match._id;
  await doc.save();
  return evaluateMatch(match._id, { actorName });
}

/**
 * Run the rulebook on whatever documents this purchase has. Opens, updates or
 * closes the dispute accordingly. Safe to call repeatedly (e.g. when the
 * challan arrives after the invoice, or after settings change).
 */
async function evaluateMatch(matchId, { actorName } = {}) {
  const match = await Match.findById(matchId).populate('po deliveryNote invoice');
  if (!match) return { match: null, dispute: null };
  const company = await Company.findById(match.company);
  const settings = company?.settings || {};

  if (!match.invoice || !match.po) {
    match.status = 'awaiting_documents';
    await match.save();
    return { match, dispute: null };
  }

  const vendor = match.vendor ? await Vendor.findById(match.vendor) : null;
  const otherInvoices = vendor
    ? await Document.find({ company: match.company, vendor: vendor._id, type: 'INVOICE', _id: { $ne: match.invoice._id } }).select('docNumber extracted.totalAmount createdAt')
    : [];

  const result = runChecks({ po: match.po, dn: match.deliveryNote, invoice: match.invoice, settings, vendor, otherInvoices });
  match.checksRun = result.checksRun;
  match.checksPassed = result.checksPassed;
  match.invoiceTotal = match.invoice.extracted?.totalAmount;
  match.matchType = match.deliveryNote ? 'three_way' : 'two_way';

  let dispute = match.dispute ? await Dispute.findById(match.dispute) : null;
  const closed = dispute && ['resolved', 'dismissed'].includes(dispute.status);

  if (result.hasIssues) {
    match.status = 'disputed';
    if (!dispute) {
      dispute = await Dispute.create({
        company: match.company,
        vendor: match.vendor || match.invoice.vendor,
        match: match._id,
        reference: await nextDisputeRef(match.company),
        po: match.po._id,
        deliveryNote: match.deliveryNote?._id,
        invoice: match.invoice._id,
        flags: result.flags,
        totalFinancialImpact: result.totalFinancialImpact,
        priority: priorityFor(result.totalFinancialImpact, result.flags),
        status: 'open',
        dueDate: new Date(Date.now() + 7 * 86400000),
        publicToken: crypto.randomBytes(24).toString('hex'),
        thread: [
          {
            direction: 'system',
            body: `Concord ran ${result.checksRun} checks on ${match.poNumber}: ${result.flags.length} issue(s) found, ${fmt(result.totalFinancialImpact)} at stake.`,
          },
        ],
      });
      match.dispute = dispute._id;
      await activity.log(match.company, 'dispute', `${dispute.reference} opened on ${match.poNumber}: ${result.flags.length} issue(s), ${fmt(result.totalFinancialImpact)} at stake`, {
        actorName: 'Concord',
        amount: result.totalFinancialImpact,
        refType: 'Dispute',
        refId: dispute._id,
      });
    } else if (!closed) {
      const before = dispute.totalFinancialImpact;
      dispute.flags = result.flags;
      dispute.totalFinancialImpact = result.totalFinancialImpact;
      dispute.priority = priorityFor(result.totalFinancialImpact, result.flags);
      dispute.deliveryNote = match.deliveryNote?._id;
      if (Math.abs(before - result.totalFinancialImpact) > 0.5) {
        dispute.thread.push({ direction: 'system', body: `Re-checked after new documents arrived: now ${result.flags.length} issue(s), ${fmt(result.totalFinancialImpact)} at stake (was ${fmt(before)}).` });
      }
      await dispute.save();
    }
  } else {
    if (dispute && !closed && dispute.status === 'open') {
      dispute.status = 'dismissed';
      dispute.resolution = { outcome: 'other', note: 'All checks passed after updated documents arrived.', resolvedBy: 'Concord', resolvedAt: new Date() };
      dispute.thread.push({ direction: 'system', body: 'All checks now pass — closed automatically.' });
      await dispute.save();
    }
    // Goods without a challan aren't verified yet: hold until it arrives (or a human releases it)
    if (!match.deliveryNote) {
      match.status = 'awaiting_documents';
    } else {
      const firstTime = match.status !== 'matched';
      match.status = 'matched';
      match.matchedAt = match.matchedAt || new Date();
      match.touchless = !dispute;
      if (firstTime) {
        await activity.log(match.company, 'match', `${match.poNumber} matched cleanly — ${result.checksPassed}/${result.checksRun} checks passed, ${fmt(match.invoiceTotal)} cleared for payment`, {
          actorName: 'Concord',
          amount: match.invoiceTotal,
          refType: 'Match',
          refId: match._id,
        });
      }
    }
  }
  await match.save();
  if (match.vendor) await refreshVendorStats(match.vendor);
  return { match, dispute, checks: result.checks, result };
}

async function recheckCompany(companyId) {
  const matches = await Match.find({ company: companyId, status: { $in: ['awaiting_documents', 'disputed', 'needs_review'] } }).select('_id');
  for (const m of matches) await evaluateMatch(m._id);
  return matches.length;
}

module.exports = { ingestDocument, attachToMatch, evaluateMatch, recheckCompany, validateGSTIN };
