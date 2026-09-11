const path = require('path');
const fs = require('fs');

// pdfjs-dist is ESM-only, so it's loaded via dynamic import() even though this
// file is CommonJS. This also replaced the `pdf-parse` package, which failed
// on a perfectly valid, poppler-readable PDF during testing — pdfjs-dist is
// the same engine Firefox uses to render PDFs, and is far more robust.
let pdfjsPromise = null;
function getPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

const STANDARD_FONT_DATA_URL = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/';

/**
 * Week 2-3 target: turn an uploaded PDF into the structured `extracted` fields
 * on the Document model.
 *
 * Current strategy: pdfjs-dist text extraction only, for text-based/digitally
 * generated PDFs — which covers most vendor invoices that weren't scanned.
 * Anything that comes back empty (a scanned/image PDF) is marked `needs_review`
 * instead of guessed at.
 *
 * OCR fallback (tesseract.js) was tried and pulled out: it can only read actual
 * images, not PDF files directly, and its Node worker throws in a way that
 * bypasses normal try/catch, crashing the process instead of failing gracefully.
 * A real scanned-PDF pipeline needs to render each PDF page to an image first
 * before OCR — that's a real future task, not a quick fix.
 *
 * This is intentionally rules-based, not ML-based, for the MVP — real invoice
 * layouts vary a lot, and a fine-tuned layout model is explicitly a v2 item.
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

// Very deliberately simple first-pass field extraction. Expect to rewrite this
// per real vendor template once you're testing against your actual sample set —
// that's exactly what Week 2-3 is for. Keeping the regexes centralized here
// means swapping in a smarter extractor later doesn't touch any other file.
function extractFields(text) {
  const num = (regex, group = 1) => {
    const m = text.match(regex);
    return m ? parseFloat(m[group].replace(/,/g, '')) : null;
  };

  // Delivered quantity must be checked BEFORE plain quantity, since "Quantity
  // Delivered: 175" would otherwise also match a loose "quantity ... (\d+)" pattern.
  const deliveredQuantity = num(/(?:quantity\s+delivered|delivered\s+qty|delivered\s+quantity)\s*[:\-]?\s*([\d,]+)/i);

  // Matches "Qty:", "Quantity:", "Quantity Ordered:" — but not "Quantity Delivered"
  // (excluded via negative lookahead) so it doesn't double-match the delivered figure.
  const quantity = num(/(?:qty|quantity)(?:\s+ordered)?\s*[:\-]?\s*(?!.*delivered)([\d,]+)/i);

  // Covers "Unit Price:", "Rate:", "Rate per unit:", "Price per unit:"
  const unitPrice = num(/(?:unit price|rate per unit|price per unit|rate)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)/i);

  // Covers "GST: 18%", "GST @ 18%", "Tax: 18%"
  const taxPercent = num(/(?:gst|tax)\s*(?:@)?\s*[:\-]?\s*([\d.]+)\s*%/i);

  // Covers "Total Amount:", "Grand Total:", "Total:" with ₹/Rs/INR or $/USD.
  // Requires a currency marker adjacent to the number (see comment above), and
  // excludes "Sub Total" via negative lookbehind so it doesn't stop at the
  // subtotal line before reaching the actual total a few words later.
  const totalAmount = num(/(?<!sub\s)(?:grand total|total amount due|total amount|total)\s*[:\-]?\s*(?:usd\s*)?(₹|rs\.?|inr|\$)\s*([\d,]+(?:\.\d+)?)/i, 2);

  // Requires a hyphen right after the prefix (e.g. "PO-1092") so it doesn't
  // match unrelated text like "PO Number" before reaching the real number.
  const docNumber = (text.match(/\b(?:PO|INV|DN)-[\w]+/i) || [])[0] || null;

  return { quantity, unitPrice, taxPercent, totalAmount, deliveredQuantity, docNumber };
}

async function parseDocument(filePath) {
  let text = '';

  try {
    text = await extractTextFromPDF(filePath);
  } catch (err) {
    // File claims to be a PDF but isn't valid (a .docx renamed to .pdf, a scanned
    // image, or a genuinely corrupt file) — don't crash, just treat as empty text.
    console.warn('PDF text extraction failed on this file:', err.message);
    text = '';
  }

  const fields = extractFields(text);
  const fieldsFound = Object.values(fields).filter((v) => v !== null).length;

  const parseStatus = fieldsFound >= 3 ? 'parsed' : text.trim().length > 0 ? 'needs_review' : 'failed';

  return {
    extracted: { ...fields, raw: text.slice(0, 2000) },
    parseStatus,
    parseConfidence: fieldsFound >= 3 ? 0.9 : text.trim().length > 0 ? 0.5 : 0,
  };
}

module.exports = { parseDocument };
