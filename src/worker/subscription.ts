/**
 * Fetching upstream Clash subscriptions.
 *
 * Everything here is defensive: the Worker fetches URLs supplied by whoever
 * calls it, so requests are bounded in time and size, redirects are capped, and
 * the response is checked for being a Clash document before it reaches the
 * converter.
 */

import { looksLikeClashYaml } from "../core/clash";
import { validateSubscriptionUrl } from "../core/options";

/** Upstream configs are tens to hundreds of KB; a megabyte ceiling is generous. */
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/**
 * Identify as a sing-box client. Many providers vary their response by
 * User-Agent and will only emit Clash YAML for a recognised client, so ask for
 * Clash explicitly while staying honest about what we are.
 */
const USER_AGENT = "clash-meta/1.19.0 (meowing; +https://github.com/SagerNet/sing-box)";

export class SubscriptionFetchError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "SubscriptionFetchError";
    this.status = status;
  }
}

export interface FetchedSubscription {
  url: string;
  text: string;
  /** Upstream `subscription-userinfo`, which clients use to show data quota. */
  userInfo?: string;
  /** Upstream `content-disposition` filename, if it named the profile. */
  profileName?: string;
}

/**
 * Build-time constant, so the private-host guard below is unconditional in a
 * production bundle and only relaxed under `vite dev`.
 */
const IS_DEV = import.meta.env?.DEV === true;

export async function fetchSubscription(rawUrl: string): Promise<FetchedSubscription> {
  const url = validateSubscriptionUrl(rawUrl, { allowPrivateHosts: IS_DEV });

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/yaml, application/yaml, text/plain, */*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError"
      ? `it did not respond within ${TIMEOUT_MS / 1000}s`
      : (err instanceof Error ? err.message : String(err));
    throw new SubscriptionFetchError(`Could not reach ${url.host}: ${reason}`);
  }

  if (!response.ok) {
    throw new SubscriptionFetchError(
      `${url.host} returned HTTP ${response.status} ${response.statusText}`.trim(),
    );
  }

  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
    throw new SubscriptionFetchError(
      `The subscription is ${(declaredLength / 1048576).toFixed(1)} MB, over the ` +
        `${MAX_BYTES / 1048576} MB limit.`,
    );
  }

  const text = await readCapped(response, MAX_BYTES);
  const decoded = maybeDecodeBase64(text);

  if (!looksLikeClashYaml(decoded)) {
    const preview = decoded.slice(0, 120).replace(/\s+/g, " ").trim();
    throw new SubscriptionFetchError(
      `${url.host} did not return a Clash config. It may need a different ` +
        `User-Agent, or the link may be a plain node list. First bytes: "${preview}"`,
      422,
    );
  }

  const result: FetchedSubscription = { url: url.toString(), text: decoded };
  const userInfo = response.headers.get("subscription-userinfo");
  if (userInfo) result.userInfo = userInfo;
  const disposition = response.headers.get("content-disposition");
  const nameMatch = disposition ? /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition) : null;
  if (nameMatch?.[1]) {
    try {
      result.profileName = decodeURIComponent(nameMatch[1]);
    } catch {
      result.profileName = nameMatch[1];
    }
  }
  return result;
}

/** Streams a response, aborting as soon as it exceeds `limit` bytes. */
async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        throw new SubscriptionFetchError(
          `The subscription exceeded the ${limit / 1048576} MB limit.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/**
 * Some endpoints base64-encode whatever they return. Decode when the payload is
 * base64 that turns into something YAML-shaped, and otherwise leave it alone.
 */
function maybeDecodeBase64(text: string): string {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 32 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/=]+$/.test(compact)) {
    return text;
  }
  try {
    const binary = atob(compact);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return looksLikeClashYaml(decoded) ? decoded : text;
  } catch {
    return text;
  }
}

/**
 * Merges several Clash documents into one.
 *
 * Only `proxies` are truly combined. Groups and rules are taken from the first
 * document that has them, because two providers' group graphs cannot be
 * interleaved meaningfully — nodes from the other documents are still reachable,
 * since the converter adopts ungrouped nodes into the main selector.
 */
export function mergeClashDocuments(documents: FetchedSubscription[]): string {
  if (documents.length === 1) return documents[0]!.text;

  // Work at the text level rather than re-serialising YAML: it keeps the
  // upstream formatting (and any keys we do not model) intact.
  const proxyBlocks: string[] = [];
  let head: string | undefined;

  for (const doc of documents) {
    const proxies = extractBlock(doc.text, "proxies");
    if (proxies) proxyBlocks.push(proxies);
    if (!head && (extractBlock(doc.text, "proxy-groups") || extractBlock(doc.text, "rules"))) {
      head = doc.text;
    }
  }
  head ??= documents[0]!.text;

  const groups = extractBlock(head, "proxy-groups");
  const rules = extractBlock(head, "rules");
  const providers = extractBlock(head, "rule-providers");

  return [
    "proxies:",
    ...proxyBlocks,
    ...(groups ? ["proxy-groups:", groups] : []),
    ...(providers ? ["rule-providers:", providers] : []),
    ...(rules ? ["rules:", rules] : []),
  ].join("\n");
}

/** Extracts the indented body of a top-level YAML key, without the key line. */
function extractBlock(text: string, key: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${key}\\s*:\\s*$`).test(line));
  if (start === -1) return undefined;

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      body.push(line);
      continue;
    }
    // A non-indented line starts the next top-level key.
    if (!/^[\s-]/.test(line)) break;
    body.push(line);
  }
  const block = body.join("\n").replace(/\s+$/, "");
  return block === "" ? undefined : block;
}
