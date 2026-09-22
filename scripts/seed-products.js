// Imports scripts/products.csv into the products table.
// Run with: npm run seed
// Re-run any time you have a new price list — it updates existing
// product codes and adds new ones (nothing is deleted automatically).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { pool, initSchema } = require('../db');

async function main() {
  await initSchema();

  const csvPath = process.argv[2] || path.join(__dirname, 'products.csv');
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true });

  console.log(`Importing ${rows.length} products from ${csvPath} ...`);

  let inserted = 0;
  let updated = 0;

  for (const row of rows) {
    const code = (row.product_code || '').trim();
    const description = (row.description || '').trim();
    const uom = (row.unit_of_measure || '').trim();
    const unitPrice = parseFloat(row.unit_price) || 0;
    const casePrice = parseFloat(row.case_price) || null;

    if (!code || !description) continue;

    const result = await pool.query(
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
    if (result.rows[0].inserted) inserted++; else updated++;
  }

  console.log(`Done. ${inserted} new products, ${updated} updated.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
