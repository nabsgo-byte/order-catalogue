require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { pool, initSchema } = require('./db');
const { toCsv } = require('./lib/csv');
const { generateQuotePdf } = require('./lib/quote-pdf');
const { sendEmail } = require('./lib/email');
const { pricing } = require('./lib/pricing');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
const COMPANY_NAME = process.env.COMPANY_NAME || 'Our Catalog';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

if (!process.env.ADMIN_PASSWORD) {
  console.warn('[security] ADMIN_PASSWORD is not set, so the admin password is "changeme". Set it on Render.');
}
if (!process.env.SESSION_SECRET) {
  console.warn('[security] SESSION_SECRET is not set. Set it to a long random value on Render.');
}

// Express 4 doesn't catch errors thrown inside async route handlers: a single
// database hiccup would become an unhandled rejection and crash the whole
// server for everyone. This wraps every route so errors go to the error page
// at the bottom of this file instead.
for (const method of ['get', 'post']) {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => {
    if (handlers.length === 0) return original(routePath); // app.get('setting')
    return original(
      routePath,
      ...handlers.map((h) => (req, res, next) => {
        try {
          const result = h(req, res, next);
          if (result && typeof result.catch === 'function') result.catch(next);
        } catch (err) {
          next(err);
        }
      })
    );
  };
}

// For putting customer-typed text into email HTML safely.
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
  })
);

// Make the company name available to every view without repeating it
app.use((req, res, next) => {
  res.locals.companyName = COMPANY_NAME;
  next();
});

function requireCustomer(req, res, next) {
  if (!req.session.customerId) return res.redirect('/');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.redirect('/admin/login');
  next();
}

function cartArray(session) {
  return Object.entries(session.cart || {})
    .map(([productId, qty]) => ({ productId: Number(productId), qty: Number(qty) }))
    .filter((e) => Number.isInteger(e.productId) && e.productId > 0 && e.qty > 0);
}

// Product ids arrive from form fields; only accept a real positive integer.
function parseProductId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Mirrors the session cart onto the customer's row, so it isn't lost if the
// server restarts (the session itself lives only in memory) or they come
// back from a different device. Best-effort — a save failure here shouldn't
// block the customer from continuing to shop.
async function persistCart(req) {
  if (!req.session.customerId) return;
  try {
    await pool.query('UPDATE customers SET saved_cart = $1 WHERE id = $2', [
      JSON.stringify(req.session.cart || {}),
      req.session.customerId
    ]);
  } catch (err) {
    console.error('Failed to save cart (continuing anyway):', err);
  }
}

// ---------- Product images ----------
// Stored as bytes in the database (not the filesystem) so they survive
// redeploys on Render's free tier, which has no persistent disk.

app.get('/images/:code', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT image_data, image_mime FROM products WHERE product_code = $1',
    [req.params.code]
  );
  if (!rows.length || !rows[0].image_data) return res.status(404).end();
  res.set('Content-Type', rows[0].image_mime || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=604800');
  res.send(rows[0].image_data);
});

// ---------- Customer identification ----------

app.get('/', (req, res) => {
  if (req.session.customerId) return res.redirect('/catalog');
  res.render('start', { error: null });
});

app.post('/start', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.render('start', { error: 'Please enter your name.' });

  const { rows } = await pool.query(
    'SELECT * FROM customers WHERE lower(name) = lower($1)',
    [name]
  );

  if (rows.length) {
    req.session.customerId = rows[0].id;
    req.session.customerName = rows[0].name;
    // Restore their in-progress cart (saved to the database as they shop),
    // so it survives a server restart or coming back from another device.
    req.session.cart = rows[0].saved_cart || {};
    return res.redirect('/catalog');
  }

  req.session.pendingName = name;
  res.redirect('/register');
});

app.get('/register', (req, res) => {
  if (!req.session.pendingName) return res.redirect('/');
  res.render('register', {
    name: req.session.pendingName,
    error: null,
    companyNameValue: '',
    addressValue: '',
    phoneValue: '',
    emailValue: ''
  });
});

