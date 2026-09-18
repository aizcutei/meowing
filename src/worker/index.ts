/**
 * Cloudflare Worker entrypoint.
 *
 * Two things are worth knowing about the shape of this API:
 *
 *  - `/sub` is stateless. The upstream URLs and any non-default options are
 *    packed into the link itself, so there is no KV namespace to provision and
 *    the link keeps working for as long as the upstream subscription does. That
 *    is what makes it usable both as a QR code and as an auto-updating remote
 *    profile.
 *  - `/api/convert` is for the UI. It returns the config plus warnings and
 *    statistics so the page can show what happened, and the `/sub` link the user
 *    should actually keep.
 */

import { Hono } from "hono";
import { renderSVG } from "uqr";

import { ClashParseError } from "../core/clash";
import { ConversionError, convertClashToSingBox } from "../core/convert";
import {
  DEFAULT_OPTIONS,
  InvalidSubscriptionUrl,
  buildSubscriptionPath,
  normaliseOptions,
  parseSubscriptionParams,
  type ConvertOptions,
} from "../core/options";
import { SINGBOX_TARGET_VERSION } from "../core/singbox";
import {
  SubscriptionFetchError,
  fetchSubscription,
  mergeClashDocuments,
  type FetchedSubscription,
} from "./subscription";

interface Env {
  /** When set as a secret, callers must present it. Empty means open access. */
  ACCESS_TOKEN?: string;
}

const app = new Hono<{ Bindings: Env }>();

/* ------------------------------------------------------------------- errors */

interface ApiError {
  error: string;
  detail?: string;
}

function errorResponse(err: unknown): { body: ApiError; status: 400 | 422 | 500 | 502 } {
  if (err instanceof InvalidSubscriptionUrl) {
    return { body: { error: "Invalid subscription URL", detail: err.message }, status: 400 };
  }
  if (err instanceof SubscriptionFetchError) {
    return {
      body: { error: "Could not fetch the subscription", detail: err.message },
      status: err.status === 422 ? 422 : 502,
    };
  }
  if (err instanceof ClashParseError) {
    return { body: { error: "Not a usable Clash config", detail: err.message }, status: 422 };
  }
  if (err instanceof ConversionError) {
    return { body: { error: "Conversion failed", detail: err.message }, status: 422 };
  }
  console.error("unhandled error", err);
  return {
    body: {
      error: "Unexpected server error",
      detail: err instanceof Error ? err.message : String(err),
    },
    status: 500,
  };
}

/* --------------------------------------------------------------------- auth */

/**
 * Optional shared-secret gate. Deployments that are not meant to be public set
 * `ACCESS_TOKEN` as a secret; the token can arrive as a bearer header or as a
 * `token` query parameter, since a QR-scanned URL cannot carry headers.
 */
function checkAuth(c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }, env: Env): Response | undefined {
  const expected = env.ACCESS_TOKEN?.trim();
  if (!expected) return undefined;

  const header = c.req.header("authorization");
  const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
  const supplied = bearer ?? c.req.query("token");

  if (supplied && timingSafeEqual(supplied, expected)) return undefined;
  return Response.json(
    { error: "Unauthorized", detail: "This instance requires an access token." },
    { status: 401 },
  );
}

/** Constant-time comparison, so the token cannot be recovered byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  // Compare a fixed number of bytes regardless of length.
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) {
    diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}

/* ------------------------------------------------------------------ helpers */

async function loadSources(
  urls: string[],
  yaml: string | undefined,
): Promise<{ text: string; fetched: FetchedSubscription[] }> {
  if (yaml && yaml.trim() !== "") {
    return { text: yaml, fetched: [] };
  }
  if (urls.length === 0) {
    throw new InvalidSubscriptionUrl("Provide at least one subscription URL, or paste a config.");
  }
  // Fetch concurrently, but surface the first failure rather than a partial merge.
  const fetched = await Promise.all(urls.map((url) => fetchSubscription(url)));
  return { text: mergeClashDocuments(fetched), fetched };
}

