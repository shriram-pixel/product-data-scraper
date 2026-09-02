import { load } from "cheerio";

// Shared scraping logic - a JS port of ../../scraper.py.
//
// Shopify      /products.json                    (always on, cannot be disabled)
// WooCommerce  /wp-json/wc/store/v1/products     (Store API, can be switched off)
// Odoo         /shop HTML                        (no API exists)
//
// All are normalised to: { title, slug, price, imageUrls, colour, totalImages }

export const USER_AGENT = "Mozilla/5.0";
const WOO_API = "/wp-json/wc/store/v1";
const WOO_PER_PAGE = 100; // Store API caps per_page at 100
const SHOPIFY_PER_PAGE = 250; // products.json caps at 250
const ODOO_PER_PAGE = 200; // ?ppg=200 is honoured; the default is ~36

const ODOO_MARKER = /name="generator"\s+content="Odoo"|\/web\/image\/product\./i;

// /shop/cart, /shop/wishlist ... are not products
const ODOO_NON_PRODUCT = new Set([
  "cart", "wishlist", "checkout", "compare", "change_pricelist", "payment",
  "address", "confirmation", "extra_info", "page", "category",
]);

const get = (url) => fetch(url, { headers: { "User-Agent": USER_AGENT } });

export function createSlug(text) {
  return (text || "")
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 150);
}

export function getExtension(url) {
  const m = new URL(url, "https://x").pathname.match(/(\.[a-z0-9]+)$/i);
  return m ? m[1] : ".jpg";
}

/** 'example.com/collections/x' -> 'https://www.example.com' (origin only). */
export function normaliseSite(input) {
  let url = (input || "").trim();
  if (!url) throw new Error("Website link is required.");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Could not read a website address from: " + input);
  }
  if (!parsed.hostname)
    throw new Error("Could not read a website address from: " + input);
  return parsed.origin;
}

/**
 * Accept a bare handle, a path, or a full URL:
 *   'luggage' | '/collections/luggage' | '/product-category/mugs'
 *   | '/shop/category/bags-travel-181' | full URL
 */
export function cleanCollection(input) {
  let text = (input || "").trim().replace(/^\/+|\/+$/g, "");
  if (!text) return null;
  if (text.includes("://")) {
    try {
      text = new URL(text).pathname.replace(/^\/+|\/+$/g, "");
    } catch {
      /* fall through and treat it as a plain handle */
    }
  }
  // Strip repeatedly: Odoo nests them ('shop/category/bags-travel-181').
  const prefix = /^(collections|product-category|category|shop)\//i;
  while (prefix.test(text)) text = text.replace(prefix, "");

  return text.split("/")[0].split("?")[0] || null;
}

/** example.com + 'luggage' -> 'example-com-luggage' */
export function folderName(site, collection) {
  const host = new URL(site).hostname.replace(/^www\./, "");
  const name = createSlug(host.replace(/\./g, "-"));
  return collection ? `${name}-${createSlug(collection)}` : name;
}

// ---------------------------------------------------------------- detection

export async function detectPlatform(site) {
  try {
    const r = await get(`${site}/products.json?limit=1`);
    if (r.ok && Array.isArray((await r.json()).products)) return "shopify";
  } catch {
    /* not Shopify; try WooCommerce */
  }

  try {
    const r = await get(`${site}${WOO_API}/products?per_page=1`);
    if (r.ok && Array.isArray(await r.json())) return "woocommerce";
  } catch {
    /* not Woo; try Odoo */
  }

  try {
    const r = await get(`${site}/shop`);
    if (r.ok && ODOO_MARKER.test(await r.text())) return "odoo";
  } catch {
    /* fall through to the error below */
  }

  throw new Error(
    "Could not recognise this site. It is not a Shopify store, its " +
      "WooCommerce Store API is not reachable (owners can disable it, and " +
      "security plugins often do), and it has no Odoo /shop page. Only " +
      "Shopify, WooCommerce and Odoo stores are supported."
  );
}

/**
 * Detect the platform, retrying with/without 'www.'.
 *
 * The two hostnames are not always the same site: example-b2b.com serves a
 * 404 for /shop while www.example-b2b.com serves the shop.
 */
