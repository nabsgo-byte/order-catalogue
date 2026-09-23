// Imports scripts/products.csv (and any matching images in scripts/images/)
// into the products table.
//
// Run with: DATABASE_URL="..." npm run seed
//
// Safe to re-run any time: it updates existing product codes and adds new
// ones. If scripts/images/<code>.jpg exists for a product, its photo is
// loaded too; if not, that product's existing photo (if any) is left alone
// — so a price-only update doesn't require re-sending every image.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { pool, initSchema } = require('../db');

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];

function findImage(imagesDir, code) {
  for (const ext of IMAGE_EXTENSIONS) {
    const p = path.join(imagesDir, code + ext);
    if (fs.existsSync(p)) {
      const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
      return { data: fs.readFileSync(p), mime };
    }
  }
  return null;
}

async function main() {
  await initSchema();

  const csvPath = process.argv[2] || path.join(__dirname, 'products.csv');
  const imagesDir = path.join(__dirname, 'images');
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true });

  const hasImages = fs.existsSync(imagesDir);
  console.log(`Importing ${rows.length} products from ${csvPath} ...`);
  console.log(hasImages ? `Found images/ folder — photos will be loaded too.` : `No images/ folder found — skipping photos.`);

  let inserted = 0;
  let updated = 0;
  let withImage = 0;

  for (const row of rows) {
    const code = (row.product_code || '').trim();
    const description = (row.description || '').trim();
    const uom = (row.unit_of_measure || '').trim();
    const unitPrice = parseFloat(row.unit_price) || 0;
    const casePrice = parseFloat(row.case_price) || null;

    if (!code || !description) continue;

    const image = hasImages ? findImage(imagesDir, code) : null;
    if (image) withImage++;

    let result;
    if (image) {
      result = await pool.query(
        `INSERT INTO products (product_code, description, unit_of_measure, unit_price, case_price, image_data, image_mime)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (product_code)
         DO UPDATE SET description = EXCLUDED.description,
                       unit_of_measure = EXCLUDED.unit_of_measure,
                       unit_price = EXCLUDED.unit_price,
                       case_price = EXCLUDED.case_price,
                       image_data = EXCLUDED.image_data,
                       image_mime = EXCLUDED.image_mime
         RETURNING (xmax = 0) AS inserted`,
        [code, description, uom, unitPrice, casePrice, image.data, image.mime]
      );
    } else {
      result = await pool.query(
        `INSERT INTO products (product_code, description, unit_of_measure, unit_price, case_price)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (product_code)
         DO UPDATE SET description = EXCLUDED.description,
                       unit_of_measure = EXCLUDED.unit_of_measure,
                       unit_price = EXCLUDED.unit_price,
                       case_price = EXCLUDED.case_price
         RETURNING (xmax = 0) AS inserted`,
        [code, description, uom, unitPrice, casePrice]
      );
    }
    if (result.rows[0].inserted) inserted++; else updated++;
  }

  console.log(`Done. ${inserted} new products, ${updated} updated, ${withImage} photos loaded.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