function configFilename(fetched: FetchedSubscription[]): string {
  const name = fetched[0]?.profileName?.replace(/\.(ya?ml|txt|json)$/i, "");
  const safe = name?.replace(/[^\w\u4e00-\u9fa5.-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe && safe.length > 0 ? `${safe}.json` : "sing-box.json";
}

/* ------------------------------------------------------------------- routes */

app.get("/api/health", (c) =>
  c.json({ ok: true, singBoxTarget: SINGBOX_TARGET_VERSION, defaults: DEFAULT_OPTIONS }),
);

/**
 * Converts a subscription and returns everything the UI needs to render a
 * result: the config, what was dropped, and the durable `/sub` link.
 */
app.post("/api/convert", async (c) => {
  const unauthorized = checkAuth(c, c.env);
  if (unauthorized) return unauthorized;

  let payload: { urls?: unknown; yaml?: unknown; options?: unknown };
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be JSON" } satisfies ApiError, 400);
  }

  const urls = Array.isArray(payload.urls)
    ? payload.urls.filter((u): u is string => typeof u === "string" && u.trim() !== "")
    : [];
  const yaml = typeof payload.yaml === "string" ? payload.yaml : undefined;
  const { options, rejected } = normaliseOptions(payload.options ?? {});

  try {
    const { text, fetched } = await loadSources(urls, yaml);
    const result = convertClashToSingBox(text, options);

    const subPath = urls.length > 0 ? buildSubscriptionPath(urls, options) : undefined;
    const origin = new URL(c.req.url).origin;

    return c.json({
      config: result.config,
      warnings: [...rejected, ...result.warnings],
      stats: result.stats,
      filename: configFilename(fetched),
      // Only URL-backed conversions get a live link; a pasted config has no
      // upstream for a client to poll, so the UI offers download only.
      subscription: subPath
        ? { path: subPath, url: `${origin}${subPath}` }
        : null,
      upstream: fetched.map((f) => ({ url: f.url, userInfo: f.userInfo ?? null })),
      singBoxTarget: SINGBOX_TARGET_VERSION,
    });
  } catch (err) {
    const { body, status } = errorResponse(err);
    return c.json(body, status);
  }
});

/**
 * The stateless subscription endpoint. This is the URL that goes into a QR code
 * and into a sing-box client's remote-profile field.
 */
app.get("/sub", async (c) => {
  const unauthorized = checkAuth(c, c.env);
  if (unauthorized) return unauthorized;

  const params = new URL(c.req.url).searchParams;
  const { urls, options, rejected } = parseSubscriptionParams(params);

  try {
    const { text, fetched } = await loadSources(urls, undefined);
    const result = convertClashToSingBox(text, options);
    const body = JSON.stringify(result.config, null, 2);

    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      // Clients re-fetch this URL to update; never let a proxy pin it.
      "cache-control": "no-store",
      "content-disposition": params.has("download")
        ? `attachment; filename="${configFilename(fetched)}"`
        : "inline",
      // Surfaced as response headers so a client (or curl) can see what was
      // dropped without the warnings polluting the config itself.
      "x-meowing-nodes": String(result.stats.proxiesOut),
      "x-meowing-rules": `${result.stats.rulesIn}->${result.stats.rulesOut}`,
      "x-meowing-warnings": String(rejected.length + result.warnings.length),
    });
    // Pass the provider's quota information through so clients can display it.
    const userInfo = fetched.find((f) => f.userInfo)?.userInfo;
    if (userInfo) headers.set("subscription-userinfo", userInfo);

    return new Response(body, { headers });
  } catch (err) {
    const { body, status } = errorResponse(err);
    return c.json(body, status);
  }
});

/**
 * Renders a QR code as SVG.
 *
 * Server-side so the client bundle stays small, and so the image can be saved or
 * shared straight from the browser's context menu.
 */
app.get("/api/qr", (c) => {
  const data = c.req.query("d");
  if (!data) return c.json({ error: "Missing `d` parameter" } satisfies ApiError, 400);
  // Version 40 at error-correction level L tops out near 2953 bytes.
  if (data.length > 2000) {
    return c.json({ error: "Too much data to encode in a QR code" } satisfies ApiError, 400);
  }

  try {
    const svg = renderSVG(data, { border: 2, ecc: "M" });
    return new Response(svg, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    const { body, status } = errorResponse(err);
    return c.json(body, status);
  }
});

/** Lets the UI build a `/sub` link without duplicating the packing logic. */
app.post("/api/link", async (c) => {
  const unauthorized = checkAuth(c, c.env);
  if (unauthorized) return unauthorized;

  let payload: { urls?: unknown; options?: unknown };
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be JSON" } satisfies ApiError, 400);
  }
  const urls = Array.isArray(payload.urls)
    ? payload.urls.filter((u): u is string => typeof u === "string" && u.trim() !== "")
    : [];
  if (urls.length === 0) {
    return c.json({ error: "At least one subscription URL is required" } satisfies ApiError, 400);
  }
  const { options } = normaliseOptions(payload.options ?? {});
  const path = buildSubscriptionPath(urls, options as ConvertOptions);
  return c.json({ path, url: `${new URL(c.req.url).origin}${path}` });
});

export default app;
