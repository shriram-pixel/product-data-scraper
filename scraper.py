"""
Product scraper core - Shopify, WooCommerce (WordPress) and Odoo.

Shopify and WooCommerce expose a public product JSON endpoint:

  Shopify      /products.json                    (always on, cannot be disabled)
  WooCommerce  /wp-json/wc/store/v1/products     (Store API, can be switched off)

Odoo has no product API, so it is scraped from the /shop HTML instead.

The platform is detected from the site itself, so the UI only ever asks for a
link. Everything downstream works on the normalised product dict built by
normalise_shopify() / normalise_woo() / normalise_odoo():

    {"title", "slug", "price", "image_urls", "colour", "total_images"}
"""

import html
import os
import re
import time
import requests
import pandas as pd
from urllib.parse import urljoin, urlparse

COLUMNS = ["Product Name", "Price", "Image"]
HEADERS = {"User-Agent": "Mozilla/5.0"}

WOO_API = "/wp-json/wc/store/v1"
WOO_PER_PAGE = 100          # Store API caps per_page at 100
SHOPIFY_PER_PAGE = 250      # products.json caps at 250
ODOO_PER_PAGE = 200         # ?ppg=200 is honoured; the default is ~36

ODOO_MARKER = re.compile(r'name="generator"\s+content="Odoo"|/web/image/product\.', re.I)

# /shop/cart, /shop/wishlist ... are not products
ODOO_NON_PRODUCT = {
    "cart", "wishlist", "checkout", "compare", "change_pricelist", "payment",
    "address", "confirmation", "extra_info", "page", "category",
}

# Shopify appends a uuid to duplicated filenames: Green3_1958a945-5a5d-...jpg
HASH_SUFFIX = re.compile(
    r"_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)


class Stopped(Exception):
    """Raised when the user presses Stop."""


class ScrapeError(Exception):
    """Something the user can act on: bad link, unsupported site, no such category."""


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def create_slug(text):
    text = (text or "").lower().strip().replace("&", "and")
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"\s+", "-", text)
    return re.sub(r"-+", "-", text).strip("-")[:150]


def get_extension(url):
    ext = os.path.splitext(urlparse(url).path)[1]
    return ext if ext else ".jpg"


def squash(text):
    """'Dark Green' -> 'darkgreen';  'infographics-green-1' -> 'infographicsgreen1'"""
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def filename_key(url):
    """CDN url -> comparable filename stem, with Shopify's uuid stripped."""
    stem = os.path.splitext(os.path.basename(urlparse(url).path))[0]
    return squash(HASH_SUFFIX.sub("", stem))


def normalise_site(url):
    """'example.com/collections/x' -> 'https://www.example.com' (origin only)."""
    url = (url or "").strip()
    if not url:
        raise ValueError("Website link is required.")
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    p = urlparse(url)
    if not p.netloc:
        raise ValueError("Could not read a website address from: " + url)
    return p.scheme + "://" + p.netloc


def clean_collection(text):
    """
    Accept a bare handle, a path, or a full URL:
      'luggage' | '/collections/luggage' | '/product-category/mugs'
      | '/shop/category/bags-travel-181' | full URL
    """
    text = (text or "").strip().strip("/")
    if not text:
        return None
    if "://" in text:
        text = urlparse(text).path.strip("/")

    # Strip repeatedly: Odoo nests them ('shop/category/bags-travel-181').
    prefix = re.compile(r"^(collections|product-category|category|shop)/", re.I)
    while prefix.match(text):
        text = prefix.sub("", text, count=1)

    return text.split("/")[0].split("?")[0] or None


def folder_name(site, collection):
    """example.com + 'luggage' -> 'example-com-luggage'"""
    host = urlparse(site).netloc.replace("www.", "")
    name = create_slug(host.replace(".", "-"))
    return f"{name}-{create_slug(collection)}" if collection else name


def _get(url, **kw):
    return requests.get(url, headers=HEADERS, timeout=30, **kw)


# --------------------------------------------------------------------------
# platform detection
# --------------------------------------------------------------------------

