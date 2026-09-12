const path = require('path');
const fs = require('fs');

// pdfjs-dist is ESM-only, so it's loaded via dynamic import() even though this
// file is CommonJS. This replaced the `pdf-parse` package, which failed on a
// perfectly valid, poppler-readable PDF during testing — pdfjs-dist is the
// same engine Firefox uses to render PDFs, and is far more robust.
let pdfjsPromise = null;
function getPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

const STANDARD_FONT_DATA_URL = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/';

async function extractTextFromPDF(filePath) {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({ data, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;

  let fullText = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map((item) => item.str).join(' ') + '\n';
  }
  return fullText;
}

// Regex still runs first for the simple, reliable, single-value fields — no
// point paying for an LLM call to find a doc number or a clearly-labeled total.
function extractFieldsRegex(text) {
  const num = (regex, group = 1) => {
    const m = text.match(regex);
    return m ? parseFloat(m[group].replace(/,/g, '')) : null;
  };

  const deliveredQuantity = num(/(?:quantity\s+delivered|delivered\s+qty|delivered\s+quantity)\s*[:\-]?\s*([\d,]+)/i);
  const quantity = num(/(?:qty|quantity)(?:\s+ordered)?\s*[:\-]?\s*(?!.*delivered)([\d,]+)/i);
  const unitPrice = num(/(?:unit price|rate per unit|price per unit|rate)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)/i);
  const taxPercent = num(/(?:gst|tax)\s*(?:@)?\s*[:\-]?\s*([\d.]+)\s*%/i);
  const totalAmount = num(/(?<!sub\s)(?:grand total|total amount due|total amount|total)\s*[:\-]?\s*(?:usd\s*)?(₹|rs\.?|inr|\$)\s*([\d,]+(?:\.\d+)?)/i, 2);
  const docNumber = (text.match(/\b(?:PO|INV|DN)-[\w]+/i) || [])[0] || null;

  return { quantity, unitPrice, taxPercent, totalAmount, deliveredQuantity, docNumber, lineItems: [] };
}

// The actual fix for multi-line-item documents: instead of asking for a single
// "quantity" and "unitPrice" (an ambiguous question when a document has 2+
// items), ask for the full line-item table as an array. This is what
// reconcile.js now compares against, item by item, instead of one flat number.
async function callGeminiExtraction(text) {
  const prompt = `Extract structured data from this invoice/purchase-order/delivery-note text. Return ONLY valid JSON, no markdown, no explanation, in this exact shape:
{
  "docNumber": "PO-1042 or similar reference number, or null",
  "totalAmount": <overall document total as a number, or null>,
  "taxPercent": <tax percentage as a number, or null>,
  "lineItems": [
    { "description": "<item name/description>", "quantity": <number>, "unitPrice": <number or null>, "total": <number or null> }
  ]
}
Include ONE entry in lineItems per distinct product/item row in the document. If the document has only one item overall (no table), still return it as a single-entry lineItems array. Numbers only, no currency symbols or commas.

TEXT:
${text.slice(0, 3000)}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0 },
      }),
    }
  );
  const data = await response.json();
  if (data.error) {
    throw new Error(`Gemini API error: ${data.error.message || JSON.stringify(data.error)}`);
  }
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    console.error('Gemini returned no usable candidate. Full response:', JSON.stringify(data));
    throw new Error('Empty response from Gemini');
  }

  const cleaned = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

async function extractFieldsLLM(text) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const parsed = await callGeminiExtraction(text);
      const lineItems = Array.isArray(parsed.lineItems) ? parsed.lineItems : [];
      // Single-item convenience fields, derived from lineItems when there's
      // exactly one — kept for backward compatibility with anything still
      // reading flat quantity/unitPrice, and for the "no table" case.
      const single = lineItems.length === 1 ? lineItems[0] : null;
      return {
        quantity: single?.quantity ?? null,
        unitPrice: single?.unitPrice ?? null,
        taxPercent: parsed.taxPercent ?? null,
        totalAmount: parsed.totalAmount ?? null,
        deliveredQuantity: null,
        docNumber: parsed.docNumber ?? null,
        lineItems,
      };
    } catch (err) {
      lastErr = err;
      console.warn(`Gemini extraction attempt ${attempt} failed:`, err.message);
    }
  }
  throw lastErr;
}

function countFields(fields) {
  const flatCount = ['quantity', 'unitPrice', 'taxPercent', 'totalAmount', 'deliveredQuantity', 'docNumber']
    .filter((k) => fields[k] !== null && fields[k] !== undefined).length;
  const lineItemBonus = fields.lineItems && fields.lineItems.length > 0 ? 3 : 0;
  return flatCount + lineItemBonus;
}

async function parseDocument(filePath) {
  let text = '';

  try {
    text = await extractTextFromPDF(filePath);
  } catch (err) {
    console.warn('PDF text extraction failed on this file:', err.message);
    text = '';
  }

  if (!text.trim()) {
    return {
      extracted: { quantity: null, unitPrice: null, taxPercent: null, totalAmount: null, deliveredQuantity: null, docNumber: null, lineItems: [], raw: '' },
      parseStatus: 'failed',
      parseConfidence: 0,
    };
  }

  let fields = extractFieldsRegex(text);
  let usedLLM = false;
  const regexFieldCount = countFields(fields);

  if (regexFieldCount < 3 && process.env.GEMINI_API_KEY) {
    try {
      const llmFields = await extractFieldsLLM(text);
      fields = {
        quantity: fields.quantity ?? llmFields.quantity,
        unitPrice: fields.unitPrice ?? llmFields.unitPrice,
        taxPercent: fields.taxPercent ?? llmFields.taxPercent,
        totalAmount: fields.totalAmount ?? llmFields.totalAmount,
        deliveredQuantity: fields.deliveredQuantity ?? llmFields.deliveredQuantity,
        docNumber: fields.docNumber ?? llmFields.docNumber,
        lineItems: llmFields.lineItems.length > 0 ? llmFields.lineItems : fields.lineItems,
      };
      usedLLM = true;
      console.log(`LLM extraction fallback succeeded: regex found ${regexFieldCount} field(s), LLM brought it to ${countFields(fields)} (${fields.lineItems.length} line item(s)).`);
    } catch (err) {
      console.warn('LLM extraction fallback failed, keeping regex-only result:', err.message);
    }
  }

  const fieldsFound = countFields(fields);
  const parseStatus = fieldsFound >= 3 ? 'parsed' : 'needs_review';

  return {
    extracted: { ...fields, raw: text.slice(0, 2000) },
    parseStatus,
    parseConfidence: fieldsFound >= 3 ? (usedLLM ? 0.85 : 0.9) : 0.5,
  };
}

module.exports = { parseDocument };