export async function resolvePlatform(site) {
  const url = new URL(site);
  const alt = url.hostname.toLowerCase().startsWith("www.")
    ? url.hostname.slice(4)
    : "www." + url.hostname;

  let firstError = null;
  for (const candidate of [site, `${url.protocol}//${alt}`]) {
    try {
      return { platform: await detectPlatform(candidate), site: candidate };
    } catch (e) {
      firstError = firstError || e;
    }
  }
  throw firstError;
}

// ------------------------------------------------------------------ Shopify

async function fetchShopify(site, collection) {
  const base = collection ? `${site}/collections/${collection}` : site;
  const products = [];
  const seen = new Set();

  for (let page = 1; page <= 40; page++) {
    const url = `${base}/products.json?limit=${SHOPIFY_PER_PAGE}&page=${page}`;
    const r = await get(url);

    if (!r.ok) {
      if (page === 1) {
        throw new Error(
          `The store returned ${r.status} for ${url}.` +
            (collection ? " Check the collection name." : "")
        );
      }
      break;
    }

    const batch = (await r.json()).products || [];
    if (!batch.length) break;

    for (const p of batch) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        products.push(p);
      }
    }

    if (batch.length < SHOPIFY_PER_PAGE) break; // last page
  }

  return products;
}

function normaliseShopify(p) {
  const variants = p.variants || [];
  const first = variants[0] || {};
  // Every image on the product. images[] is the full media set, including
  // shots attached to no variant at all (size charts, lifestyle, infographics),
  // so there is nothing further to look up.
  const imageUrls = (p.images || []).map((img) => img.src).filter(Boolean);

  return {
    // Base names on the handle, not the title: handles are unique per store
    // and two products can share a title - title-based names overwrite.
    slug: p.handle || p.title || "",
    title: p.title || "",
    price: first.price || "",
    imageUrls,
    colour: "",
    totalImages: imageUrls.length,
  };
}

// -------------------------------------------------------- WooCommerce (WP)

/** Store API filters by category id, so look the slug up first. */
async function resolveWooCategory(site, collection) {
  const wanted = collection.toLowerCase();

  for (let page = 1; page <= 20; page++) {
    const r = await get(
      `${site}${WOO_API}/products/categories?per_page=100&page=${page}`
    );
    if (!r.ok) break;

    const cats = await r.json();
    if (!cats.length) break;

    const hit = cats.find(
      (c) =>
        String(c.slug || "").toLowerCase() === wanted ||
        createSlug(c.name || "") === createSlug(collection)
    );
    if (hit) return hit.id;

    if (cats.length < 100) break;
  }

  throw new Error(
    `No product category '${collection}' on this site. Leave the field empty ` +
      "to scrape every product."
  );
}

async function fetchWoo(site, collection) {
  const categoryId = collection ? await resolveWooCategory(site, collection) : null;
  const products = [];

  for (let page = 1; page <= 100; page++) {
    let url = `${site}${WOO_API}/products?per_page=${WOO_PER_PAGE}&page=${page}`;
    if (categoryId) url += `&category=${categoryId}`;

    const r = await get(url);
    if (!r.ok) {
      if (page === 1) throw new Error(`The store returned ${r.status} for ${url}.`);
      break;
    }

    const batch = await r.json();
    if (!batch.length) break;
    products.push(...batch);

    const totalPages = Number(r.headers.get("X-WP-TotalPages") || 0);
    if (batch.length < WOO_PER_PAGE || (totalPages && page >= totalPages)) break;
  }

  return products;
}

/**
 * Store API returns MINOR units: {"price": "195", "currency_minor_unit": 2}
 * is 1.95, not 195. Getting this wrong multiplies every price by 100.
 */
export function wooPrice(prices) {
  if (!prices || typeof prices !== "object") return "";

  let amount = prices.price;
  if (amount === null || amount === undefined || amount === "") {
    amount = (prices.price_range || {}).min_amount; // variable product
  }
  if (amount === null || amount === undefined || amount === "") return "";

  const minor = prices.currency_minor_unit == null ? 2 : Number(prices.currency_minor_unit);
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);

  return (n / 10 ** minor).toFixed(minor);
}

