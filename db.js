const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      address TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      product_code TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL,
      unit_of_measure TEXT,
      unit_price NUMERIC(10,2),
      case_price NUMERIC(10,2)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id),
      items JSONB NOT NULL,
      total NUMERIC(10,2) NOT NULL,
      status TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Added after the first release, for product photos. IF NOT EXISTS makes
  // this safe to run again on a database that was already seeded.
  await pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS image_data BYTEA;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS image_mime TEXT;
  `);
}

module.exports = { pool, initSchema };
