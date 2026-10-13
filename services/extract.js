const path = require('path');
const fs = require('fs');
const llm = require('./llm');

/**
 * Document extraction pipeline.
 *
 *  1. Layout-aware text: pdfjs gives every text fragment with its x/y position.
 *     We rebuild visual rows (group by y, sort by x) instead of trusting the
 *     PDF's internal text order — this is what fixes table layouts where a
 *     column header and its value were stored far apart.
 *  2. Classify: purchase order / delivery note (challan, GRN) / invoice.
 *  3. Rules: labelled fields + line items found by the qty × rate ≈ amount
 *     relationship on each row.
 *  4. LLM (Gemini) only when rules come up short, then merged. Rules win for
 *     identifiers; the LLM fills gaps.
 *  5. Confidence from completeness + arithmetic self-consistency.
 */

let pdfjsPromise = null;
function getPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}
const STANDARD_FONT_DATA_URL = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/';

async function extractLayoutText(input) {
  const pdfjs = await getPdfjs();
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), standardFontDataUrl: STANDARD_FONT_DATA_URL, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, 8); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = content.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 }));
    // group into rows: items whose baseline is within 3pt belong to the same row
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const it of items) {
      const row = rows.find((r) => Math.abs(r.y - it.y) < 3);
      if (row) row.items.push(it);
      else rows.push({ y: it.y, items: [it] });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      let line = '';
      let prevEnd = null;
      for (const it of row.items) {
        if (prevEnd !== null) {
          const gap = it.x - prevEnd;
          line += gap > 12 ? '   ' : gap > 1.5 ? ' ' : '';
        }
        line += it.str;
        prevEnd = it.x + it.w;
      }
      pages.push(line.trim());
    }
  }
  return pages.join('\n');
}

// ---------- classification ----------
function classify(text) {
  const head = text.slice(0, 600).toLowerCase();
  const all = text.toLowerCase();
  const score = { PO: 0, DN: 0, INVOICE: 0 };
  const bump = (type, re, headW, bodyW) => {
    if (re.test(head)) score[type] += headW;
    else if (re.test(all)) score[type] += bodyW;
  };
  bump('PO', /purchase\s+order|\bp\.?o\.?\s*(no|number|#)/, 6, 1);
  bump('DN', /delivery\s+(note|challan)|goods\s+receipt|\bgrn\b|packing\s+(slip|list)|dispatch\s+note|challan/, 6, 1);
  bump('INVOICE', /tax\s+invoice|\binvoice\b|bill\s+of\s+supply/, 5, 1);
  bump('DN', /qty\s+delivered|quantity\s+delivered|received\s+qty|delivered/, 2, 1);
  bump('INVOICE', /amount\s+due|due\s+date|total\s+due|bank\s+details|ifsc/, 2, 1);
  // a DN/invoice often *mentions* "purchase order" in a reference line — don't let that win
  if (/(against|ref(erence)?|associated)\s*(po|purchase\s+order)/.test(all)) score.PO -= 3;
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return { type: best[1] > 0 ? best[0] : null, scores: score };
}

// ---------- helpers ----------
const num = (s) => {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/[₹,\s]|rs\.?|inr|\$/gi, ''));
  return Number.isFinite(n) ? n : null;
};

function normalizeKey(ref) {
  if (!ref) return null;
  let k = String(ref).toUpperCase().replace(/[^A-Z0-9]/g, '');
  k = k.replace(/^(PO|PURCHASEORDER|ORDER|ORD)/, '');
  k = k.replace(/^0+(?=\d)/, '');
  return k || null;
}

const DOCNUM = '([A-Z]{0,6}[-/]?[A-Z0-9][A-Z0-9\\-/]{1,24})';

function findLabelled(text, labels) {
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:#.\\-]*\\s*#?\\s*${DOCNUM}`, 'i');
    const m = text.match(re);
    if (m && /\d/.test(m[1])) return m[1].replace(/[.,]$/, '');
  }
  return null;
}

