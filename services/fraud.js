const Vendor = require('../models/Vendor');
const Document = require('../models/Document');
const activity = require('./activity');

/**
 * Bank-detail change guard.
 *
 * The most expensive invoice fraud in India isn't overbilling — it's a genuine-
 * looking invoice (or a "please note our new bank account" email) that sends
 * the payment to someone else's account. Concord remembers every payee account
 * each vendor has used. A new one puts that invoice on hold until a person
 * confirms it by calling the vendor on a number they already had — never by
 * replying to the email that announced the change.
 */
const mask = (a) => (a ? `••••${String(a).slice(-4)}` : '');
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

async function guardBankDetails(doc, vendorId, { actorName } = {}) {
  const account = doc.extracted?.bankAccount;
  if (doc.type !== 'INVOICE' || !account || !vendorId) return null;
  const vendor = await Vendor.findById(vendorId);
  if (!vendor) return null;
  const ifsc = doc.extracted?.ifsc || null;
  const known = vendor.bankAccounts || [];
  const hit = known.find((b) => b.account === account);

  if (!known.length) {
    // First account we've ever seen for this vendor becomes the baseline
    vendor.bankAccounts.push({ account, ifsc, status: 'trusted', firstSeenAt: new Date(), firstSeenDoc: doc.docNumber });
    await vendor.save();
    return null;
  }
  if (hit && hit.status === 'trusted') return null;

  if (!hit) vendor.bankAccounts.push({ account, ifsc, status: 'unverified', firstSeenAt: new Date(), firstSeenDoc: doc.docNumber });
  await vendor.save();
  const trusted = known.find((b) => b.status === 'trusted');
  const badIfsc = ifsc && !IFSC.test(ifsc);
  doc.paymentHold = {
    reason: 'bank_change',
    detail: `Invoice ${doc.docNumber || ''} asks for payment to account ${mask(account)}${ifsc ? ` (${ifsc})` : ''}, but ${vendor.name} has always been paid to ${mask(trusted?.account)}${trusted?.ifsc ? ` (${trusted.ifsc})` : ''}.${badIfsc ? ' The IFSC code is also malformed.' : ''} Call the vendor on a number you already have before paying.`,
    createdAt: new Date(),
  };
  await doc.save();
  await activity.log(doc.company, 'vendor', `Payment held: ${vendor.name}'s bank account changed on ${doc.docNumber || 'an invoice'} (${mask(trusted?.account)} → ${mask(account)})`, {
    actorName: actorName || 'Concord',
    refType: 'Document',
    refId: doc._id,
  });
  return doc.paymentHold;
}

// After a phone call: trust the new account (releases every hold on it) or reject it
async function decideAccount(companyId, vendorId, account, decision, actorName) {
  const vendor = await Vendor.findOne({ _id: vendorId, company: companyId });
  if (!vendor) throw Object.assign(new Error('Vendor not found.'), { status: 404 });
  const entry = vendor.bankAccounts.find((b) => b.account === account);
  if (!entry) throw Object.assign(new Error('That account is not on file for this vendor.'), { status: 404 });
  entry.status = decision === 'trust' ? 'trusted' : 'rejected';
  entry.verifiedBy = actorName;
  entry.verifiedAt = new Date();
  await vendor.save();
  let released = 0;
  if (decision === 'trust') {
    const r = await Document.updateMany(
      { company: companyId, vendor: vendorId, 'extracted.bankAccount': account, 'paymentHold.reason': 'bank_change', 'paymentHold.clearedAt': null },
      { $set: { 'paymentHold.clearedBy': actorName, 'paymentHold.clearedAt': new Date() } }
    );
    released = r.modifiedCount || 0;
  }
  await activity.log(companyId, 'vendor', `${actorName} ${decision === 'trust' ? 'verified' : 'rejected'} ${vendor.name}'s account ${mask(account)}${released ? `; ${released} invoice(s) released` : ''}`, { actorName });
  return { vendor, released };
}

const isHeld = (doc) => doc?.paymentHold?.reason && !doc.paymentHold.clearedAt;

module.exports = { guardBankDetails, decideAccount, isHeld, mask };
