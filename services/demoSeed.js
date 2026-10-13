const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Company = require('../models/Company');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const Document = require('../models/Document');
const Match = require('../models/Match');
const Dispute = require('../models/Dispute');
const Payment = require('../models/Payment');
const Activity = require('../models/Activity');
const { makeGSTIN, validateGSTIN } = require('./gstin');
const { normalizeKey } = require('./extract');
const { evaluateMatch } = require('./matcher');
const { reconcileStatement } = require('./payments');
const { refreshVendorStats } = require('./vendors');
const { templateDraft } = require('./negotiation');
const { guardBankDetails } = require('./fraud');
const { reconcile2B, sample2B } = require('./gstr2b');
const { runAutopilot } = require('./autopilot');
const Gstr2bRun = require('../models/Gstr2bRun');

/**
 * Builds a realistic, fully populated demo workspace: an auto-components
 * manufacturer in Pune with six suppliers and ~9 weeks of purchases.
 *
 * Only the *documents* are scripted. Every flag, amount and dispute comes
 * from running the real rules engine over them — exactly what would happen
 * if these PDFs had been uploaded.
 */

function rng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const VENDORS = [
  {
    key: 'ganesh', bank: ['50200031448812', 'HDFC0001234'], name: 'Shree Ganesh Engineering Works Pvt. Ltd.', state: '27', pan: 'AAKCS4821M', contact: 'Mahesh Joshi', email: 'accounts@shreeganeshengg.in',
    items: [['MS Bracket 40x40 Zinc plated', '7326', 48], ['Mounting Plate 3mm CRCA', '7326', 135], ['Spacer Bush 12mm', '7318', 9.5]],
  },
  {
    key: 'deccan', bank: ['912020044871236', 'UTIB0000412'], name: 'Deccan Steel Traders', state: '27', pan: 'AAFFD2290Q', contact: 'Irfan Shaikh', email: 'billing@deccansteel.co.in',
    items: [['CR Steel Sheet 1.2mm', '7209', 3150], ['HR Coil Strip 2mm', '7208', 2840], ['GI Sheet 0.8mm', '7210', 2475]],
  },
  {
    key: 'kaveri', bank: ['30881100014472', 'CNRB0002641'], msme: 'small', terms: 45, name: 'Kaveri Polymers LLP', state: '29', pan: 'AAOFK7718D', contact: 'Lakshmi Rao', email: 'ar@kaveripolymers.com',
    items: [['EPDM Gasket 65mm', '4016', 22], ['Nitrile O-Ring 25mm', '4016', 4.2], ['PU Grommet 10mm', '3926', 6.8]],
  },
  {
    key: 'omsai', bank: ['37719042218', 'SBIN0011493'], msme: 'micro', terms: 30, name: 'Om Sai Packaging & Logistics', state: '27', pan: 'ABOPS6610K', contact: 'Sunil Patil', email: 'omsaipack@gmail.com',
    items: [['5-Ply Corrugated Box 600x400', '4819', 58], ['Stretch Film Roll 23mic', '3920', 310], ['Wooden Pallet 1200x1000', '4415', 940]],
  },
  {
    key: 'precision', bank: ['004405501887', 'ICIC0000044'], name: 'Precision Fasteners India Pvt. Ltd.', state: '24', pan: 'AAGCP3305H', contact: 'Hetal Shah', email: 'accounts@precisionfasteners.in',
    items: [['Hex Bolt M10x50 Gr 8.8', '7318', 6.5], ['Nyloc Nut M10', '7318', 2.1], ['Spring Washer M10', '7318', 0.6]],
  },
  {
    key: 'vardhman', bank: ['1611002200018841', 'PUNB0161100'], msme: 'micro', agreement: false, name: 'Vardhman Electricals', state: '27', pan: 'AAJFV9042R', contact: 'Amit Jain', email: 'vardhman.elec@yahoo.co.in',
    items: [['FR Copper Cable 2.5 sqmm (90m)', '8544', 2650], ['MCB 32A DP', '8536', 465], ['Cable Tie 300mm (pkt)', '3926', 85]],
  },
];