function findAmount(text, labels) {
  for (const label of labels) {
    const re = new RegExp(`(?<!sub\\s?)${label}[^\\n\\d₹$]{0,25}(?:₹|rs\\.?|inr|\\$)?\\s*([\\d,]+(?:\\.\\d{1,2})?)`, 'i');
    const m = text.match(re);
    if (m) {
      const v = num(m[1]);
      if (v != null) return v;
    }
  }
  return null;
}

function findGSTINs(text) {
  return [...new Set((text.toUpperCase().match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g) || []))];
}

function parseDateLoose(s) {
  if (!s) return null;
  const t = s.trim();
  // dd/mm/yyyy or dd-mm-yyyy (Indian convention)
  let m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    let [day, month] = [+m[1], +m[2]];
    if (month > 12 && day <= 12) [day, month] = [month, day]; // US-style m/d/y
    if (month > 12 || day > 31) return null;
    const d = new Date(Date.UTC(y, month - 1, day));
    return isNaN(d) ? null : d;
  }
  // "14 September 2026", "14-Sep-2026", "January 25, 2016"
  const d = new Date(t.replace(/-/g, ' ').replace(/(\d)(st|nd|rd|th)/, '$1'));
  if (isNaN(d) || d.getFullYear() < 1990) return null;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); // no timezone drift
}

function findDate(text, labels) {
  const DATE = '(\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|\\d{1,2}[\\s\\-][A-Za-z]{3,9}[\\s\\-,]+\\d{4}|[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})';
  for (const label of labels) {
    const m = text.match(new RegExp(`${label}\\s*[:\\-]?\\s*${DATE}`, 'i'));
    const d = m && parseDateLoose(m[1]);
    if (d) return d;
  }
  return null;
}

// "VENDOR   SHIP TO" header row, value on the next row → take the column under the label
function valueBelowLabel(text, labelRe) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const cols = lines[i].split(/\s{2,}/).map((c) => c.trim());
    const idx = cols.findIndex((c) => labelRe.test(c.replace(/[:\s]+$/, '')));
    if (idx >= 0) {
      const beside = cols[idx + 1];
      if (beside && /[a-z]{3,}/i.test(beside) && !/^(gstin|phone|ship|bill|date|address)/i.test(beside)) return beside;
      const next = lines[i + 1].split(/\s{2,}/).map((c) => c.trim());
      const v = next[Math.min(idx, next.length - 1)] || next[0];
      if (v && /[a-z]{2,}/i.test(v) && !/^\[.*\]$/.test(v)) return v.replace(/\s{2,}.*/, '');
    }
  }
  return null;
}

