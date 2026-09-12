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

/**
 * Turns an uploaded PDF into the structured `extracted` fields on the
 * Document model. Two-stage strategy:
 *
 *  1. Regex extraction (fast, free, instant) — works well when a label and
 *     its value sit right next to each other in the text ("Quantity: 200").
 *  2. LLM extraction (Gemini) — used ONLY when regex found fewer than 3
 *     fields, which in practice means the document uses a table layout
 *     (column headers separated from their row values in the raw extracted
 *     text, which regex adjacency can't bridge but an LLM reading the same
 *     text can). This was proven necessary — regex alone failed on every
 *     table-formatted real invoice tested (Sliced Invoices sample, the
 *     TechSupply Ltd. PO/DN/Invoice trio, a generic PO template), which
 *     turned out to be the majority case, not an edge case.
 *
 * OCR fallback (tesseract.js) was tried and pulled out: it can only read
 * actual images, not PDF files directly, and its Node worker throws in a way
 * that bypasses normal try/catch. A real scanned-PDF pipeline needs to render
 * each PDF page to an image first — a genuine future task, not a quick fix.
 */
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

  return { quantity, unitPrice, taxPercent, totalAmount, deliveredQuantity, docNumber };
}

// Called only when regex extraction comes up short. Sends the already-extracted
// raw text (not the PDF itself) to Gemini and asks for the same fields back as
// JSON — an LLM reading jumbled table text can associate "Qty" with its value
// several words away the way a human glancing at the table would, which
// adjacency-based regex fundamentally cannot do.
async function callGeminiExtraction(text) {
  const prompt = `Extract these fields from the invoice/purchase-order/delivery-note text below. Return ONLY valid JSON, no markdown, no explanation, using exactly these keys: quantity, unitPrice, taxPercent, totalAmount, deliveredQuantity, docNumber (the PO/INV/DN reference number, e.g. "PO-1042"). Use null for any field not present. Numbers only (no currency symbols or commas) for numeric fields.

TEXT:
${text.slice(0, 3000)}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // temperature: 0 makes this as close to deterministic as Gemini allows —
        // this is a data-extraction task, not creative writing, so randomness
        // only hurts here. This was previously unset (defaulting to a
        // creative-writing-appropriate temperature), which is the real reason
        // the same document could parse differently between two calls.
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

// Retries once on failure (network hiccup, transient API error, bad JSON) —
// so a single flaky call doesn't force a manual re-upload. Two attempts total.
async function extractFieldsLLM(text) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const parsed = await callGeminiExtraction(text);
      return {
        quantity: parsed.quantity ?? null,
        unitPrice: parsed.unitPrice ?? null,
        taxPercent: parsed.taxPercent ?? null,
        totalAmount: parsed.totalAmount ?? null,
        deliveredQuantity: parsed.deliveredQuantity ?? null,
        docNumber: parsed.docNumber ?? null,
      };
    } catch (err) {
      lastErr = err;
      console.warn(`Gemini extraction attempt ${attempt} failed:`, err.message);
    }
  }
  throw lastErr;
}

function countFields(fields) {
  return Object.values(fields).filter((v) => v !== null).length;
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
    return { extracted: { quantity: null, unitPrice: null, taxPercent: null, totalAmount: null, deliveredQuantity: null, docNumber: null, raw: '' }, parseStatus: 'failed', parseConfidence: 0 };
  }

  let fields = extractFieldsRegex(text);
  let usedLLM = false;
  const regexFieldCount = countFields(fields);

  if (regexFieldCount < 3 && process.env.GEMINI_API_KEY) {
    try {
      const llmFields = await extractFieldsLLM(text);
      // Merge: prefer regex where it found something (cheaper, no hallucination
      // risk), fill gaps from the LLM.
      fields = {
        quantity: fields.quantity ?? llmFields.quantity,
        unitPrice: fields.unitPrice ?? llmFields.unitPrice,
        taxPercent: fields.taxPercent ?? llmFields.taxPercent,
        totalAmount: fields.totalAmount ?? llmFields.totalAmount,
        deliveredQuantity: fields.deliveredQuantity ?? llmFields.deliveredQuantity,
        docNumber: fields.docNumber ?? llmFields.docNumber,
      };
      usedLLM = true;
      console.log(`LLM extraction fallback succeeded: regex found ${regexFieldCount} field(s), LLM brought it to ${countFields(fields)}.`);
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
