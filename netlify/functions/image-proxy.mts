// Image proxy for the catalog's Excel export.
//
// The export needs to read each product image's bytes in the browser, but the image host does not send a
// CORS header, so the browser refuses. This function fetches the image server-side (where CORS does not apply)
// and returns it from the catalog's own origin.
//
// Usage: /.netlify/functions/image-proxy?url=<encoded image URL>
//
// Safety: only https URLs on the hosts below are fetched, redirects are re-checked against the same list,
// and only image responses under the size cap are returned -- so this cannot be used to fetch arbitrary sites.

// Exact host names that are allowed.
const ALLOWED_HOSTS = new Set<string>([
  // Add other image hosts here if the console shows more CORS errors, e.g. "media.surewerx.com".
]);
// Domains where the domain itself and any subdomain are allowed (the image vendor uses several hosts, e.g.
// asset.productmarketingcloud.com and asset-prod1a-use.productmarketingcloud.com).
const ALLOWED_DOMAINS = ["productmarketingcloud.com"];

const hostAllowed = (host: string) => {
  const h = host.toLowerCase();
  return ALLOWED_HOSTS.has(h) || ALLOWED_DOMAINS.some((d) => h === d || h.endsWith("." + d));
};

// Buffered function responses are capped at ~6 MB by Netlify, but streamed responses can be larger (~20 MB),
// so the image is streamed through instead of being loaded into memory first.
const MAX_BYTES = 18 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const bad = (status: number, message: string) =>
  new Response(message, { status, headers: { "content-type": "text/plain", "cache-control": "no-store" } });

function parseAllowed(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    if (!hostAllowed(u.hostname)) return null;
    return u;
  } catch {
    return null;
  }
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "GET") return bad(405, "Method not allowed");

  const target = new URL(req.url).searchParams.get("url");
  if (!target) return bad(400, "Missing url parameter");

  let current = parseAllowed(target);
  if (!current) return bad(400, "URL host is not allowed");

  try {
    let res: Response | null = null;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      res = await fetch(current.toString(), { redirect: "manual", headers: { accept: "image/*" } });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        const next = parseAllowed(new URL(res.headers.get("location")!, current).toString());
        if (!next) return bad(400, "Redirect target is not allowed");
        current = next;
        continue;
      }
      break;
    }
    if (!res || !res.ok) return bad(502, `Upstream returned ${res ? res.status : "no response"}`);

    const type = res.headers.get("content-type") || "";
    if (!type.toLowerCase().startsWith("image/")) return bad(415, "Upstream response is not an image");

    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) return bad(413, "Image too large");
    if (!res.body) return bad(502, "Upstream returned no data");

    // Stream the body through, counting bytes so an upstream with no Content-Length still cannot exceed the cap.
    let seen = 0;
    const limiter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > MAX_BYTES) { controller.error(new Error("Image too large")); return; }
        controller.enqueue(chunk);
      },
    });

    // Content-Length is deliberately not forwarded: fetch may have decompressed the body, so it could be wrong.
    const headers: Record<string, string> = { "content-type": type, "cache-control": "public, max-age=86400" };
    return new Response(res.body.pipeThrough(limiter), { status: 200, headers });
  } catch (err) {
    return bad(502, "Could not fetch image");
  }
};
