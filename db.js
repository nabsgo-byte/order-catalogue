const { Pool } = require('pg');
console.log('DATABASE_URL present:', !!process.env.DATABASE_URL, '| starts with:', (process.env.DATABASE_URL || 'MISSING').slice(0, 15));
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
}

module.exports = { pool, initSchema };