// One row per purchase: [vendorKey, daysAgo, scenario]
const PURCHASES = [
  ['precision', 62, 'clean'], ['kaveri', 60, 'clean'], ['deccan', 58, 'short'], ['ganesh', 55, 'clean'],
  ['omsai', 53, 'clean'], ['precision', 50, 'clean'], ['kaveri', 47, 'clean'], ['ganesh', 45, 'extra_item'],
  ['deccan', 42, 'clean'], ['omsai', 40, 'price'], ['vardhman', 38, 'clean'], ['precision', 35, 'clean'],
  ['kaveri', 33, 'clean'], ['deccan', 30, 'short'], ['ganesh', 27, 'clean'], ['precision', 25, 'clean'],
  ['omsai', 22, 'price'], ['kaveri', 20, 'clean'], ['vardhman', 17, 'bad_gstin'], ['precision', 15, 'clean'],
  ['ganesh', 13, 'tax'], ['deccan', 11, 'duplicate'], ['kaveri', 9, 'clean'], ['precision', 7, 'clean'],
  ['omsai', 5, 'clean'], ['deccan', 4, 'short'], ['ganesh', 3, 'clean'], ['kaveri', 2, 'awaiting_dn'],
  ['precision', 1, 'po_only'],
];

// What happened to each dispute after it was raised (in order of creation)
const DISPUTE_STORY = [
  { status: 'resolved', outcome: 'credit_note', recover: 1, reply: 'Apologies — our dispatch was split and the balance sheets went on the next truck by mistake. We have issued credit note CN/24-25/118 for the shortfall.' },
  { status: 'resolved', outcome: 'revised_invoice', recover: 1, reply: 'The spacer bushes were sent as samples and should not have been billed. Revised invoice attached.' },
  { status: 'resolved', outcome: 'credit_note', recover: 0.6, reply: 'Our new rate card applied from this month but we accept the PO rate for this order. Credit note issued for the difference on the delivered quantity only.' },
  { status: 'dismissed', outcome: 'vendor_justified', recover: 0, reply: 'Attached signed proof of delivery for the full quantity, received by your stores (Mr. Kale) on the 14th.' },
  { status: 'awaiting_vendor', overdue: true },
  { status: 'awaiting_vendor', dueIn: 4 },
  { status: 'email_drafted' },
  { status: 'resolved', outcome: 'credit_note', recover: 1, reply: 'Confirmed duplicate — please ignore the second copy, it was re-sent by our billing software.' },
  { status: 'open' },
];

const day = 86400000;

async function rawUpdate(Model, id, set) {
  await Model.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(id)) }, { $set: set });
}

