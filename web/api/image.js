// GET /api/image?url=...&site=...
// Fetches one product image so the browser can zip it (the CDN does not
// reliably allow cross-origin reads). One image per request keeps every
// invocation far inside the function time limit.
//
// Shopify images sit on the Shopify CDN, but WooCommerce serves them from the
// store's own domain (/wp-content/uploads/...), so the host cannot be a fixed
// allowlist. Two guards replace it:
//   1. the host must be the Shopify CDN, or the site the user is scraping;
//   2. it must not resolve to a private/loopback address.
// Without (2) this endpoint would be an open proxy into whatever network it
// runs in - "same host as the site param" is not a real check on its own,
// because the caller chooses both values.

import dns from "node:dns/promises";
import net from "node:net";
import { USER_AGENT, normaliseSite } from "./_stores.js";

const SHOPIFY_CDN = /(^|\.)(shopify\.com|shopifycdn\.com|myshopify\.com)$/i;

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||                 // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||       // carrier NAT
      a >= 224                                    // multicast / reserved
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true;
  if (/^(fc|fd|fe8|fe9|fea|feb)/.test(v6)) return true;   // ULA / link-local
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateAddress(mapped[1]) : false;
}

async function resolvesToPrivate(hostname) {
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    return addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address));
  } catch {
    return true;                                  // unresolvable: refuse
  }
}

function hostAllowed(target, site) {
  if (SHOPIFY_CDN.test(target.hostname)) return true;
  if (!site) return false;

  try {
    const store = new URL(normaliseSite(site)).hostname.replace(/^www\./, "");
    const host = target.hostname.replace(/^www\./, "");
    return host === store || host.endsWith("." + store);
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  let target;
  try {
    target = new URL(req.query.url);
  } catch {
    return res.status(400).json({ error: "Bad image url." });
  }

  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return res.status(403).json({ error: "Only http(s) images are allowed." });
  }
  if (!hostAllowed(target, req.query.site)) {
    return res
      .status(403)
      .json({ error: "Image host does not belong to the store being scraped." });
  }
  if (await resolvesToPrivate(target.hostname)) {
    return res.status(403).json({ error: "Refusing to fetch a private address." });
  }

  try {
    const upstream = await fetch(target.href, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "error",              // a redirect could hop past the checks above
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Image ${upstream.status}` });
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length <= 500) {
      return res.status(422).json({ error: "Image too small - skipped." });
    }

    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "application/octet-stream"
    );
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.status(200).send(buf);
  } catch (e) {
    res.status(502).json({ error: e.message || String(e) });
  }
}
