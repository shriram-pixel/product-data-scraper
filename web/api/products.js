// GET /api/products?site=...&collection=...
// Returns the rows plus, for each product, the image URLs and target filenames.
// Fast: one upstream call per page of products, so it stays inside the time limit.

import {
  normaliseSite,
  cleanCollection,
  folderName,
  resolvePlatform,
  collectProducts,
  buildRow,
} from "./_stores.js";

export default async function handler(req, res) {
  try {
    const collection = cleanCollection(req.query.collection);

    // resolvePlatform may switch to the www. host, so use what it returns.
    const { platform, site } = await resolvePlatform(normaliseSite(req.query.site));
    const { items } = await collectProducts(site, collection, platform);

    // One counter for the whole run, so a repeated title is numbered rather
    // than overwriting the first product's files. Not `items.map(buildRow)`:
    // map would hand the array index over as the counter.
    const seen = new Map();
    const rows = items.map((item) => buildRow(item, seen));

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      site,
      platform,
      collection,
      folder: folderName(site, collection),
      count: rows.length,
      imageCount: rows.reduce((n, r) => n + r._files.length, 0),
      // Odoo rows have no images yet - the browser must hydrate them first.
      needsDetail: platform === "odoo",
      rows,
    });
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
}