def detect_platform(site, log=print):
    """Return 'shopify', 'woocommerce' or 'odoo', or raise ScrapeError."""
    try:
        r = _get(f"{site}/products.json?limit=1")
        if r.ok and isinstance(r.json().get("products"), list):
            log("Platform:   Shopify")
            return "shopify"
    except Exception:
        pass                          # not Shopify; try WooCommerce

    try:
        r = _get(f"{site}{WOO_API}/products?per_page=1")
        if r.ok and isinstance(r.json(), list):
            log("Platform:   WooCommerce (WordPress)")
            return "woocommerce"
    except Exception:
        pass                          # not Woo; try Odoo

    try:
        r = _get(f"{site}/shop")
        if r.ok and ODOO_MARKER.search(r.text):
            log("Platform:   Odoo")
            return "odoo"
    except Exception:
        pass

    raise ScrapeError(
        "Could not recognise this site. It is not a Shopify store, its "
        "WooCommerce Store API is not reachable (owners can disable it, and "
        "security plugins often do), and it has no Odoo /shop page. Only "
        "Shopify, WooCommerce and Odoo stores are supported."
    )


def resolve_platform(site, log=print):
    """
    Detect the platform, retrying with/without 'www.'.

    The two hostnames are not always the same site: example-b2b.com serves a
    404 for /shop while www.example-b2b.com serves the shop. Typing the bare
    domain should still work.
    """
    parsed = urlparse(site)
    host = parsed.netloc
    alt = host[4:] if host.lower().startswith("www.") else "www." + host
    candidates = [site, f"{parsed.scheme}://{alt}"]

    first_error = None
    for candidate in candidates:
        try:
            platform = detect_platform(candidate, log)
            if candidate != site:
                log(f"  (using {candidate})")
            return platform, candidate
        except ScrapeError as e:
            first_error = first_error or e

    raise first_error


# --------------------------------------------------------------------------
# Shopify
# --------------------------------------------------------------------------

def fetch_shopify(site, collection, log, should_stop):
    """250 products per page max. collection None -> the whole store."""
    base = f"{site}/collections/{collection}" if collection else site
    products, seen, page = [], set(), 1

    while True:
        if should_stop():
            raise Stopped()

        url = f"{base}/products.json?limit={SHOPIFY_PER_PAGE}&page={page}"
        log(f"\nPage {page}: {url}")

        r = _get(url)
        if not r.ok:
            if page == 1:
                raise ScrapeError(
                    f"The store returned {r.status_code} for {url}."
                    + (" Check the collection name." if collection else "")
                )
            log(f"  status {r.status_code}")
            break

        batch = r.json().get("products", [])
        log(f"  products found: {len(batch)}")
        if not batch:
            break

        products.extend(p for p in batch if p["id"] not in seen)
        seen.update(p["id"] for p in batch)

        if len(batch) < SHOPIFY_PER_PAGE:          # last page
            break

        page += 1
        time.sleep(1)

    return products


def find_colour_position(product):
    """Return 1/2/3 for the option slot holding colour, else None."""
    for i, opt in enumerate(product.get("options", []), start=1):
        if opt.get("name", "").strip().lower() in ("color", "colour"):
            return i
    return None


def match_colour(url, colours):
    """
    Which colour does this filename belong to?
    Longest match wins so 'Dark Green' beats 'Green'.
    Returns None for shared assets (no colour in the name).
    """
    key = filename_key(url)
    hits = [c for c in colours if squash(c) and squash(c) in key]
    return max(hits, key=lambda c: len(squash(c))) if hits else None


def default_colour_images(product):
    """
    Every image for the first variant's colour.

    variant_ids alone is not enough: Shopify only lists images explicitly
    attached to a variant, so infographics / size charts get missed. Stores
    usually name files by colour (Green3.jpg, infographics-green-1.jpg), so
    match on the filename and use variant_ids only as a fallback.
    """
    variants = product.get("variants", [])
    images = product.get("images", [])

    if not variants or not images:
        return images, ""

    default = variants[0]
    pos = find_colour_position(product)

    if not pos:                       # single-colour product: take everything
        return images, ""

    colour = default.get(f"option{pos}") or ""
    colours = {v.get(f"option{pos}") for v in variants if v.get(f"option{pos}")}

    # variants sharing this colour (Green/Cabin, Green/Check-in, ...)
    ids = {v["id"] for v in variants if v.get(f"option{pos}") == colour}

    keep = []
    for img in images:
        owner = match_colour(img["src"], colours)

        if owner == colour:                                    # Green3.jpg
            keep.append(img)
        elif owner is not None:                                # Blue1.jpg -> skip
            continue
        elif set(img.get("variant_ids", [])) & ids:            # attached, unnamed
            keep.append(img)
        # anything else (no colour in name, attached to nothing) is dropped

    if not keep:                                               # nothing matched
        keep = [i for i in images if set(i.get("variant_ids", [])) & ids] or images[:1]

    return keep, colour