/** Woo returns titles HTML-encoded: 'Silver &#8211; Topper' -> 'Silver - Topper' */
export function decodeEntities(text) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", hellip: "…", rsquo: "’",
    lsquo: "‘", ldquo: "“", rdquo: "”", trade: "™",
    reg: "®", copy: "©", deg: "°", eacute: "é",
  };
  return String(text || "").replace(
    /&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi,
    (whole, body) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      const hit = named[body.toLowerCase()];
      return hit === undefined ? whole : hit;
    }
  );
}

function normaliseWoo(p) {
  const imageUrls = (p.images || []).map((i) => i.src).filter(Boolean);
  const title = decodeEntities(p.name);

  let slug = p.slug;
  if (!slug && p.permalink) {
    try {
      slug = new URL(p.permalink).pathname.replace(/\/+$/, "").split("/").pop();
    } catch {
      /* keep the fallback below */
    }
  }

  return {
    slug: slug || title,
    title,
    price: wooPrice(p.prices),
    imageUrls,
    // No colour-in-filename convention on Woo, so every image is kept.
    colour: "",
    totalImages: imageUrls.length,
  };
}

// --------------------------------------------------------------------- Odoo
//
// Odoo has no public product API, so this is the one platform that needs HTML.
// Two traps the listing pages set:
//
//   1. Category URLs look exactly like product URLs - both end in '-<id>'
//      ('/shop/category/bags-travel-181'). Filtering on the suffix alone pulls
//      in ~70% category pages, which then scrape as junk products.
//   2. Past the last page Odoo serves the last page again instead of an empty
//      one, so "stop when the page is empty" never fires. Stop on "no new
//      links" instead.

// Where the gallery lives depends on the Odoo version and theme: older builds
// use a plain .carousel-inner, 15+ wraps it in #o-carousel-product with a
// separate thumbnail strip, and some themes render only a bare
// img.product_detail_img. Reading all of them and de-duplicating afterwards is
// what stops a product coming back with just its cover shot.
const ODOO_IMAGE_SELECTOR = [
  "#o-carousel-product img",
  ".carousel-inner img",
  ".o_carousel_product_indicators img",
  ".o_product_feature_panel img",
  "img.product_detail_img",
  ".oe_product_image img",
  'img[itemprop="image"]',
].join(", ");

// Lazy-loading themes leave src on a spacer and put the real URL in a data
// attribute, so the src-only read used to return one image or none.
const ODOO_IMAGE_ATTRS = [
  "src", "data-src", "data-zoom-image", "data-lazy-img-src", "data-original",
];

// Product images are always served from /web/image/...; this keeps theme
// chrome (logos, payment icons) out of the ZIP.
const ODOO_IMAGE_PATH = /^\/web\/image\//i;

export function odooIsProductPath(path) {
  const clean = path.replace(/\/+$/, "");
  if (!clean.startsWith("/shop/")) return false;

  const parts = clean.split("/");
  if (parts.length !== 3) return false; // /shop/<slug>-<id> and nothing deeper
  if (ODOO_NON_PRODUCT.has(parts[2])) return false;

  return /-\d+$/.test(clean); // every product URL ends in its id
}

export function odooPageUrl(site, collection, page) {
  let base = collection ? `${site}/shop/category/${collection}` : `${site}/shop`;
  if (page > 1) base = `${base}/page/${page}`;
  return `${base}?ppg=${ODOO_PER_PAGE}`;
}

async function fetchOdoo(site, collection) {
  const seen = new Set();
  const order = [];

  for (let page = 1; page <= 200; page++) {
    const url = odooPageUrl(site, collection, page);
    const r = await get(url);
    if (!r.ok) {
      if (page === 1) throw new Error(`The store returned ${r.status} for ${url}.`);
      break;
    }

    const $ = load(await r.text());
    let found = 0;

    $("a[href]").each((_, a) => {
      let path;
      try {
        path = new URL($(a).attr("href"), site).pathname; // links carry ?page=N
      } catch {
        return;
      }
      if (odooIsProductPath(path) && !seen.has(path)) {
        seen.add(path);
        order.push(path);
        found++;
      }
    });

    if (!found) break; // repeated last page, or a dead end
  }

  if (!order.length && collection) {
    throw new Error(
      `No products under category '${collection}'. Paste the category URL ` +
        "from the site, or leave the field empty for every product."
    );
  }

  return order.map((path) => ({ url: site + path }));
}

