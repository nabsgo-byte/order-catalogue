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

  // Added for monthly specials. NULL = not currently on special. Uploading
  // a new specials list clears this for every product first, then sets it
  // for just the uploaded codes — so last month's specials never linger.
  await pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS special_price NUMERIC(10,2);
  `);

  // Company name is mandatory for new signups (enforced in the /register
  // route), but nullable here so existing customers without one don't break.
  await pool.query(`
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS company_name TEXT;
  `);

  // Optional customer-supplied reference (their own PO number, job name,
  // etc.), entered per order at checkout and shown on the quote, emails,
  // and admin order list.
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS reference TEXT;
  `);

  // A durable copy of each customer's in-progress cart, so it survives a
  // server restart/redeploy (the session itself is in-memory only) or the
  // customer coming back from a different device. Cleared once they submit.
  await pool.query(`
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS saved_cart JSONB;
  `);
}

module.exports = { pool, initSchema };