app.post('/register', async (req, res) => {
  const name = req.session.pendingName;
  if (!name) return res.redirect('/');
  const companyName = (req.body.companyName || '').trim();
  const address = (req.body.address || '').trim();
  const phone = (req.body.phone || '').trim();
  const email = (req.body.email || '').trim();

  if (!companyName || !address || !phone) {
    return res.render('register', {
      name,
      error: 'Company name, address, and phone are all required.',
      companyNameValue: companyName,
      addressValue: address,
      phoneValue: phone,
      emailValue: email
    });
  }

  let rows;
  try {
    ({ rows } = await pool.query(
      `INSERT INTO customers (name, company_name, address, phone, email) VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, companyName, address, phone, email || null]
    ));
  } catch (err) {
    if (err.code !== '23505') throw err; // 23505 = name already taken
    delete req.session.pendingName;
    return res.render('start', { error: `The name "${name}" is already registered. Please enter it again to continue.` });
  }

  req.session.customerId = rows[0].id;
  req.session.customerName = rows[0].name;
  delete req.session.pendingName;
  res.redirect('/catalog');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ---------- Customer profile ----------

app.get('/profile', requireCustomer, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1', [
    req.session.customerId
  ]);
  const customer = rows[0];
  res.render('profile', {
    customer,
    saved: false,
    error: null,
    companyNameValue: customer.company_name || '',
    addressValue: customer.address || '',
    phoneValue: customer.phone || '',
    emailValue: customer.email || ''
  });
});

app.post('/profile', requireCustomer, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1', [
    req.session.customerId
  ]);
  const customer = rows[0];

  const companyName = (req.body.companyName || '').trim();
  const address = (req.body.address || '').trim();
  const phone = (req.body.phone || '').trim();
  const email = (req.body.email || '').trim();

  if (!companyName || !address || !phone) {
    return res.render('profile', {
      customer,
      saved: false,
      error: 'Company name, address, and phone are all required.',
      companyNameValue: companyName,
      addressValue: address,
      phoneValue: phone,
      emailValue: email
    });
  }

  await pool.query(
    `UPDATE customers SET company_name = $1, address = $2, phone = $3, email = $4 WHERE id = $5`,
    [companyName, address, phone, email || null, req.session.customerId]
  );

  res.render('profile', {
    customer: { ...customer, company_name: companyName, address, phone, email },
    saved: true,
    error: null,
    companyNameValue: companyName,
    addressValue: address,
    phoneValue: phone,
    emailValue: email
  });
});

// ---------- Catalog & cart ----------

app.get('/catalog', requireCustomer, async (req, res) => {
  const q = (req.query.q || '').trim();
  const specialsOnly = req.query.tab === 'specials';
  const perPage = 50;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * perPage;

  const conditions = [];
  const params = [];

  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(description ILIKE $${params.length} OR product_code ILIKE $${params.length})`);
  }
  if (specialsOnly) {
    conditions.push('special_price IS NOT NULL');
  }
  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRes = await pool.query(`SELECT count(*) FROM products ${whereSql}`, params);
  const totalCount = Number(countRes.rows[0].count);

  const listParams = [...params, perPage, offset];
  const { rows } = await pool.query(
    `SELECT id, product_code, description, unit_of_measure, unit_price, case_price,
            special_price, special_case_price,
            (image_data IS NOT NULL) AS has_image
     FROM products ${whereSql}
     ORDER BY lower(product_code) LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );

  const specialsCountRes = await pool.query('SELECT count(*) FROM products WHERE special_price IS NOT NULL');

  const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
  const cartCount = cartArray(req.session).reduce((sum, i) => sum + i.qty, 0);

  // Work out what one "buying unit" costs (a whole case for CASE items).
  const products = rows.map((r) => ({ ...r, ...pricing(r) }));

  res.render('catalog', {
    products,
    q,
    specialsOnly,
    specialsCount: Number(specialsCountRes.rows[0].count),
    totalCount,
    page,
    totalPages,
    cartCount,
    customerName: req.session.customerName
  });
});

app.post('/cart/add', requireCustomer, async (req, res) => {
  const productId = parseProductId(req.body.productId);
  const qty = Math.max(1, parseInt(req.body.qty, 10) || 1);
  if (productId) {
    req.session.cart = req.session.cart || {};
    req.session.cart[productId] = (req.session.cart[productId] || 0) + qty;
    await persistCart(req);
  }
  const params = new URLSearchParams();
  if (req.body.q) params.set('q', req.body.q);
  if (req.body.page) params.set('page', req.body.page);
  if (req.body.tab) params.set('tab', req.body.tab);
  const qs = params.toString();
  res.redirect('/catalog' + (qs ? `?${qs}` : ''));
});

app.post('/cart/update', requireCustomer, async (req, res) => {
  const productId = parseProductId(req.body.productId);
  if (!productId) return res.redirect('/cart');
  const qty = Math.max(0, parseInt(req.body.qty, 10) || 0);
  req.session.cart = req.session.cart || {};
  if (qty === 0) delete req.session.cart[productId];
  else req.session.cart[productId] = qty;
  await persistCart(req);
  res.redirect('/cart');
});

app.post('/cart/remove', requireCustomer, async (req, res) => {
  const productId = parseProductId(req.body.productId);
  if (req.session.cart) delete req.session.cart[productId];
  await persistCart(req);
  res.redirect('/cart');
});

async function loadCartItems(session) {
  const entries = cartArray(session);
  if (entries.length === 0) return [];
  const ids = entries.map((e) => e.productId);
  const { rows } = await pool.query(
    `SELECT id, product_code, description, unit_of_measure, unit_price, case_price,
            special_price, special_case_price, (image_data IS NOT NULL) AS has_image
     FROM products WHERE id = ANY($1::int[])`,
    [ids]
  );
  // Skip anything no longer in the catalog rather than ordering "Unknown product".
  return entries.filter((e) => rows.some((r) => r.id === e.productId)).map((e) => {
    const p = rows.find((r) => r.id === e.productId);
    // CASE items are charged per case, EACH items per unit, and the special
    // price is used whenever one is currently set on the product.
    const pr = p ? pricing(p) : null;
    return {
      id: e.productId,
      qty: e.qty,
      product_code: p ? p.product_code : 'UNKNOWN',
      description: p ? p.description : 'Unknown product',
      unit_price: pr ? pr.price : 0,
      uom: pr ? pr.uom : 'EACH',
      per: pr ? pr.per : 'each',
      sub: pr ? pr.sub : '',
      regular_price: pr ? pr.regularPrice : 0,
      on_special: pr ? pr.onSpecial : false,
      has_image: p ? p.has_image : false
    };
  });
}

app.get('/cart', requireCustomer, async (req, res) => {
  const items = await loadCartItems(req.session);
  const total = items.reduce((sum, i) => sum + i.qty * i.unit_price, 0);
  res.render('cart', { items, total });
});

// ---------- Order submission ----------

app.post('/order/submit', requireCustomer, async (req, res) => {
  const items = await loadCartItems(req.session);
  if (items.length === 0) return res.redirect('/cart');

  const total = items.reduce((sum, i) => sum + i.qty * i.unit_price, 0);
  const reference = (req.body.reference || '').trim() || null;

  const { rows } = await pool.query(
    `INSERT INTO orders (customer_id, items, total, reference) VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.session.customerId, JSON.stringify(items), total, reference]
  );
  const order = rows[0];

  const customerRes = await pool.query('SELECT * FROM customers WHERE id = $1', [
    req.session.customerId
  ]);
  const customer = customerRes.rows[0];

  req.session.cart = {};
  await persistCart(req);

  // Fire off emails — don't block the customer's page if email fails
  try {
    const pdfBuffer = await generateQuotePdf({ order, customer, items, companyName: COMPANY_NAME });

    if (customer.email) {
      await sendEmail({
        to: customer.email,
        subject: `Your quote #${order.id} from ${COMPANY_NAME}`,
        html: `<p>Hi ${escapeHtml(customer.name)},</p><p>Thanks for your order. Your quote is attached.</p>${
          order.reference ? `<p>Reference: ${escapeHtml(order.reference)}</p>` : ''
        }<p>Total: $${total.toFixed(2)}</p>`,
        attachments: [{ filename: `quote-${order.id}.pdf`, content: pdfBuffer }]
      });
    }

    if (ADMIN_EMAIL) {
      const csv = toCsv(
        items.map((i) => ({
          order_id: order.id,
          customer: customer.name,
          product_code: i.product_code,
          description: i.description,
          qty: i.qty,
          unit: i.uom || '',
          unit_price: i.unit_price.toFixed(2),
          line_total: (i.qty * i.unit_price).toFixed(2)
        })),
        ['order_id', 'customer', 'product_code', 'description', 'qty', 'unit', 'unit_price', 'line_total']
      );

      await sendEmail({
        to: ADMIN_EMAIL,
        subject: `New order #${order.id} — ${customer.name} — $${total.toFixed(2)}`,
        html: `<p>New order from <b>${escapeHtml(customer.name)}</b>${
          customer.company_name ? ` (${escapeHtml(customer.company_name)})` : ''
        } — ${escapeHtml(customer.phone)}, ${escapeHtml(customer.address)}.</p>${
          order.reference ? `<p>Reference: ${escapeHtml(order.reference)}</p>` : ''
        }<p>Total: $${total.toFixed(2)}</p>`,
        attachments: [
          { filename: `order-${order.id}.csv`, content: Buffer.from(csv, 'utf-8') },
          { filename: `order-${order.id}.pdf`, content: pdfBuffer }
        ]
      });
    }
  } catch (err) {
    console.error('Email sending failed (order was still saved):', err);
  }

  res.redirect(`/quote/${order.id}`);
});