async function createDemoWorkspace() {
  const seed = Date.now();
  const rand = rng(seed);
  const tag = crypto.randomBytes(3).toString('hex');
  const now = Date.now();

  const company = await Company.create({
    name: 'Sahyadri Auto Components Pvt. Ltd.',
    email: `demo-${tag}@concord.demo`,
    passwordHash: 'unused',
    gstin: makeGSTIN('27', 'AADCS7731P'),
    state: 'Maharashtra',
    industry: 'Auto components manufacturing',
    isDemo: true,
    settings: { priceTolerancePct: 1, qtyTolerancePct: 0, amountToleranceAbs: 5, autoApproveBelow: 2000, duplicateWindowDays: 45 },
  });
  const pass = await bcrypt.hash(crypto.randomBytes(12).toString('hex'), 8);
  const admin = await User.create({ company: company._id, name: 'Priya Deshpande', email: `priya-${tag}@concord.demo`, passwordHash: pass, role: 'admin' });
  await User.create({ company: company._id, name: 'Ananya Kulkarni', email: `ananya-${tag}@concord.demo`, passwordHash: pass, role: 'manager' });
  await User.create({ company: company._id, name: 'Rohit Deshmukh', email: `rohit-${tag}@concord.demo`, passwordHash: pass, role: 'member' });

  const vendorDocs = {};
  for (const v of VENDORS) {
    const gstin = makeGSTIN(v.state, v.pan);
    vendorDocs[v.key] = await Vendor.create({
      company: company._id,
      name: v.name,
      contactName: v.contact,
      contactEmail: v.email,
      gstin,
      gstinValid: validateGSTIN(gstin).valid,
      paymentTermsDays: v.terms || 30,
      bankAccounts: [{ account: v.bank[0], ifsc: v.bank[1], status: 'trusted', firstSeenAt: new Date(now - 70 * day), firstSeenDoc: 'vendor master' }],
      ...(v.msme ? { msme: true, msmeCategory: v.msme, udyamNumber: `UDYAM-${v.state === '27' ? 'MH' : 'KR'}-26-00${Math.floor(10000 + rand() * 89999)}`, hasWrittenAgreement: v.agreement !== false } : {}),
    });
  }

  let poSeq = 4101;
  let invSeq = { ganesh: 1180, deccan: 2214, kaveri: 731, omsai: 3302, precision: 5520, vardhman: 412 };
  let dcSeq = 8800;
  const disputeIds = [];
  const createdDocs = [];
  let lastDeccanInvoice = null;

  for (const [vkey, daysAgo, scenario] of PURCHASES) {
    const v = VENDORS.find((x) => x.key === vkey);
    const vendor = vendorDocs[vkey];
    const at = new Date(now - daysAgo * day - Math.floor(rand() * 6) * 3600000);
    const nItems = 2 + Math.floor(rand() * 2);
    const items = v.items.slice(0, nItems).map(([description, hsn, rate]) => {
      const base = rate > 1000 ? 4 + Math.floor(rand() * 10) : rate > 100 ? 20 + Math.floor(rand() * 60) : 100 * (2 + Math.floor(rand() * 18));
      return { description, hsn, quantity: base, unitPrice: rate, taxPercent: 18, total: Math.round(base * rate * 100) / 100 };
    });
    const taxPct = 18;
    const poNumber = `PO-${poSeq++}`;
    const sum = (arr) => Math.round(arr.reduce((a, i) => a + i.total, 0) * 100) / 100;

    const dnItems = items.map((i) => ({ description: i.description, quantity: i.quantity }));
    let invItems = items.map((i) => ({ ...i }));
    let invGstin = vendor.gstin;
    let invTax = taxPct;
    let invNumber = `${vkey.slice(0, 3).toUpperCase()}/${invSeq[vkey]++}`;

    if (scenario === 'short') dnItems[0].quantity = Math.max(1, Math.round(items[0].quantity * (0.7 + rand() * 0.15)));
    if (scenario === 'price') {
      invItems[0].unitPrice = Math.round(items[0].unitPrice * 1.12 * 100) / 100;
      invItems[0].total = Math.round(invItems[0].unitPrice * invItems[0].quantity * 100) / 100;
    }
    if (scenario === 'extra_item') {
      const extra = { description: v.items[2][0], hsn: v.items[2][1], quantity: 400, unitPrice: v.items[2][2], taxPercent: 18 };
      extra.total = Math.round(extra.quantity * extra.unitPrice * 100) / 100;
      if (!items.find((i) => i.description === extra.description)) invItems.push(extra);
      else invItems[invItems.length - 1].quantity += 400;
    }
    if (scenario === 'tax') invTax = 28;
    if (scenario === 'bad_gstin') invGstin = vendor.gstin.slice(0, 14) + (vendor.gstin[14] === '7' ? '8' : '7');
    if (scenario === 'duplicate' && lastDeccanInvoice) {
      invNumber = lastDeccanInvoice.number;
      invItems = lastDeccanInvoice.items.map((i) => ({ ...i }));
    }

    const poSub = sum(items);
    const invSub = sum(invItems);
    const mk = async (type, docNumber, extracted, offsetDays) => {
      const created = new Date(at.getTime() + offsetDays * day);
      const doc = await Document.create({
        company: company._id,
        vendor: vendor._id,
        uploadedBy: admin._id,
        type,
        typeSource: 'auto',
        docNumber,
        poReference: poNumber,
        matchKey: normalizeKey(poNumber),
        docDate: created,
        dueDate: type === 'INVOICE' ? new Date(created.getTime() + 30 * day) : undefined,
        originalFilename: `${docNumber.replace(/\//g, '-')}.pdf`,
        source: 'demo',
        extracted: { vendorName: vendor.name, currency: 'INR', ...extracted },
        extractionMethod: 'demo',
        parseStatus: 'parsed',
        parseConfidence: 0.92 + rand() * 0.08,
      });
      await rawUpdate(Document, doc._id, { createdAt: created, updatedAt: created });
      doc.createdAt = created;
      createdDocs.push(doc);
      return doc;
    };

    const po = await mk('PO', poNumber, { lineItems: items, taxPercent: taxPct, subtotal: poSub, taxAmount: Math.round(poSub * 0.18 * 100) / 100, totalAmount: Math.round(poSub * 1.18 * 100) / 100, vendorGstin: vendor.gstin }, 0);
    let dn = null;
    let invoice = null;
    if (scenario !== 'po_only' && scenario !== 'awaiting_dn') {
      dn = await mk('DN', `DC-${dcSeq++}`, { lineItems: dnItems, vendorGstin: vendor.gstin }, 2);
    }
    if (scenario !== 'po_only') {
      const tax = Math.round(invSub * (invTax / 100) * 100) / 100;
      invoice = await mk('INVOICE', invNumber, { lineItems: invItems.map((i) => ({ ...i, taxPercent: invTax })), taxPercent: invTax, subtotal: invSub, taxAmount: tax, totalAmount: Math.round((invSub + tax) * 100) / 100, vendorGstin: invGstin, bankAccount: v.bank[0], ifsc: v.bank[1] }, 3);
      if (vkey === 'deccan' && scenario !== 'duplicate') lastDeccanInvoice = { number: invNumber, items: invItems };
    }

    const match = await Match.create({ company: company._id, vendor: vendor._id, matchKey: normalizeKey(poNumber), poNumber, po: po._id, deliveryNote: dn?._id, invoice: invoice?._id });
    for (const d of [po, dn, invoice].filter(Boolean)) await rawUpdate(Document, d._id, { match: match._id });
    const { match: evaluated, dispute } = await evaluateMatch(match._id, { actorName: 'Concord' });
    const evalAt = new Date(at.getTime() + 3 * day + 2 * 3600000);
    await rawUpdate(Match, match._id, { createdAt: at, updatedAt: evalAt, ...(evaluated.matchedAt ? { matchedAt: evalAt } : {}) });
    if (dispute) {
      disputeIds.push({ id: dispute._id, at: evalAt });
    }
  }

  // Play out what happened on each dispute
  for (let i = 0; i < disputeIds.length; i++) {
    const story = DISPUTE_STORY[i % DISPUTE_STORY.length];
    const { id, at } = disputeIds[i];
    const d = await Dispute.findById(id).populate('vendor', 'name').populate('po deliveryNote invoice', 'docNumber extracted').populate('company', 'name gstin');
    const thread = [{ direction: 'system', body: d.thread[0]?.body, createdAt: at }];
    const draftAt = new Date(at.getTime() + 3 * 3600000);
    const set = { createdAt: at, dueDate: new Date(at.getTime() + 7 * day) };

    if (story.status !== 'open') {
      thread.push({ direction: 'outbound_draft', body: templateDraft(d, 'collaborative'), generatedBy: 'template', createdAt: draftAt });
    }
    if (['resolved', 'dismissed', 'awaiting_vendor', 'email_drafted'].includes(story.status)) {
      thread.push({ direction: 'approved', body: 'Draft approved and released to the vendor.', actorName: 'Ananya Kulkarni', createdAt: new Date(draftAt.getTime() + 2 * 3600000) });
    }
    if (['resolved', 'dismissed', 'awaiting_vendor'].includes(story.status)) {
      thread.push({ direction: 'outbound_sent', body: `Sent to ${d.vendor.name} (${VENDORS.find((v) => v.name === d.vendor.name)?.email}).`, actorName: 'Priya Deshpande', createdAt: new Date(draftAt.getTime() + 3 * 3600000) });
    }
    if (story.reply) {
      const replyAt = new Date(at.getTime() + (2 + Math.floor(rand() * 3)) * day);
      thread.push({ direction: 'vendor_reply', body: story.reply, createdAt: replyAt });
      const recovered = Math.round(d.totalFinancialImpact * story.recover * 100) / 100;
      set.recoveredAmount = recovered;
      set.resolution = {
        outcome: story.outcome,
        note: story.outcome === 'vendor_justified' ? 'Vendor provided signed proof of delivery; our receiving record was wrong.' : `Vendor agreed. ₹${recovered.toLocaleString('en-IN')} recovered.`,
        resolvedBy: 'Concord negotiation agent',
        resolvedAt: new Date(replyAt.getTime() + 3600000),
      };
      thread.push({ direction: 'system', body: story.status === 'resolved' ? `Resolved — ₹${recovered.toLocaleString('en-IN')} recovered via ${story.outcome.replace('_', ' ')}.` : 'Closed — vendor justified the discrepancy.', createdAt: new Date(replyAt.getTime() + 3600000) });
    }
    if (story.overdue) set.dueDate = new Date(Date.now() - 2 * day);
    if (story.dueIn) set.dueDate = new Date(Date.now() + story.dueIn * day);
    set.status = story.status;
    set.thread = thread;
    set.updatedAt = thread[thread.length - 1].createdAt;
    await Dispute.collection.updateOne({ _id: d._id }, { $set: set });
    if (story.status === 'dismissed' && d.match) {
      await Match.collection.updateOne({ _id: d.match }, { $set: { status: d.deliveryNote ? 'matched' : 'awaiting_documents', touchless: false } });
    }
  }

  // A bank statement export: pays most clean invoices, pays one twice, short-pays a resolved one correctly
  const matched = await Match.find({ company: company._id, status: { $in: ['matched', 'disputed'] } }).populate('invoice').populate('vendor', 'name');
  const rows = ['Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.'];
  let k = 0;
  const resolvedDisputes = await Dispute.find({ company: company._id, status: 'resolved' }).select('invoice recoveredAmount');
  for (const m of matched) {
    if (!m.invoice || k > 16) continue;
    const inv = m.invoice;
    const rec = resolvedDisputes.find((d) => String(d.invoice) === String(inv._id));
    if (m.status === 'disputed' && !rec) continue; // held — not paid while disputed
    const amount = Math.round((inv.extracted.totalAmount - (rec?.recoveredAmount || 0)) * 100) / 100;
    const dt = new Date(inv.createdAt.getTime() + 20 * day);
    if (dt > new Date()) continue;
    const d = `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`;
    rows.push(`${d},NEFT-${m.vendor.name.toUpperCase().slice(0, 18)}-${inv.docNumber},N${2600000 + k},${amount.toFixed(2)},`);
    if (k === 4) rows.push(`${d},IMPS-${m.vendor.name.toUpperCase().slice(0, 18)}-PAYMENT,N${2650000 + k},${amount.toFixed(2)},`); // paid twice
    k++;
  }
  rows.push(`28/09/2026,UPI-CANTEEN SUPPLIES-PUNE,U9918822,3450.00,`);
  await reconcileStatement(company._id, rows.join('\n'), { actorName: 'Priya Deshpande' });
  await Payment.collection.updateMany({ company: company._id }, { $set: { createdAt: new Date(now - 6 * day) } });

  // Rebuild a coherent, backdated activity feed
  await Activity.deleteMany({ company: company._id });
  const feed = [];
  const allMatches = await Match.find({ company: company._id }).populate('vendor', 'name');
  const allDisputes = await Dispute.find({ company: company._id }).populate('vendor', 'name');
  for (const m of allMatches) {
    if (m.status === 'matched') feed.push({ kind: 'match', actorName: 'Concord', message: `${m.poNumber} from ${m.vendor?.name} matched cleanly — ${m.checksPassed}/${m.checksRun} checks passed, ₹${Math.round(m.invoiceTotal).toLocaleString('en-IN')} cleared for payment`, amount: m.invoiceTotal, refType: 'Match', refId: m._id, createdAt: m.matchedAt || m.updatedAt });
    if (m.status === 'awaiting_documents') feed.push({ kind: 'document', actorName: 'Concord', message: `${m.poNumber}: waiting for ${m.invoice ? 'the delivery challan' : 'the invoice'} from ${m.vendor?.name}`, refType: 'Match', refId: m._id, createdAt: m.updatedAt });
  }
  for (const d of allDisputes) {
    feed.push({ kind: 'dispute', actorName: 'Concord', message: `${d.reference} opened — ${d.vendor?.name}: ${d.flags[0]?.description}`, amount: d.totalFinancialImpact, refType: 'Dispute', refId: d._id, createdAt: d.createdAt });
    for (const t of d.thread) {
      if (t.direction === 'approved') feed.push({ kind: 'approval', actorName: t.actorName, message: `${t.actorName} approved the settlement email for ${d.reference}`, refType: 'Dispute', refId: d._id, createdAt: t.createdAt });
      if (t.direction === 'vendor_reply') feed.push({ kind: 'negotiation', actorName: d.vendor?.name, message: `${d.vendor?.name} replied on ${d.reference}`, refType: 'Dispute', refId: d._id, createdAt: t.createdAt });
    }
    if (d.status === 'resolved') feed.push({ kind: 'dispute', actorName: 'Concord', message: `${d.reference} resolved — ₹${Math.round(d.recoveredAmount).toLocaleString('en-IN')} recovered from ${d.vendor?.name}`, amount: d.recoveredAmount, refType: 'Dispute', refId: d._id, createdAt: d.resolution?.resolvedAt || d.updatedAt });
  }
  feed.push({ kind: 'payment', actorName: 'Priya Deshpande', message: 'HDFC current account statement reconciled — 1 duplicate payment caught', createdAt: new Date(now - 6 * day) });
  await Activity.collection.insertMany(feed.map((f) => ({ ...f, company: company._id, updatedAt: f.createdAt })));

  // Invoice fraud attempt: Precision's latest invoice asks to be paid into a new account
  const precisionInvoice = await Document.findOne({ company: company._id, vendor: vendorDocs.precision._id, type: 'INVOICE' }).sort({ createdAt: -1 });
  if (precisionInvoice) {
    precisionInvoice.extracted.bankAccount = '918020077145530';
    precisionInvoice.extracted.ifsc = 'YESB0000771';
    await precisionInvoice.save();
    await guardBankDetails(precisionInvoice, vendorDocs.precision._id, { actorName: 'Concord' });
  }

  // GSTR-2B for the period: one supplier hasn't filed, one filed a lower value
  await reconcile2B(company._id, { text: JSON.stringify(await sample2B(company._id)), filename: 'GSTR2B_27AADCS7731P_demo.json', actorName: 'Priya Deshpande', source: 'demo' });

  for (const v of Object.values(vendorDocs)) await refreshVendorStats(v._id);
  // Autopilot chases the vendor who went quiet
  await runAutopilot(company._id, { force: true });
  return { company, user: admin };
}

