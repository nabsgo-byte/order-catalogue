[README.md](https://github.com/user-attachments/files/32542626/README.md)
# Catalog order app

A small ordering app: customers identify themselves by name, browse your
product catalog (with photos), submit an order, and get a PDF quote. You
get an email for every order with a CSV and PDF attached, and an admin
dashboard to browse customers/orders and export CSVs any time.

Included: your `Conglom_EASTGEN_Price_January_26__2026.xlsx` catalog,
already cleaned into `scripts/products.csv` (1,131 products), plus 1,120
product photos extracted from that same file into `scripts/images/`.

## If you already deployed this app (adding photos to an existing app)

You don't need to start over — just two things:

1. **Update the code on GitHub.** In your existing repo, replace these
   files with the versions in this folder (open each one on GitHub, click
   the pencil/edit icon, delete the contents, paste in the new version, and
   commit — or use "Upload files" and drop the new copies in, which
   overwrites files with the same name):
   - `db.js`
   - `server.js`
   - `scripts/seed-products.js`
   - `views/catalog.ejs`
   - `views/cart.ejs`
   - `public/style.css`

   Render will auto-redeploy once it sees the change. **Do not** upload
   `scripts/images/` to GitHub — it's 1,120 files and isn't needed there;
   see the next step instead.

2. **Load the photos into your database.** On your own computer, in the
   same `catalog-order-app` folder you already ran `npm run seed` from
   before: replace its `scripts/products.csv` and add its `scripts/images/`
   folder using the copies from this download, then run the same command
   as before:

   ```bash
   DATABASE_URL="<your Render database URL>" npm run seed
   ```

   This re-uses your existing products (no duplicates) and attaches a
   photo to each one. It'll print something like
   `Done. 0 new products, 1131 updated, 1120 photos loaded.` when finished.

   Photos are stored inside the database itself (not as files on Render),
   so they survive redeploys even on the free tier, which has no
   persistent disk.

Refresh your app's catalog page afterwards — you should see thumbnails.

## Full setup (if starting from scratch)

## What you need (all free to start)

1. A [Render](https://render.com) account — hosts the app and the database.
2. A [Resend](https://resend.com) account — sends the emails. Free tier
   covers far more than 200 orders/month.

### 1. Deploy the database

In Render: **New > PostgreSQL**. Free tier is fine to start (note: Render's
free Postgres expires after 30 days — for a real business you'll want to
upgrade it to the $7/mo Starter plan before that happens, from the same
dashboard). Once created, copy the **Internal Database URL** (for the app
on Render) and the **External Database URL** (for running the seed script
from your own computer).

### 2. Deploy the app

1. Push this folder to a GitHub repository — except `scripts/images/`,
   which doesn't need to go to GitHub (see above).
2. In Render: **New > Web Service**, point it at the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Under **Environment**, add every variable from `.env.example`, using
   your real values (the **Internal** database URL from step 1, a Resend
   API key, your own admin password, etc).
5. Deploy. Render gives you a URL like `https://your-app.onrender.com`.
6. Free web services sleep after 15 minutes of inactivity and take
   30-60 seconds to wake up on the next visit — the Starter plan ($7/mo)
   removes that.

### 3. Load your product catalog and photos

Once deployed, run the seed script **once** from your own computer (or
Render's shell) pointed at the production database, using the **External**
database URL this time:

```bash
DATABASE_URL="<your Render External Database URL>" npm run seed
```

Whenever your supplier sends a new price list: export it to the same
5-column CSV format (`product_code,description,unit_of_measure,unit_price,case_price`),
replace `scripts/products.csv`, and run `npm run seed` again — it updates
existing products and adds new ones without duplicating anything, and
leaves existing photos alone if you don't also supply new images.

### 4. Set up email

- Sign up at Resend, verify your sending domain (or leave `FROM_EMAIL` as
  `onboarding@resend.dev` for testing — real customers should see your own
  domain eventually).
- Copy your Resend API key into the `RESEND_API_KEY` environment variable
  on Render.
- Set `ADMIN_EMAIL` to the address that should receive every new order.

If `RESEND_API_KEY` is left blank, the app still works — it just skips
sending email (useful for testing locally) and logs what it would have sent.

## How customers use it

1. They visit your app's URL and type their name.
2. First time: they're asked for delivery address, phone, and (optional)
   email.
3. They search the catalog, add items to their cart, and submit.
4. They see and can download their quote as a PDF. If they gave an email,
   it's sent to them automatically too.
5. You get an email immediately with the order as CSV + PDF attached.

## Admin dashboard

Visit `/admin/login` and enter the `ADMIN_PASSWORD` you set. From there:
customer list + CSV export, order list + CSV export, and a PDF of any
individual quote.

## Known limitations (v1)

- No customer password — anyone who knows an existing customer's name can
  see that customer's cart and place orders as them. Fine for a private
  link shared only with your own customers; not suitable if the link could
  leak publicly. Ask me if you'd like real logins added later.
- Session/cart data resets if the free web service restarts. Orders
  already submitted are safe (they're in the database) — only an
  in-progress, not-yet-submitted cart could be lost.
- The catalog search is a simple text match on product code/description —
  fine at ~1,100-3,000 products, but if your catalog grows much larger,
  it may need a faster search index.
- 11 of the 1,131 products had no photo embedded in the original price
  list, so they'll show a "no photo" placeholder.
