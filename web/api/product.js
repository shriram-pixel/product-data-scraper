// GET /api/product?url=...&site=...
// Reads ONE Odoo product page and returns its name, price and image list.
//
// Odoo has no product API, so every product costs a page fetch. Doing 1500 of
// them inside /api/products would blow the function time limit, so the browser
// calls this once per product instead - same pattern as /api/image.

import { hydrateOdoo, buildRow, normaliseSite } from "./_stores.js";

export default async function handler(req, res) {
  let target;
  try {
    target = new URL(req.query.url);
  } catch {
    return res.status(400).json({ error: "Bad product url." });
  }

  // Same-store check as /api/image: this endpoint must not fetch arbitrary URLs.
  try {
    const store = new URL(normaliseSite(req.query.site)).hostname.replace(/^www\./, "");
    const host = target.hostname.replace(/^www\./, "");
    if (host !== store && !host.endsWith("." + store)) {
      return res.status(403).json({ error: "Product URL is not on the store being scraped." });
    }
  } catch {
    return res.status(400).json({ error: "Missing or bad site." });
  }

  try {
    const item = await hydrateOdoo(target.href);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ row: buildRow(item) });
  } catch (e) {
    res.status(502).json({ error: e.message || String(e) });
  }
}