def normalise_shopify(p):
    variants = p.get("variants", [])
    first = variants[0] if variants else {}
    images, colour = default_colour_images(p)

    return {
        # Base names on the handle, not the title: handles are unique per store
        # and two products can share a title - title-based names overwrite.
        "slug": p.get("handle") or p.get("title", ""),
        "title": p.get("title", ""),
        "price": first.get("price", ""),
        "image_urls": [img["src"] for img in images],
        "colour": colour,
        "total_images": len(p.get("images", [])),
    }


# --------------------------------------------------------------------------
# WooCommerce (WordPress)
# --------------------------------------------------------------------------

def resolve_woo_category(site, collection, log):
    """Store API filters by category id, so look the slug up first."""
    wanted = collection.lower()
    page = 1

    while page <= 20:
        r = _get(f"{site}{WOO_API}/products/categories?per_page=100&page={page}")
        if not r.ok:
            break

        cats = r.json()
        if not cats:
            break

        for c in cats:
            if str(c.get("slug", "")).lower() == wanted or \
               create_slug(c.get("name", "")) == create_slug(collection):
                log(f"  category '{c['slug']}' -> id {c['id']} ({c.get('count', '?')} products)")
                return c["id"]

        if len(cats) < 100:
            break
        page += 1

    raise ScrapeError(
        f"No product category '{collection}' on this site. Leave the field "
        "empty to scrape every product."
    )


def fetch_woo(site, collection, log, should_stop):
    """100 products per page max. collection None -> the whole store."""
    category_id = resolve_woo_category(site, collection, log) if collection else None
    products, page = [], 1

    while True:
        if should_stop():
            raise Stopped()

        url = f"{site}{WOO_API}/products?per_page={WOO_PER_PAGE}&page={page}"
        if category_id:
            url += f"&category={category_id}"
        log(f"\nPage {page}: {url}")

        r = _get(url)
        if not r.ok:
            if page == 1:
                raise ScrapeError(f"The store returned {r.status_code} for {url}.")
            log(f"  status {r.status_code}")
            break

        batch = r.json()
        log(f"  products found: {len(batch)}")
        if not batch:
            break

        products.extend(batch)

        total_pages = int(r.headers.get("X-WP-TotalPages") or 0)
        if len(batch) < WOO_PER_PAGE or (total_pages and page >= total_pages):
            break

        page += 1
        time.sleep(1)

    return products


def woo_price(prices):
    """
    Store API returns MINOR units: {"price": "195", "currency_minor_unit": 2}
    is 1.95, not 195. Getting this wrong multiplies every price by 100.
    """
    if not isinstance(prices, dict):
        return ""

    amount = prices.get("price")
    if amount in (None, ""):
        rng = prices.get("price_range") or {}
        amount = rng.get("min_amount")            # variable product
    if amount in (None, ""):
        return ""

    minor = prices.get("currency_minor_unit")
    minor = 2 if minor is None else int(minor)

    try:
        return f"{int(amount) / (10 ** minor):.{minor}f}"
    except (TypeError, ValueError):
        return str(amount)


def normalise_woo(p):
    images = [img["src"] for img in p.get("images", []) if img.get("src")]

    # Woo returns titles HTML-encoded: 'Silver &#8211; Topper' -> 'Silver - Topper'
    title = html.unescape(p.get("name", ""))

    slug = p.get("slug")
    if not slug and p.get("permalink"):
        slug = urlparse(p["permalink"]).path.strip("/").split("/")[-1]

    return {
        "slug": slug or title,
        "title": title,
        "price": woo_price(p.get("prices")),
        "image_urls": images,
        # No colour-in-filename convention on Woo, so every image is kept.
        "colour": "",
        "total_images": len(images),
    }


