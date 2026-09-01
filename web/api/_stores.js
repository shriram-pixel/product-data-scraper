import { load } from "cheerio";

// Shared scraping logic - a JS port of ../../scraper.py.
//
// Shopify      /products.json                    (always on, cannot be disabled)
// WooCommerce  /wp-json/wc/store/v1/products     (Store API, can be switched off)
// Odoo         /shop HTML                        (no API exists)
//
// All are normalised to: { title, slug, price, imageUrls, colour, totalImages }

const HASH_SUFFIX =
  /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export function squash(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stem(url) {
  const path = new URL(url, "https://x").pathname;
  return (path.split("/").pop() || "").replace(/\.[^.]*$/, "");
}

export function filenameKey(url) {
  return squash(stem(url).replace(HASH_SUFFIX, ""));
}

export function getExtension(url) {
  const m = new URL(url, "https://x").pathname.match(/(\.[a-z0-9]+)$/i);
  return m ? m[1] : ".jpg";
}

/** 'tglcompany.com/collections/x' -> 'https://www.tglcompany.com' (origin only). */
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

/** tglcompany.com + 'luggage' -> 'tglcompany-com-luggage' */
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
 * The two hostnames are not always the same site: giftsnpromo.com serves a
 * 404 for /shop while www.giftsnpromo.com serves the shop.
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

/** Return 1/2/3 for the option slot holding colour, else null. */
function findColourPosition(product) {
  const options = product.options || [];
  for (let i = 0; i < options.length; i++) {
    const name = (options[i].name || "").trim().toLowerCase();
    if (name === "color" || name === "colour") return i + 1;
  }
  return null;
}

/**
 * Which colour does this filename belong to?
 * Longest match wins so 'Dark Green' beats 'Green'.
 * Returns null for shared assets (no colour in the name).
 */
function matchColour(url, colours) {
  const key = filenameKey(url);
  const hits = colours.filter((c) => squash(c) && key.includes(squash(c)));
  if (!hits.length) return null;
  return hits.reduce((a, b) => (squash(b).length > squash(a).length ? b : a));
}

/**
 * Every image for the first variant's colour.
 *
 * variant_ids alone is not enough: Shopify only lists images explicitly
 * attached to a variant, so infographics / size charts get missed. Stores
 * usually name files by colour (Green3.jpg, infographics-green-1.jpg), so
 * match on the filename and use variant_ids only as a fallback.
 */
function defaultColourImages(product) {
  const variants = product.variants || [];
  const images = product.images || [];
  if (!variants.length || !images.length) return { images, colour: "" };

  const first = variants[0];
  const pos = findColourPosition(product);
  if (!pos) return { images, colour: "" }; // single-colour product: take everything

  const key = `option${pos}`;
  const colour = first[key] || "";
  const colours = [...new Set(variants.map((v) => v[key]).filter(Boolean))];

  // variants sharing this colour (Green/Cabin, Green/Check-in, ...)
  const ids = new Set(variants.filter((v) => v[key] === colour).map((v) => v.id));

  let keep = [];
  for (const img of images) {
    const owner = matchColour(img.src, colours);
    if (owner === colour) keep.push(img); // Green3.jpg
    else if (owner !== null) continue; // Blue1.jpg -> skip
    else if ((img.variant_ids || []).some((id) => ids.has(id))) keep.push(img);
    // anything else (no colour in name, attached to nothing) is dropped
  }

  if (!keep.length) {
    keep = images.filter((i) => (i.variant_ids || []).some((id) => ids.has(id)));
    if (!keep.length) keep = images.slice(0, 1);
  }

  return { images: keep, colour };
}

function normaliseShopify(p) {
  const variants = p.variants || [];
  const first = variants[0] || {};
  const { images, colour } = defaultColourImages(p);

  return {
    // Base names on the handle, not the title: handles are unique per store
    // and two products can share a title - title-based names overwrite.
    slug: p.handle || p.title || "",
    title: p.title || "",
    price: first.price || "",
    imageUrls: images.map((img) => img.src),
    colour,
    totalImages: (p.images || []).length,
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
  $(".carousel-inner img").each((_, img) => {
    const raw = $(img).attr("src") || $(img).attr("data-src") || "";
    if (!raw) return;

    let src;
    try {
      src = new URL(raw.replace(/&amp;/g, "&"), site).href;
    } catch {
      return;
    }
    // the carousel serves thumbnails; ask for the full-size render instead
    src = src.replace(/\/image_(128|256|512|1024)\//, "/image_1920/");

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

/** One normalised product -> the row plus the image URLs and their filenames. */
export function buildRow(item) {
  const base = item.colour ? `${item.slug} ${item.colour}` : item.slug;
  const slug = createSlug(base);

  const files = item.imageUrls.map((raw, i) => {
    const url = String(raw).split("?")[0];
    return {
      url,
      name: i === 0 ? `${slug}${getExtension(url)}` : `${slug}-${i}${getExtension(url)}`,
    };
  });

  return {
    "Product Name": item.title,
    Price: item.price,
    Image: files.map((f) => f.name).join(","),
    _files: files,
    _colour: item.colour,
    _totalImages: item.totalImages,
    // Odoo rows arrive empty; the browser fills them in via /api/product.
    ...(item.detailUrl ? { _detail: item.detailUrl } : {}),
  };
}
