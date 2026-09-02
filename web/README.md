# Product Scraper - web version

The same scraper as `app.py`, rebuilt to run on Vercel.

## Deploy

```bash
npm i -g vercel
cd web
npm install       # cheerio, used to parse Odoo product pages
vercel            # first run: links/creates the project
vercel --prod     # deploys to your live URL
```

If you deploy through the Vercel dashboard (Git import) instead, set
**Root Directory** to `web`. No build command and no env vars; Vercel runs
`npm install` for you.

Run it locally first with `vercel dev` (serves the page and the functions
together at http://localhost:3000).

## How it works

| File | Role |
| --- | --- |
| `public/index.html` | The UI. Also does the zipping and builds the xlsx/csv. |
| `api/products.js` | `GET /api/products?site=&collection=` - the product list. |
| `api/image.js` | `GET /api/image?url=&site=` - fetches one image. |
| `api/product.js` | `GET /api/product?url=&site=` - one Odoo product page. |
| `api/_stores.js` | Shared logic; a direct port of `../scraper.py`. |

The work is split this way because **serverless functions time out** (10s on
Hobby, 60s on Pro). Scraping 100+ products and 600+ images in a single request
would never finish. Instead each request is small - one product-list call, then
one call per image, six at a time - and the browser drives the loop. That also
means no ceiling on store size and a real progress bar.

## What you get

Chrome and Edge ask once for a folder when you press Start, then write each
file into it as it downloads:

```
<the folder you chose>/
  example-com/
    images/
    products.xlsx    <- Product Name, Price, Image
    products.csv
```

Nothing accumulates in memory, so there is no ceiling on store size and
nothing to unzip - the same shape `app.py` produces locally. A collection run
saves under `example-com-luggage/` so runs never overwrite each other.

Browsers without the folder picker (Firefox, Safari) download ZIPs instead,
and so does cancelling the picker. Those split at ~300 MB into
`example-com-part1.zip`, `example-com-part2.zip` and so on: unzip them all
into the same folder and the `images/` directories merge. The spreadsheets
ride in the **last** part, the only one written after every row is known, and
list every image across every part. The splitting is not cosmetic - a finished
part is written out and dropped, which is what keeps a large store inside the
browser's memory.

## Notes and limits

- **Shopify, WooCommerce (WordPress) and Odoo stores.** The platform is
  detected automatically: Shopify's `/products.json`, else Woo's Store API at
  `/wp-json/wc/store/v1/products`, else an Odoo `/shop` page. Anything else is
  refused with a message. Detection retries with and without `www.` - the two
  hostnames are not always the same site.
- Woo's Store API can be switched off by the site owner (security plugins
  often do), so some WordPress shops simply will not respond.
- Odoo has no product API, so each product costs a page fetch through
  `/api/product` (six at a time from the browser). A 1500-product Odoo store
  is therefore much slower than a Shopify one, and shows two progress passes:
  product pages first, then images.
- `api/image.js` proxies only the Shopify CDN or the store's own domain, and
  refuses any host resolving to a private address. Do not loosen either check
  - together they are what stops it being an open proxy into the network it
  runs in.
- Vercel caps a function response at ~4.5 MB, so an unusually large source
  image is skipped and logged rather than silently dropped.
- The folder picker needs the click's user activation, so it is opened from the
  Start handler rather than inside `run()`. By the time the product list comes
  back that activation has expired and the call would be rejected.
- On the ZIP fallback the archive is assembled from the generator's chunks
  rather than with `generateAsync({type:"blob"})`. That call concatenates the
  whole archive into one contiguous `Uint8Array` first, which throws
  `Array buffer allocation failed` on a store of a few GB. Between the chunked
  assembly and the 300 MB split, peak memory is one part rather than the whole
  run.
- On the ZIP fallback the browser asks once for permission to download multiple
  files. Declining it loses every part after the first.