# --------------------------------------------------------------------------
# Odoo
# --------------------------------------------------------------------------
#
# Odoo has no public product API, so this is the one platform that needs HTML.
# Two traps the listing pages set:
#
#   1. Category URLs look exactly like product URLs - both end in '-<id>'
#      ('/shop/category/bags-travel-181'). Filtering on the suffix alone pulls
#      in ~70% category pages, which then scrape as junk products.
#   2. Past the last page Odoo serves the last page again instead of an empty
#      one, so "stop when the page is empty" never fires. Stop on "no new
#      links" instead.

def odoo_is_product_path(path):
    path = path.rstrip("/")
    if not path.startswith("/shop/"):
        return False

    parts = path.split("/")
    if len(parts) != 3:                       # /shop/<slug>-<id> and nothing deeper
        return False
    if parts[2] in ODOO_NON_PRODUCT:
        return False

    return bool(re.search(r"-\d+$", path))    # every product URL ends in its id


def odoo_page_url(site, collection, page):
    base = f"{site}/shop/category/{collection}" if collection else f"{site}/shop"
    if page > 1:
        base = f"{base.rsplit('?', 1)[0]}/page/{page}"
    return f"{base}?ppg={ODOO_PER_PAGE}"


def fetch_odoo(site, collection, log, should_stop):
    """Walk /shop and collect product page URLs."""
    from bs4 import BeautifulSoup

    seen, order, page = set(), [], 1

    while page <= 200:
        if should_stop():
            raise Stopped()

        url = odoo_page_url(site, collection, page)
        log(f"\nPage {page}: {url}")

        r = _get(url)
        if not r.ok:
            if page == 1:
                raise ScrapeError(f"The store returned {r.status_code} for {url}.")
            log(f"  status {r.status_code}")
            break

        soup = BeautifulSoup(r.text, "html.parser")
        found = []
        for a in soup.find_all("a", href=True):
            path = urlparse(urljoin(site, a["href"])).path      # links carry ?page=N
            if odoo_is_product_path(path) and path not in seen:
                seen.add(path)
                found.append(path)

        log(f"  products found: {len(found)} new")
        if not found:                         # repeated last page, or a dead end
            break

        order.extend(found)
        page += 1
        time.sleep(0.5)

    if not order and collection:
        raise ScrapeError(
            f"No products under category '{collection}'. Paste the category "
            "URL from the site, or leave the field empty for every product."
        )

    return [{"url": site + p} for p in order]


def normalise_odoo(p):
    """Only the URL is known up front; the detail page fills the rest in."""
    slug = p["url"].rstrip("/").split("/")[-1]
    return {
        "slug": slug,
        "title": "",
        "price": "",
        "image_urls": [],
        "colour": "",
        "total_images": 0,
        "detail_url": p["url"],          # marks the item as needing hydrate_odoo()
    }


def hydrate_odoo(item):
    """Fetch one Odoo product page and fill in title, price and images."""
    from bs4 import BeautifulSoup

    r = _get(item["detail_url"])
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    site = "{0.scheme}://{0.netloc}".format(urlparse(item["detail_url"]))

    h1 = soup.find("h1")
    item["title"] = re.sub(r"\s+", " ", h1.get_text()).strip() if h1 else item["slug"]

    # Price: Odoo renders it in .oe_currency_value. B2B catalogues often hide
    # prices entirely, in which case the page says so and the column reflects it.
    money = soup.select_one(".oe_currency_value")
    text = soup.get_text(" ", strip=True)
    if money and money.get_text(strip=True):
        item["price"] = money.get_text(strip=True)
    elif "Not Available For Sale" in text:
        item["price"] = "Not Available For Sale"

    urls, seen = [], set()
    for img in soup.select(".carousel-inner img"):
        src = img.get("src") or img.get("data-src") or ""
        if not src:
            continue

        src = urljoin(site, src).replace("&amp;", "&")
        # the carousel serves thumbnails; ask for the full-size render instead
        src = re.sub(r"/image_(128|256|512|1024)/", "/image_1920/", src)

        key = src.split("?")[0]
        if key not in seen:
            seen.add(key)
            urls.append(src)

    item["image_urls"] = urls
    item["total_images"] = len(urls)
    return item


# --------------------------------------------------------------------------
# shared pipeline
# --------------------------------------------------------------------------

