# Product Data Scraper

Pulls **Product Name, Price, Image** plus every product image from a store,
into `images/` + `products.xlsx` + `products.csv`.

Works on **Shopify**, **WooCommerce (WordPress)** and **Odoo** stores. The
platform is detected from the link, so the only thing you ever type is the
website address.

## Three ways to run it

| | Command | Where the files land |
| --- | --- | --- |
| Web UI (local) | `python server.py` -> http://127.0.0.1:8001 | straight to a folder on this PC |
| Desktop app | `python app.py` | straight to a folder on this PC |
| Vercel | see `web/README.md` | browser downloads a ZIP |

First time only:

```bash
pip install -r requirements.txt
```

## What you get

A folder named after the store is created inside whichever output folder you
picked (default `Desktop\Scraped Products`):

```
tglcompany-com\            <- whole store
  images\
  products.xlsx            <- Product Name, Price, Image
  products.csv
tglcompany-com-luggage\    <- a collection run, kept separate
```

## The two inputs

- **Website link** - `tglcompany.com`, or any full page URL from the store.
  Detection retries with and without `www.`, because the two hostnames are not
  always the same site.
- **Collection / category** - optional. Empty means every product. Otherwise a
  Shopify collection, a WooCommerce category or an Odoo category, given as a
  bare handle, a path or a full URL:
  `luggage` | `/collections/luggage` | `/product-category/mugs` |
  `/shop/category/bags-travel-181`

## Files

| File | Role |
| --- | --- |
| `scraper.py` | All the scraping. The other three front ends only call `scrape()`. |
| `server.py` | FastAPI server + JSON API (`/api/scrape`, `/api/jobs/...`). |
| `static/index.html` | The web UI `server.py` serves. |
| `app.py` | Tkinter desktop app. |
| `web/` | The Vercel deployment - a JS port of `scraper.py`. See its README. |

`scraper.py` is the single source of truth for Python; `web/api/_stores.js` is
a direct port of it. **Change one, change the other**, or the deployed version
drifts from the local one.

## Limits worth knowing

- **Shopify** - `/products.json` is always public, so these always work.
- **WooCommerce** - needs the Store API at `/wp-json/wc/store/v1/products`.
  Owners can switch it off and security plugins often do, so roughly half the
  WordPress shops tested did not respond.
- **Odoo** - has no product API, so it is scraped from the `/shop` HTML: one
  page fetch per product. A 1500-product Odoo store takes a long time and is
  too slow for Vercel's Hobby plan (10s function limit) - run it locally.
- Prices are whatever the store publishes. Some B2B catalogues hide them
  entirely (giftsnpromo shows "Not Available For Sale" on every product), and
  no scraper can recover what is not on the page.
- Not supported: Amazon, Flipkart, Myntra, Nykaa and similar. They have no
  public product API and actively block scrapers.
