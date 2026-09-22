const PDFDocument = require('pdfkit');

// items: [{ product_code, description, qty, unit_price }]
function generateQuotePdf({ order, customer, items, companyName }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'letter' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).font('Helvetica-Bold').text(companyName || 'Quote', { align: 'left' });
    doc.fontSize(20).font('Helvetica-Bold').text('QUOTE', 50, 50, { align: 'right' });
    doc.moveDown(1.5);

    doc.fontSize(10).font('Helvetica');
    doc.text(`Quote #: ${order.id}`);
    doc.text(`Date: ${new Date(order.created_at).toLocaleDateString()}`);
    doc.moveDown(0.5);
    doc.text(`Customer: ${customer.name}`);
    doc.text(`Address: ${customer.address}`);
    doc.text(`Phone: ${customer.phone}`);
    doc.moveDown(1);

    const cols = { code: 50, desc: 130, qty: 380, price: 430, total: 490 };
    let y = doc.y;

    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Code', cols.code, y, { width: 75 });
    doc.text('Description', cols.desc, y, { width: 240 });
    doc.text('Qty', cols.qty, y, { width: 40 });
    doc.text('Price', cols.price, y, { width: 55 });
    doc.text('Total', cols.total, y, { width: 55 });
    y += 16;
    doc.moveTo(50, y).lineTo(545, y).stroke();
    y += 8;

    doc.font('Helvetica').fontSize(9);
    for (const item of items) {
      if (y > 700) {
        doc.addPage();
        y = 50;
      }
      const lineTotal = item.qty * item.unit_price;
      doc.text(item.product_code, cols.code, y, { width: 75 });
      doc.text(item.description, cols.desc, y, { width: 240 });
      doc.text(String(item.qty), cols.qty, y, { width: 40 });
      doc.text(`$${item.unit_price.toFixed(2)}`, cols.price, y, { width: 55 });
      doc.text(`$${lineTotal.toFixed(2)}`, cols.total, y, { width: 55 });
      // advance by however many lines the description wrapped to (rough estimate)
      const estLines = Math.max(1, Math.ceil(item.description.length / 45));
      y += 12 * estLines + 6;
    }

    y += 6;
    doc.moveTo(50, y).lineTo(545, y).stroke();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(11).text(`Total: $${Number(order.total).toFixed(2)}`, cols.price, y, { width: 100 });

    doc.moveDown(3);
    doc.font('Helvetica').fontSize(8).fillColor('#666').text(
      'This is a quote, not an invoice. Prices subject to confirmation.',
      50,
      750,
      { width: 500 }
    );

    doc.end();
  });
}

module.exports = { generateQuotePdf };
