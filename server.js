require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { pool, initSchema } = require('./db');
const { toCsv } = require('./lib/csv');
const { generateQuotePdf } = require('./lib/quote-pdf');
const { sendEmail } = require('./lib/email');

const app = express();
const COMPANY_NAME = process.env.COMPANY_NAME || 'Our Catalog';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

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
  return Object.entries(session.cart || {}).map(([productId, qty]) => ({
    productId: Number(productId),
    qty
  }));
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
    return res.redirect('/catalog');
  }

  req.session.pendingName = name;
  res.redirect('/register');
});

app.get('/register', (req, res) => {
  if (!req.session.pendingName) return res.redirect('/');
  res.render('register', { name: req.session.pendingName });
});

app.post('/register', async (req, res) => {
  const name = req.session.pendingName;
  if (!name) return res.redirect('/');
  const { address, phone, email } = req.body;

  const { rows } = await pool.query(
    `INSERT INTO customers (name, address, phone, email) VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [name, address, phone, email || null]
  );

  req.session.customerId = rows[0].id;
  req.session.customerName = rows[0].name;
  delete req.session.pendingName;
  res.redirect('/catalog');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ---------- Catalog & cart ----------

app.get('/catalog', requireCustomer, async (req, res) => {
  const q = (req.query.q || '').trim();
  const perPage = 50;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * perPage;

  let countRes, rows;

  if (q) {
    countRes = await pool.query(
      `SELECT count(*) FROM products WHERE description ILIKE $1 OR product_code ILIKE $1`,
      [`%${q}%`]
    );
    ({ rows } = await pool.query(
      `SELECT id, product_code, description, unit_of_measure, unit_price,
              (image_data IS NOT NULL) AS has_image
       FROM products
       WHERE description ILIKE $1 OR product_code ILIKE $1
       ORDER BY lower(product_code) LIMIT $2 OFFSET $3`,
      [`%${q}%`, perPage, offset]
    ));
  } else {
    countRes = await pool.query('SELECT count(*) FROM products');
    ({ rows } = await pool.query(
      `SELECT id, product_code, description, unit_of_measure, unit_price,
              (image_data IS NOT NULL) AS has_image
       FROM products ORDER BY lower(product_code) LIMIT $1 OFFSET $2`,
      [perPage, offset]
    ));
  }

  const totalCount = Number(countRes.rows[0].count);
  const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
  const cartCount = cartArray(req.session).reduce((sum, i) => sum + i.qty, 0);

  res.render('catalog', {
    products: rows,
    q,
    totalCount,
    page,
    totalPages,
    cartCount,
    customerName: req.session.customerName
  });
});

app.post('/cart/add', requireCustomer, (req, res) => {
  const productId = req.body.productId;
  const qty = Math.max(1, parseInt(req.body.qty, 10) || 1);
  req.session.cart = req.session.cart || {};
  req.session.cart[productId] = (req.session.cart[productId] || 0) + qty;
  const params = new URLSearchParams();
  if (req.body.q) params.set('q', req.body.q);
  if (req.body.page) params.set('page', req.body.page);
  const qs = params.toString();
  res.redirect('/catalog' + (qs ? `?${qs}` : ''));
});

app.post('/cart/update', requireCustomer, (req, res) => {
  const productId = req.body.productId;
  const qty = Math.max(0, parseInt(req.body.qty, 10) || 0);
  req.session.cart = req.session.cart || {};
  if (qty === 0) delete req.session.cart[productId];
  else req.session.cart[productId] = qty;
  res.redirect('/cart');
});

app.post('/cart/remove', requireCustomer, (req, res) => {
  const productId = req.body.productId;
  if (req.session.cart) delete req.session.cart[productId];
  res.redirect('/cart');
});

async function loadCartItems(session) {
  const entries = cartArray(session);
  if (entries.length === 0) return [];
  const ids = entries.map((e) => e.productId);
  const { rows } = await pool.query(
    `SELECT id, product_code, description, unit_price, (image_data IS NOT NULL) AS has_image
     FROM products WHERE id = ANY($1::int[])`,
    [ids]
  );
  return entries.map((e) => {
    const p = rows.find((r) => r.id === e.productId);
    return {
      id: e.productId,
      qty: e.qty,
      product_code: p ? p.product_code : 'UNKNOWN',
      description: p ? p.description : 'Unknown product',
      unit_price: p ? Number(p.unit_price) : 0,
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

  const { rows } = await pool.query(
    `INSERT INTO orders (customer_id, items, total) VALUES ($1, $2, $3) RETURNING *`,
    [req.session.customerId, JSON.stringify(items), total]
  );
  const order = rows[0];

  const customerRes = await pool.query('SELECT * FROM customers WHERE id = $1', [
    req.session.customerId
  ]);
  const customer = customerRes.rows[0];

  req.session.cart = {};

  // Fire off emails — don't block the customer's page if email fails
  try {
    const pdfBuffer = await generateQuotePdf({ order, customer, items, companyName: COMPANY_NAME });

    if (customer.email) {
      await sendEmail({
        to: customer.email,
        subject: `Your quote #${order.id} from ${COMPANY_NAME}`,
        html: `<p>Hi ${customer.name},</p><p>Thanks for your order. Your quote is attached.</p><p>Total: $${total.toFixed(
          2
        )}</p>`,
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
          unit_price: i.unit_price.toFixed(2),
          line_total: (i.qty * i.unit_price).toFixed(2)
        })),
        ['order_id', 'customer', 'product_code', 'description', 'qty', 'unit_price', 'line_total']
      );

      await sendEmail({
        to: ADMIN_EMAIL,
        subject: `New order #${order.id} — ${customer.name} — $${total.toFixed(2)}`,
        html: `<p>New order from <b>${customer.name}</b> (${customer.phone}, ${customer.address}).</p><p>Total: $${total.toFixed(
          2
        )}</p>`,
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
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order || order.customer_id !== req.session.customerId) return res.redirect('/catalog');

  const customerRes = await pool.query('SELECT * FROM customers WHERE id = $1', [
    order.customer_id
  ]);
  res.render('quote', { order, customer: customerRes.rows[0], items: order.items });
});

app.get('/quote/:id/pdf', async (req, res) => {
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
  const [customers, products, orders, recent] = await Promise.all([
    pool.query('SELECT count(*) FROM customers'),
    pool.query('SELECT count(*) FROM products'),
    pool.query('SELECT count(*) FROM orders'),
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
      orders: orders.rows[0].count
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
  const csv = toCsv(rows, ['id', 'name', 'address', 'phone', 'email', 'created_at']);
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
        product_code: item.product_code,
        description: item.description,
        qty: item.qty,
        unit_price: item.unit_price.toFixed(2),
        line_total: (item.qty * item.unit_price).toFixed(2)
      });
    }
  }
  const csv = toCsv(lines, [
    'order_id',
    'date',
    'customer',
    'product_code',
    'description',
    'qty',
    'unit_price',
    'line_total'
  ]);
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send(csv);
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