/**
 * Fast path for "Try the live demo": building the workspace runs ~400 queries,
 * which is fine locally but slow across Render → Atlas. So we build it once
 * as a template (refreshed daily) and give each visitor a private copy made
 * with one bulk read + one bulk insert per collection. Every ObjectId is
 * remapped and every date is shifted forward by the template's age, so the
 * copy looks freshly generated.
 */
const COLLECTIONS = [Company, User, Vendor, Document, Match, Dispute, Payment, Activity, Gstr2bRun];
let templatePromise = null;

async function getTemplate() {
  const fresh = await Company.findOne({ isDemoTemplate: true, createdAt: { $gt: new Date(Date.now() - 20 * 3600000) } }).sort({ createdAt: -1 });
  if (fresh) return fresh;
  if (!templatePromise) {
    templatePromise = (async () => {
      const { company } = await createDemoWorkspace();
      await rawUpdate(Company, company._id, { isDemoTemplate: true });
      return Company.findById(company._id);
    })().finally(() => {
      templatePromise = null;
    });
  }
  return templatePromise;
}

function remap(value, ids, shiftMs) {
  if (value instanceof mongoose.Types.ObjectId) return ids.get(String(value)) || value;
  if (value instanceof Date) return new Date(value.getTime() + shiftMs);
  if (Array.isArray(value)) return value.map((v) => remap(v, ids, shiftMs));
  if (value && typeof value === 'object' && !(value instanceof Buffer)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = remap(v, ids, shiftMs);
    return out;
  }
  return value;
}