function guessVendorName(text, type) {
  const below = type === 'PO' ? valueBelowLabel(text, /^(vendor|supplier)$/i) : valueBelowLabel(text, /^(from|seller|supplier|sold\s+by)$/i);
  if (below) return below;
  const labelled = text.match(/(?:vendor|supplier|seller|sold\s+by|from)\s*[:\-]\s*([a-z][a-z0-9&.,'() \-]{2,60}?)(?:\s{2,}|\n|$)/im);
  if (labelled && type === 'PO') return labelled[1].trim();
  if (type !== 'PO') {
    // Invoices & challans are issued BY the vendor: their name is usually on the title row
    const firstLines = text.split('\n').slice(0, 4);
    for (const line of firstLines) {
      const cleaned = line.replace(/tax\s+invoice|invoice|delivery\s+(note|challan)|purchase\s+order|original|duplicate|triplicate/gi, '').trim();
      if (/(ltd|limited|pvt|private|llp|inc|co\.|corporation|industries|traders|enterprises|supplies|solutions)/i.test(cleaned)) {
        return cleaned.replace(/\s{2,}.*/, '').trim();
      }
    }
    if (labelled) return labelled[1].trim();
  }
  return labelled ? labelled[1].trim() : null;
}

// Line items: any row with ≥2 numbers where qty × rate ≈ amount, or (for
// challans) a description followed by quantity columns.
const HEADER_WORDS = /^(item\s*(#|no\.?|id|code)?|description|particulars|product(\s+name)?|s\.?\s?no\.?|sr\.?\s?no\.?|sku|hsn(\/sac)?|qty|quantity|rate|price|unit\s+price|amount|total|service|hrs\/qty)$/i;
const NUMERIC = /^[₹$]?\s*-?[\d,]+(\.\d+)?%?$/;

function extractLineItems(text, type) {
  const items = [];
  const lines = text.split('\n');
  let inTable = false;
  let dnDeliveredCol = null;
  let pendingDescription = null;

  for (const line of lines) {
    const lower = line.toLowerCase();
    const tokens = line.split(/\s{2,}|\t/).map((t) => t.trim()).filter(Boolean);

    // Table header row: has a quantity column and at least one other header word
    if (/\b(qty|quantity|hrs\/qty)\b/.test(lower) && tokens.filter((t) => HEADER_WORDS.test(t) || /qty|quantity|price|rate|amount|total|deliver/i.test(t)).length >= 2) {
      inTable = true;
      // Remember where the delivered column sits counted from the right, among
      // numeric-type columns only (HSN codes / item ids on the left would
      // otherwise shift the index).
      const idx = tokens.findIndex((c) => /(qty|quantity).*(deliver|receiv|dispatch|supplied)|(deliver|receiv|dispatch|supplied).*(qty|quantity)/i.test(c));
      dnDeliveredCol = idx >= 0 ? tokens.slice(idx + 1).filter((c) => /qty|quantity|rate|price|amount|total|weight|hsn/i.test(c)).length : null;
      continue;
    }
    if (/^(sub\s*-?\s*total|grand\s+total|total|tax\b|gst|cgst|sgst|igst|amount\s+due|balance|shipping|other|comments)/i.test(line.trim())) {
      if (inTable && /total/i.test(line)) inTable = false;
      continue;
    }

    const numericIdx = tokens.map((t, i) => (NUMERIC.test(t) ? i : -1)).filter((i) => i >= 0);
    const textTokens = tokens.filter((t, i) => !numericIdx.includes(i) && /[a-z]{3,}/i.test(t) && !/^(pcs|nos|units?|kg|ea|each|complete|partial|pending)$/i.test(t) && !HEADER_WORDS.test(t));

    // A text-only row inside a table is often the description for the numbers on the next row
    if (!numericIdx.length) {
      if (inTable && textTokens.length) pendingDescription = textTokens.join(' ');
      continue;
    }

    const nums = numericIdx.map((i) => tokens[i]).filter((t) => !t.endsWith('%')).map(num);
    const pct = numericIdx.map((i) => tokens[i]).find((t) => t.endsWith('%'));
    const description = textTokens.length ? textTokens.sort((a, b) => b.length - a.length)[0] : pendingDescription;
    if (!description) continue;

    let found = null;
    for (let a = 0; a < nums.length && !found; a++) {
      for (let b = a + 1; b < nums.length && !found; b++) {
        for (let c = b + 1; c < nums.length && !found; c++) {
          const [q, p, t] = [nums[a], nums[b], nums[c]];
          if (q > 0 && p > 0 && t > 0 && Math.abs(q * p - t) <= Math.max(1, t * 0.005)) found = { quantity: q, unitPrice: p, total: t };
        }
      }
    }
    if (found) {
      items.push({ description, ...found, ...(pct && num(pct) > 0 ? { taxPercent: num(pct) } : {}) });
      pendingDescription = null;
    } else if (type === 'DN' && inTable) {
      const ints = nums.filter((n) => Number.isInteger(n) && n >= 0 && n < 1e6);
      if (ints.length) {
        const pos = ints.length - 1 - (dnDeliveredCol || 0);
        const qty = ints[pos] != null ? ints[pos] : ints[ints.length - 1];
        items.push({ description, quantity: qty });
        pendingDescription = null;
      }
    }
  }
  return items;
}

// Payee bank details printed on the invoice — used to catch a changed account (invoice fraud)
function findBank(text) {
  const acc = text.match(/(?:a\/?c|account)\s*(?:no\.?|number|#)?\s*[:.\-]?\s*(\d[\d ]{7,20}\d)/i);
  const ifsc = text.match(/\b([A-Z]{4}0[A-Z0-9]{6})\b/);
  return { account: acc ? acc[1].replace(/\s/g, '') : null, ifsc: ifsc ? ifsc[1] : null };
}

function extractRules(text, type) {
  const docNumber =
    type === 'PO'
      ? findLabelled(text, ['purchase\\s+order\\s+(?:no|number)', 'p\\.?o\\.?\\s*(?:no|number|#)', 'po'])
      : type === 'DN'
        ? findLabelled(text, ['delivery\\s+(?:note|challan)\\s*(?:no|number)?', 'challan\\s*(?:no|number)', 'grn\\s*(?:no|number)?', 'dn\\s*(?:no|number)?'])
        : findLabelled(text, ['invoice\\s*(?:no|number)', 'bill\\s*(?:no|number)', 'inv']);

  let poReference =
    type === 'PO'
      ? docNumber
      : findLabelled(text, ['against\\s+(?:po|purchase\\s+order)', '(?:reference|ref\\.?)\\s+(?:po|purchase\\s+order)', 'associated\\s+po', 'po\\s*(?:ref|reference|no|number)', 'order\\s*(?:no|number)', 'buyer.?s\\s+order\\s+no']);
  if (!poReference && type !== 'PO') {
    const m = text.match(/\bPO[-/]?\d{3,}\b/i);
    if (m) poReference = m[0];
  }

  const gstins = findGSTINs(text);
  const taxPercent = (() => {
    const m = text.match(/(?:gst|igst|tax|vat)\s*(?:@|\()?\s*([\d.]+)\s*%/i);
    return m ? num(m[1]) : null;
  })();

  const lineItems = extractLineItems(text, type);
  const subtotal = findAmount(text, ['sub\\s*-?total', 'taxable\\s+value', 'taxable\\s+amount']);
  const taxAmount = findAmount(text, ['total\\s+gst', 'total\\s+tax', 'igst(?!in)', 'gst(?!in)\\s*(?:@\\s*[\\d.]+\\s*%)?', 'tax(?!\\s+invoice)\\s*(?:@\\s*[\\d.]+\\s*%)?', 'vat']);
  const totalAmount = findAmount(text, ['grand\\s+total', 'total\\s+amount\\s+due', 'total\\s+amount', 'amount\\s+due', 'total\\s+due', 'invoice\\s+total', 'net\\s+payable', 'total']);

  const bank = findBank(text);
  return {
    docNumber,
    poReference,
    bankAccount: bank.account,
    ifsc: bank.ifsc,
    vendorName: guessVendorName(text, type),
    vendorGstin: type === 'PO' ? gstins[1] || null : gstins[0] || null,
    buyerGstin: type === 'PO' ? gstins[0] || null : gstins[1] || null,
    docDate: findDate(text, ['invoice\\s+date', 'po\\s+date', 'date']),
    dueDate: findDate(text, ['due\\s+date', 'payment\\s+due']),
    taxPercent,
    subtotal,
    taxAmount: taxAmount && taxPercent && taxAmount === taxPercent ? null : taxAmount,
    totalAmount,
    currency: /\$|usd/i.test(text) && !/₹|rs\.|inr/i.test(text) ? 'USD' : 'INR',
    lineItems,
  };
}

async function extractLLM(text, hintType) {
  const prompt = `You are a precise accounts-payable document parser. Read this document text (rows are reconstructed from the PDF layout; columns separated by spaces) and return JSON with exactly these keys:
{
 "type": "PO" | "DN" | "INVOICE",   // DN = delivery note / challan / goods receipt
 "docNumber": string|null,          // this document's own number
 "poReference": string|null,        // the purchase order number it refers to (for a PO, its own number)
 "vendorName": string|null,         // the SUPPLIER (seller), not the buyer
 "vendorGstin": string|null,
 "docDate": "YYYY-MM-DD"|null,
 "dueDate": "YYYY-MM-DD"|null,
 "taxPercent": number|null,
 "subtotal": number|null, "taxAmount": number|null, "totalAmount": number|null,
 "currency": "INR"|"USD"|null,
 "bankAccount": string|null,        // payee bank account number printed on the document, digits only
 "ifsc": string|null,
 "lineItems": [{"description": string, "quantity": number, "unitPrice": number|null, "taxPercent": number|null, "total": number|null}]
}
For a delivery note, quantity = quantity actually delivered/received. One lineItems entry per product row. Numbers without currency symbols or commas. Do not invent values; use null.
${hintType ? `The uploader believes this is a ${hintType}.` : ''}
TEXT:
${text.slice(0, 6000)}`;
  const out = await llm.generateJSON(prompt);
  return out;
}

function confidenceOf(fields, type) {
  let score = 0;
  if (fields.docNumber) score += 0.2;
  if (type === 'PO' || fields.poReference) score += 0.2;
  if (fields.lineItems?.length) score += 0.3;
  if (type === 'DN' || fields.totalAmount) score += 0.15;
  if (fields.vendorName) score += 0.1;
  // arithmetic self-consistency raises trust
  if (fields.lineItems?.length && fields.lineItems.every((li) => li.total == null || li.unitPrice == null || Math.abs(li.quantity * li.unitPrice - li.total) <= Math.max(1, li.total * 0.01))) score += 0.05;
  return Math.min(1, Math.round(score * 100) / 100);
}

/**
 * @param input  file path or Buffer
 * @param opts.type  user-chosen type (optional — auto-detected otherwise)
 */
function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.slice(0, 4).toString() === '%PDF') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(1, 4).toString() === 'PNG') return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

const VISION_PROMPT = (hint) => `You are reading a business document for an Indian accounts-payable team. It may be a scanned page or a phone photo of a printed or handwritten purchase order, delivery challan / goods receipt note, or GST tax invoice. Return JSON with exactly these keys:
{"type":"PO"|"DN"|"INVOICE","docNumber":string|null,"poReference":string|null,"vendorName":string|null,"vendorGstin":string|null,"buyerGstin":string|null,"docDate":"YYYY-MM-DD"|null,"dueDate":"YYYY-MM-DD"|null,"taxPercent":number|null,"subtotal":number|null,"taxAmount":number|null,"totalAmount":number|null,"currency":"INR"|"USD"|null,"bankAccount":string|null,"ifsc":string|null,
"lineItems":[{"description":string,"hsn":string|null,"quantity":number,"unit":string|null,"unitPrice":number|null,"taxPercent":number|null,"total":number|null}]}
Rules: vendorName is the SELLER. For a challan, quantity = quantity actually delivered/received (use the received column if there is one). Indian dates are day-first. Numbers without symbols or commas. Never guess: use null for anything unreadable.${hint ? ` The uploader says this is a ${hint}.` : ''}`;

// Scanned PDFs and photos: the vision model reads the image directly
async function extractVision(buffer, mimeType, hintType) {
  if (!llm.isConfigured()) {
    return { ok: false, error: 'This is a scanned page or photo. Reading those needs the AI model — add a GEMINI_API_KEY on the server, or upload the digital PDF.', text: '' };
  }
  let ai;
  try {
    ai = await llm.generateJSONFromFile(VISION_PROMPT(hintType), { mimeType, data: buffer });
  } catch (err) {
    return { ok: false, error: `The AI model couldn’t read this image right now (${err.message}). Try again in a minute.`, text: '' };
  }
  const type = hintType || (['PO', 'DN', 'INVOICE'].includes(ai.type) ? ai.type : null);
  const d = (x) => (x ? new Date(`${x}T00:00:00Z`) : null);
  const fields = {
    docNumber: ai.docNumber || null,
    poReference: ai.poReference || (type === 'PO' ? ai.docNumber : null),
    bankAccount: ai.bankAccount ? String(ai.bankAccount).replace(/\D/g, '') || null : null,
    ifsc: ai.ifsc || null,
    vendorName: ai.vendorName || null,
    vendorGstin: ai.vendorGstin || null,
    buyerGstin: ai.buyerGstin || null,
    docDate: d(ai.docDate),
    dueDate: d(ai.dueDate),
    taxPercent: num(ai.taxPercent),
    subtotal: num(ai.subtotal),
    taxAmount: num(ai.taxAmount),
    totalAmount: num(ai.totalAmount),
    currency: ai.currency || 'INR',
    lineItems: (ai.lineItems || [])
      .filter((li) => li && li.description && num(li.quantity) != null)
      .map((li) => ({ description: String(li.description).trim(), hsn: li.hsn || undefined, quantity: num(li.quantity), unit: li.unit || undefined, unitPrice: num(li.unitPrice), taxPercent: num(li.taxPercent), total: num(li.total) })),
  };
  if (fields.docDate && isNaN(fields.docDate)) fields.docDate = null;
  if (fields.dueDate && isNaN(fields.dueDate)) fields.dueDate = null;
  // Photos are never fully certain: cap confidence so a person glances at it
  const confidence = Math.min(0.9, confidenceOf(fields, type));
  return { ok: true, type: type || 'INVOICE', typeDetected: ai.type, fields, method: 'vision', confidence, parseStatus: type && confidence >= 0.65 ? 'parsed' : 'needs_review', text: `[read from ${mimeType === 'application/pdf' ? 'scanned PDF' : 'photo'} by vision model]` };
}

async function extractDocument(input, opts = {}) {
  const mime = sniffMime(input);
  if (mime && mime.startsWith('image/')) return extractVision(input, mime, opts.type);
  if (Buffer.isBuffer(input) && !mime) return { ok: false, error: 'Unsupported file. Upload a PDF, or a JPG/PNG photo of the document.', text: '' };
  let text = '';
  try {
    text = await extractLayoutText(input);
  } catch (err) {
    if (Buffer.isBuffer(input)) return extractVision(input, 'application/pdf', opts.type);
    return { ok: false, error: `Could not read this PDF (${err.message}).`, text: '' };
  }
  if (text.replace(/\s/g, '').length < 20) {
    // no text layer: a scanned PDF
    return Buffer.isBuffer(input) ? extractVision(input, 'application/pdf', opts.type) : { ok: false, error: 'This PDF has no text layer.', text: '' };
  }

  const cls = classify(text);
  let type = opts.type || cls.type;
  let fields = extractRules(text, type || 'INVOICE');
  let method = 'rules';

  const weak = !type || !fields.lineItems.length || !fields.docNumber || (type !== 'PO' && !fields.poReference) || !fields.vendorName;
  if (weak && llm.isConfigured()) {
    try {
      const ai = await extractLLM(text, type);
      if (!type && ai.type) type = ai.type;
      const pick = (a, b) => (a !== null && a !== undefined && a !== '' ? a : b);
      fields = {
        docNumber: pick(fields.docNumber, ai.docNumber),
        poReference: pick(fields.poReference, ai.poReference),
        vendorName: pick(ai.vendorName, fields.vendorName), // LLM is better at "who is the seller"
        vendorGstin: pick(fields.vendorGstin, ai.vendorGstin),
        buyerGstin: fields.buyerGstin,
        docDate: fields.docDate || (ai.docDate ? new Date(ai.docDate) : null),
        dueDate: fields.dueDate || (ai.dueDate ? new Date(ai.dueDate) : null),
        taxPercent: pick(fields.taxPercent, ai.taxPercent),
        subtotal: pick(fields.subtotal, ai.subtotal),
        taxAmount: pick(fields.taxAmount, ai.taxAmount),
        totalAmount: pick(fields.totalAmount, ai.totalAmount),
        currency: pick(ai.currency, fields.currency),
        bankAccount: pick(fields.bankAccount, ai.bankAccount),
        ifsc: pick(fields.ifsc, ai.ifsc),
        lineItems: fields.lineItems.length >= (ai.lineItems?.length || 0) ? fields.lineItems : (ai.lineItems || []).filter((li) => li && li.description),
      };
      method = 'rules+llm';
    } catch (err) {
      console.warn('[extract] LLM fallback unavailable:', err.message);
    }
  }
  if (type === 'PO' && !fields.poReference) fields.poReference = fields.docNumber;
  if (fields.docDate && isNaN(fields.docDate)) fields.docDate = null;
  if (fields.dueDate && isNaN(fields.dueDate)) fields.dueDate = null;

  const confidence = confidenceOf(fields, type);
  return {
    ok: true,
    type: type || 'INVOICE',
    typeDetected: cls.type,
    fields,
    method,
    confidence,
    parseStatus: !type ? 'needs_review' : confidence >= 0.65 ? 'parsed' : 'needs_review',
    text,
  };
}

module.exports = { extractDocument, extractLayoutText, classify, normalizeKey, extractRules, findBank, sniffMime };