app.get('/quote/:id', requireCustomer, async (req, res) => {
  if (!parseProductId(req.params.id)) return res.redirect('/catalog');
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order || order.customer_id !== req.session.customerId) return res.redirect('/catalog');

  const customerRes = await pool.query('SELECT * FROM customers WHERE id = $1', [
    order.customer_id
  ]);
  res.render('quote', { order, customer: customerRes.rows[0], items: order.items });
});

app.get('/quote/:id/pdf', async (req, res) => {
  if (!parseProductId(req.params.id)) return res.status(404).send('Not found');
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).send('Not found');

  // Either the owning customer, or an admin, may download this quote
  const isOwner = req.session.customerId === order.customer_id;
  const isAdmin = req.session.isAdmin && req.query.admin === '1';
  if (!isOwner && !isAdmin) return res.status(403).send('Forbidden');

  const customerRes = await pool.query('SELECT * FROM customers WHERE id = $1', [
    order.customer_id
  ]);
  const pdfBuffer = await generateQuotePdf({
    order,
    customer: customerRes.rows[0],
    items: order.items,
    companyName: COMPANY_NAME
  });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="quote-${order.id}.pdf"`);
  res.send(pdfBuffer);
});

// ---------- Admin ----------

app.get('/admin/login', (req, res) => res.render('admin-login', { error: null }));

app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.render('admin-login', { error: 'Wrong password.' });
});

app.get('/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin/login');
});

app.get('/admin', requireAdmin, async (req, res) => {
  const [customers, products, orders, specials, missingPhotos, recent] = await Promise.all([
    pool.query('SELECT count(*) FROM customers'),
    pool.query('SELECT count(*) FROM products'),
    pool.query('SELECT count(*) FROM orders'),
    pool.query('SELECT count(*) FROM products WHERE special_price IS NOT NULL'),
    pool.query('SELECT count(*) FROM products WHERE image_data IS NULL'),
    pool.query(
      `SELECT o.*, c.name AS customer_name FROM orders o
       JOIN customers c ON c.id = o.customer_id
       ORDER BY o.created_at DESC LIMIT 15`
    )
  ]);
  res.render('admin-dashboard', {
    counts: {
      customers: customers.rows[0].count,
      products: products.rows[0].count,
      orders: orders.rows[0].count,
      specials: specials.rows[0].count,
      missingPhotos: missingPhotos.rows[0].count
    },
    recentOrders: recent.rows
  });
});

app.get('/admin/customers', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM customers ORDER BY created_at DESC');
  res.render('admin-customers', { customers: rows });
});

app.get('/admin/customers/export.csv', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM customers ORDER BY name');
  const csv = toCsv(rows, ['id', 'name', 'company_name', 'address', 'phone', 'email', 'created_at']);
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="customers.csv"');
  res.send(csv);
});

app.get('/admin/orders', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, c.name AS customer_name FROM orders o
     JOIN customers c ON c.id = o.customer_id
     ORDER BY o.created_at DESC`
  );
  res.render('admin-orders', { orders: rows });
});