def collect_products(site, collection, log, should_stop, platform=None):
    """Detect the platform (unless told) and return (platform, normalised products)."""
    if not platform:
        platform, site = resolve_platform(site, log)

    if platform == "shopify":
        return platform, [normalise_shopify(p)
                          for p in fetch_shopify(site, collection, log, should_stop)]

    if platform == "odoo":
        return platform, [normalise_odoo(p)
                          for p in fetch_odoo(site, collection, log, should_stop)]

    return platform, [normalise_woo(p)
                      for p in fetch_woo(site, collection, log, should_stop)]


CONTENT_TYPE_EXT = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
    "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif",
    "image/svg+xml": ".svg",
}


def download_images(image_urls, base_name, image_folder, log, should_stop):
    names = []
    slug = create_slug(base_name)

    for i, url in enumerate(image_urls):
        if should_stop():
            raise Stopped()

        url = str(url)
        try:
            r = _get(url)                            # keep the query: Odoo's
            if r.status_code != 200 or len(r.content) <= 500:   # ?unique= is part
                continue                                        # of the real URL

            # Odoo image URLs carry no extension, so fall back to what the
            # server actually sent rather than guessing .jpg for a png.
            ext = os.path.splitext(urlparse(url.split("?")[0]).path)[1]
            if not ext:
                mime = r.headers.get("Content-Type", "").split(";")[0].strip().lower()
                ext = CONTENT_TYPE_EXT.get(mime, ".jpg")

            name = f"{slug}{ext}" if i == 0 else f"{slug}-{i}{ext}"
            with open(os.path.join(image_folder, name), "wb") as f:
                f.write(r.content)

            log(f"  image: {name}")
            names.append(name)
        except Exception as e:
            log(f"  image error: {e}")

        time.sleep(0.2)

    return names


def parse_product(item, image_folder, log, should_stop):
    if item.get("detail_url"):          # Odoo: everything lives on the detail page
        hydrate_odoo(item)

    colour = item["colour"]
    label = f"{item['slug']} {colour}".strip() if colour else item["slug"]

    log(f"Scraping: {item['title']} | default colour: {colour or 'n/a'} "
        f"| {len(item['image_urls'])}/{item['total_images']} images")

    image_names = download_images(
        item["image_urls"], label, image_folder, log, should_stop
    )

    return {
        "Product Name": item["title"],
        "Price": item["price"],
        "Image": ",".join(image_names),
    }


def scrape(site, collection, base_output_dir, log=print, should_stop=lambda: False):
    """
    Run the whole job. Creates <base_output_dir>/<site-collection>/ containing
    images/, products.xlsx and products.csv. Returns the folder path.
    """
    site = normalise_site(site)
    collection = clean_collection(collection)

    out_dir = os.path.join(base_output_dir, folder_name(site, collection))
    image_folder = os.path.join(out_dir, "images")
    os.makedirs(image_folder, exist_ok=True)

    log(f"Site:       {site}")
    log(f"Collection: {collection or 'ALL PRODUCTS'}")
    log(f"Folder:     {out_dir}")

    platform, site = resolve_platform(site, log)      # may switch to www.
    _, items = collect_products(site, collection, log, should_stop, platform)
    log(f"\nTotal products: {len(items)}")

    rows = []
    try:
        for i, item in enumerate(items, 1):
            log(f"\n{i}/{len(items)}")
            try:
                rows.append(parse_product(item, image_folder, log, should_stop))
            except Stopped:
                raise
            except Exception as e:
                log(f"Product error: {e}")
            time.sleep(0.3)
    except Stopped:
        log("\nStopped - saving what was scraped so far...")

    excel_path = os.path.join(out_dir, "products.xlsx")
    csv_path = os.path.join(out_dir, "products.csv")

    df = pd.DataFrame(rows, columns=COLUMNS)      # exact columns, exact order
    df.to_excel(excel_path, index=False)
    df.to_csv(csv_path, index=False, encoding="utf-8-sig")

    log("\nDone!")
    log(f"Platform: {platform}")
    log(f"Excel:  {excel_path}")
    log(f"CSV:    {csv_path}")
    log(f"Images: {image_folder}")
    log(f"Rows:   {len(rows)}")

    return out_dir