async function cloneDemoWorkspace() {
  const template = await getTemplate();
  const shiftMs = Date.now() - new Date(template.createdAt).getTime();
  const tag = crypto.randomBytes(3).toString('hex');
  const all = {};
  for (const M of COLLECTIONS) {
    const filter = M === Company ? { _id: template._id } : { company: template._id };
    all[M.modelName] = await M.collection.find(filter).toArray();
  }
  const ids = new Map();
  for (const docs of Object.values(all)) for (const d of docs) ids.set(String(d._id), new mongoose.Types.ObjectId());

  for (const M of COLLECTIONS) {
    const docs = all[M.modelName].map((d) => {
      const c = remap(d, ids, shiftMs);
      if (M === Company) Object.assign(c, { email: `demo-${tag}@concord.demo`, isDemoTemplate: false, isDemo: true });
      if (M === User) c.email = c.email.replace(/-[a-f0-9]{6}@/, `-${tag}@`);
      if (M === Dispute) c.publicToken = crypto.randomBytes(24).toString('hex');
      return c;
    });
    if (docs.length) await M.collection.insertMany(docs, { ordered: false });
  }
  const companyId = ids.get(String(template._id));
  const company = await Company.findById(companyId);
  const user = await User.findOne({ company: companyId, role: 'admin' });
  return { company, user };
}

// Warm the template at boot so the first visitor doesn't wait for it.
function warmDemoTemplate() {
  getTemplate().catch((err) => console.warn('[demo] template warm-up failed:', err.message));
}

// Demo workspaces are disposable: remove ones (and stale templates) older than 24 hours.
async function cleanupOldDemos() {
  const cutoff = new Date(Date.now() - day);
  const old = await Company.find({ isDemo: true, createdAt: { $lt: cutoff } }).select('_id');
  if (!old.length) return 0;
  const ids = old.map((c) => c._id);
  await Promise.all([User, Vendor, Document, Match, Dispute, Payment, Activity, Gstr2bRun].map((M) => M.deleteMany({ company: { $in: ids } })));
  await Company.deleteMany({ _id: { $in: ids } });
  return ids.length;
}

module.exports = { createDemoWorkspace, cloneDemoWorkspace, warmDemoTemplate, cleanupOldDemos };
