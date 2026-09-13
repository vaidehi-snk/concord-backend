const PDFDocument = require('pdfkit');

/**
 * Generates a formatted credit note PDF for a resolved (or being-resolved)
 * dispute — an actual document a finance team can file or send, not just
 * email text. Returns a Buffer; the route decides whether to stream it as
 * a download or store it.
 *
 * Field choices follow the standard shape of an Indian GST credit note:
 * credit note number, date, reference to the original invoice, the affected
 * line item(s), the tax adjustment, and the total credited amount. This is
 * a structured document, not a styled version of the negotiation email.
 */
function generateCreditNotePDF(dispute) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const creditNoteNumber = `CN-${dispute._id.toString().slice(-8).toUpperCase()}`;
    const issueDate = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text('CREDIT NOTE', { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#5B5F6B')
      .text('Issued via Concord — Autonomous B2B Dispute & Settlement Platform');
    doc.moveDown(1.2);
    doc.fillColor('#14171F');

    // Credit note meta
    const metaTop = doc.y;
    doc.fontSize(10).font('Helvetica-Bold').text('Credit Note No.', 50, metaTop);
    doc.font('Helvetica').text(creditNoteNumber, 200, metaTop);
    doc.font('Helvetica-Bold').text('Date', 50, metaTop + 18);
    doc.font('Helvetica').text(issueDate, 200, metaTop + 18);
    doc.font('Helvetica-Bold').text('Against Invoice', 50, metaTop + 36);
    doc.font('Helvetica').text(dispute.invoice?.docNumber || String(dispute.invoice?._id || ''), 200, metaTop + 36);
    doc.font('Helvetica-Bold').text('Against PO', 50, metaTop + 54);
    doc.font('Helvetica').text(dispute.po?.docNumber || String(dispute.po?._id || ''), 200, metaTop + 54);
    doc.moveDown(4.5);

    doc.font('Helvetica-Bold').text('Vendor', 50, doc.y);
    doc.font('Helvetica').text(dispute.vendor?.name || 'Unknown vendor', 200, doc.y - 12);
    doc.moveDown(1.5);

    // Line items table — the actual reason for the credit
    doc.font('Helvetica-Bold').fontSize(11).text('Reason for Credit', 50, doc.y);
    doc.moveDown(0.5);

    const tableTop = doc.y;
    doc.fontSize(9).font('Helvetica-Bold');
    doc.text('Description', 50, tableTop, { width: 260 });
    doc.text('Severity', 320, tableTop, { width: 80 });
    doc.text('Amount (Rs.)', 420, tableTop, { width: 100, align: 'right' });
    doc.moveTo(50, tableTop + 15).lineTo(520, tableTop + 15).strokeColor('#E4E2DC').stroke();

    let rowY = tableTop + 22;
    doc.font('Helvetica').fontSize(9);
    dispute.flags.forEach((flag) => {
      // PDFKit's built-in fonts don't support the ₹ Unicode glyph (renders as
      // a broken superscript character) — swap for "Rs." only in this PDF
      // context. The ₹ symbol stays as-is everywhere else in the app, where
      // browsers render it correctly.
      const safeDescription = flag.description.replace(/₹/g, 'Rs. ');
      const rowHeight = doc.heightOfString(safeDescription, { width: 260 });
      doc.text(safeDescription, 50, rowY, { width: 260 });
      doc.text(flag.severity, 320, rowY, { width: 80 });
      doc.text((flag.financialImpact || 0).toLocaleString('en-IN'), 420, rowY, { width: 100, align: 'right' });
      rowY += Math.max(rowHeight, 14) + 8;
    });

    doc.moveTo(50, rowY).lineTo(520, rowY).strokeColor('#E4E2DC').stroke();
    rowY += 10;
    doc.font('Helvetica-Bold').fontSize(11);
    doc.text('Total Credit Amount', 320, rowY, { width: 100 });
    doc.text(`Rs. ${dispute.totalFinancialImpact.toLocaleString('en-IN')}`, 420, rowY, { width: 100, align: 'right' });

    doc.moveDown(4);
    doc.fontSize(8).font('Helvetica').fillColor('#5B5F6B')
      .text(
        'This credit note was generated based on an automated reconciliation of the Purchase Order, Delivery Note, and Invoice for this transaction. It reflects the financial impact of the discrepancies listed above and is intended for internal accounting and vendor settlement purposes.',
        50,
        doc.y,
        { width: 470 }
      );

    doc.end();
  });
}

module.exports = { generateCreditNotePDF };