/** Only the URL is known up front; the detail page fills the rest in. */
function normaliseOdoo(p) {
  return {
    slug: p.url.replace(/\/+$/, "").split("/").pop(),
    title: "",
    price: "",
    imageUrls: [],
    colour: "",
    totalImages: 0,
    detailUrl: p.url, // marks the item as needing hydrateOdoo()
  };
}

/** Fetch one Odoo product page and fill in title, price and images. */
export async function hydrateOdoo(detailUrl) {
  const r = await get(detailUrl);
  if (!r.ok) throw new Error(`Product page ${r.status}`);

  const $ = load(await r.text());
  const site = new URL(detailUrl).origin;
  const slug = detailUrl.replace(/\/+$/, "").split("/").pop();

  const title = ($("h1").first().text() || slug).replace(/\s+/g, " ").trim();

  // Price: Odoo renders it in .oe_currency_value. B2B catalogues often hide
  // prices entirely, in which case the page says so and the column reflects it.
  let price = "";
  const money = $(".oe_currency_value").first().text().trim();
  if (money) price = money;
  else if ($.root().text().includes("Not Available For Sale"))
    price = "Not Available For Sale";

  const imageUrls = [];
  const seen = new Set();
  $(ODOO_IMAGE_SELECTOR).each((_, img) => {
    const el = $(img);
    const raw = (ODOO_IMAGE_ATTRS.map((a) => el.attr(a)).find((v) => v && v.trim()) || "").trim();
    if (!raw || raw.startsWith("data:")) return; // inline placeholder

    let src;
    try {
      src = new URL(raw.replace(/&amp;/g, "&"), site).href;
    } catch {
      return;
    }
    if (!ODOO_IMAGE_PATH.test(new URL(src).pathname)) return; // theme icon, logo

    // Thumbnails and the main shot are the same image at different sizes.
    // Upgrading first means the dedupe below collapses them to one entry.
    src = src.replace(/\/image_\d+\//, "/image_1920/");

    const key = src.split("?")[0];
    if (!seen.has(key)) {
      seen.add(key);
      imageUrls.push(src);
    }
  });

  return { slug, title, price, imageUrls, colour: "", totalImages: imageUrls.length };
}

// ----------------------------------------------------------------- pipeline

export async function collectProducts(site, collection, platform) {
  const kind = platform || (await detectPlatform(site));

  if (kind === "shopify") {
    return { platform: kind, items: (await fetchShopify(site, collection)).map(normaliseShopify) };
  }
  if (kind === "odoo") {
    return { platform: kind, items: (await fetchOdoo(site, collection)).map(normaliseOdoo) };
  }
  return { platform: kind, items: (await fetchWoo(site, collection)).map(normaliseWoo) };
}

/**
 * 'Zill Watch' -> ('Zill Watch', 'zill-watch'), so the files on disk read like
 * the Product Name column rather than like the store's URL handle.
 *
 * Titles repeat - the same watch in black and in white is two products - so
 * the second onward is numbered: 'Zill Watch 2' saved as zill-watch2.jpg. The
 * number is glued on without a hyphen deliberately: zill-watch-2.jpg is
 * already the third image of the first Zill Watch.
 *
 * `seen` counts the slugs used so far and is carried across a whole run.
 */
export function uniqueName(title, seen) {
  const base = createSlug(title) || "product";
  const n = (seen.get(base) || 0) + 1;
  seen.set(base, n);

  return n === 1 ? { name: title, base } : { name: `${title} ${n}`, base: `${base}${n}` };
}

/** One normalised product -> the row plus the image URLs and their filenames. */
export function buildRow(item, seen = new Map()) {
  const { name, base } = uniqueName(item.title || item.slug, seen);

  const files = item.imageUrls.map((raw, i) => {
    const url = String(raw).split("?")[0];
    return {
      url,
      name: i === 0 ? `${base}${getExtension(url)}` : `${base}-${i}${getExtension(url)}`,
    };
  });

  return {
    "Product Name": name,
    Price: item.price,
    Image: files.map((f) => f.name).join(","),
    _files: files,
    _totalImages: item.totalImages,
    // Odoo rows arrive empty; the browser fills them in via /api/product.
    ...(item.detailUrl ? { _detail: item.detailUrl } : {}),
  };
}