app.get('/admin/orders/export.csv', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, c.name AS customer_name FROM orders o
     JOIN customers c ON c.id = o.customer_id
     ORDER BY o.created_at DESC`
  );
  const lines = [];
  for (const o of rows) {
    for (const item of o.items) {
      lines.push({
        order_id: o.id,
        date: new Date(o.created_at).toISOString(),
        customer: o.customer_name,
        reference: o.reference || '',
        product_code: item.product_code,
        description: item.description,
        qty: item.qty,
        unit: item.uom || '',
        unit_price: item.unit_price.toFixed(2),
        line_total: (item.qty * item.unit_price).toFixed(2)
      });
    }
  }
  const csv = toCsv(lines, [
    'order_id',
    'date',
    'customer',
    'reference',
    'product_code',
    'description',
    'qty',
    'unit',
    'unit_price',
    'line_total'
  ]);
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send(csv);
});

// ---------- Monthly specials ----------
// A specials upload REPLACES the current specials list: every product's
// special_price is cleared first, then set for just the uploaded codes.
// That way last month's specials never linger if you forget to remove one.

async function loadSpecials() {
  const result = await pool.query(
    `SELECT product_code, description, unit_of_measure, unit_price, case_price,
            special_price, special_case_price
     FROM products WHERE special_price IS NOT NULL ORDER BY lower(product_code)`
  );
  return result;
}

app.get('/admin/specials', requireAdmin, async (req, res) => {
  const { rows } = await loadSpecials();
  res.render('admin-specials', { specials: rows, result: null, error: null });
});

app.post('/admin/specials/upload', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) {
    const { rows } = await loadSpecials();
    return res.render('admin-specials', { specials: rows, result: null, error: 'Please choose a CSV file first.' });
  }

  let records;
  try {
    records = parse(req.file.buffer.toString('utf-8'), { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    const { rows } = await loadSpecials();
    return res.render('admin-specials', {
      specials: rows,
      result: null,
      error: `Could not read that file as CSV: ${err.message}`
    });
  }

  const client = await pool.connect();
  let matched = 0;
  const notFound = [];
  try {
    await client.query('BEGIN');
    // Clear every existing special before applying the new list.
    await client.query(
      'UPDATE products SET special_price = NULL, special_case_price = NULL WHERE special_price IS NOT NULL'
    );

    // Column names are matched ignoring case/spacing, e.g. "Special_Price".
    const field = (row, name) => {
      const key = Object.keys(row).find((k) => k.trim().toLowerCase() === name);
      return key === undefined ? undefined : row[key];
    };

    for (const row of records) {
      const code = String(field(row, 'product_code') || '').trim();
      const price = parseFloat(field(row, 'special_price'));
      if (!code || isNaN(price)) continue;
      // Optional: the special price for a whole case (CASE items). When it's
      // left out, the app works it out from the per-unit special price.
      const casePriceParsed = parseFloat(field(row, 'special_case_price'));
      const casePrice = isNaN(casePriceParsed) ? null : casePriceParsed;

      const result = await client.query(
        'UPDATE products SET special_price = $1, special_case_price = $2 WHERE product_code = $3',
        [price, casePrice, code]
      );
      if (result.rowCount > 0) matched++;
      else notFound.push(code);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    const { rows } = await loadSpecials();
    return res.render('admin-specials', { specials: rows, result: null, error: `Import failed: ${err.message}` });
  }
  client.release();

  const { rows } = await loadSpecials();
  res.render('admin-specials', {
    specials: rows,
    error: null,
    result: {
      matched,
      notFoundCount: notFound.length,
      notFoundSample: notFound.slice(0, 10)
    }
  });
});

app.post('/admin/specials/clear', requireAdmin, async (req, res) => {
  await pool.query(
    'UPDATE products SET special_price = NULL, special_case_price = NULL WHERE special_price IS NOT NULL'
  );
  res.redirect('/admin/specials');
});

// ---------- Bulk photo import by link ----------
// Paste in any loose list of "product code ... photo link" lines (any
// separator — space, comma, dash) and this downloads each photo and stores
// it against the matching product, just like the normal catalog photos.

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

app.get('/admin/photos', requireAdmin, async (req, res) => {
  const missingRes = await pool.query('SELECT count(*) FROM products WHERE image_data IS NULL');
  res.render('admin-photos', {
    result: null,
    error: null,
    linksValue: '',
    missingCount: Number(missingRes.rows[0].count)
  });
});

app.post('/admin/photos/upload', requireAdmin, async (req, res) => {
  const text = (req.body.links || '').trim();
  const missingRes = await pool.query('SELECT count(*) FROM products WHERE image_data IS NULL');
  const missingCount = Number(missingRes.rows[0].count);

  if (!text) {
    return res.render('admin-photos', {
      result: null,
      error: 'Paste at least one line with a product code and a photo link.',
      linksValue: text,
      missingCount
    });
  }

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const parsed = [];
  const skipped = [];
  for (const line of lines) {
    const urlMatch = line.match(/https?:\/\/\S+/);
    if (!urlMatch) {
      skipped.push(line);
      continue;
    }
    const url = urlMatch[0];
    const rest = line.replace(url, '').trim();
    const code = (rest.split(/[\s,;:|]+/).filter(Boolean)[0] || '').trim();
    if (!code) {
      skipped.push(line);
      continue;
    }
    parsed.push({ code, url });
  }

  let matched = 0;
  const notFound = [];
  const failed = [];

  await mapWithConcurrency(parsed, 4, async ({ code, url }) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      let response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        failed.push(`${code} (HTTP ${response.status})`);
        return;
      }
      const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
      if (!contentType.startsWith('image/')) {
        failed.push(`${code} (link isn't an image: ${contentType || 'unknown type'})`);
        return;
      }
      const buffer = Buffer.from(await response.arrayBuffer());

      const result = await pool.query(
        'UPDATE products SET image_data = $1, image_mime = $2 WHERE product_code = $3',
        [buffer, contentType, code]
      );
      if (result.rowCount > 0) matched++;
      else notFound.push(code);
    } catch (err) {
      failed.push(`${code} (${err.message})`);
    }
  });

  const newMissingRes = await pool.query('SELECT count(*) FROM products WHERE image_data IS NULL');

  res.render('admin-photos', {
    error: null,
    linksValue: '',
    missingCount: Number(newMissingRes.rows[0].count),
    result: {
      matched,
      notFoundCount: notFound.length,
      notFoundSample: notFound.slice(0, 10),
      failedCount: failed.length,
      failedSample: failed.slice(0, 10),
      skippedCount: skipped.length,
      skippedSample: skipped.slice(0, 10)
    }
  });
});

// ---------- Errors ----------

app.use((req, res) => res.status(404).send('Page not found. <a href="/">Go to the start page</a>'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`Error on ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return;
  res
    .status(500)
    .send('Sorry, something went wrong. Please go back and try again in a moment. <a href="/">Start page</a>');
});

// ---------- Startup ----------

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
