/**
 * Conversion options, plus the encoding that makes the `/sub` endpoint
 * stateless.
 *
 * A generated subscription link has to survive being turned into a QR code and
 * pasted into a sing-box client, and it must keep working so clients can
 * auto-update. Rather than storing anything server-side, the source URLs and any
 * non-default options are packed into the link itself, so only overrides cost
 * characters.
 */

import type { RuleSetSource } from "./rules";
import type { DomainStrategy } from "./singbox";

export type TunStack = "system" | "gvisor" | "mixed";

/**
 * Which sing-box schema to emit for.
 *
 * The two lines differ in ways that cannot be papered over: 1.14 rejects the
 * pre-1.12 DNS format outright and prefers the new `http_clients` list, while
 * 1.13 rejects `http_clients` and needs the deprecated `download_detour`.
 */
export type TargetVersion = "1.14" | "1.13";

export interface ConvertOptions {
  /** Emit a `tun` inbound (transparent proxying; needs elevated privileges). */
  tun: boolean;
  tunStack: TunStack;
  /** Emit a `mixed` (HTTP + SOCKS) inbound. */
  mixed: boolean;
  mixedPort: number;

  /** Resolver for proxied traffic, e.g. `https://1.1.1.1/dns-query`. */
  remoteDns: string;
  /** Resolver for direct traffic, e.g. `https://223.5.5.5/dns-query`. */
  localDns: string;
  dnsStrategy: DomainStrategy;
  /** Use a `fakeip` server. Requires TUN to be useful. */
  fakeIp: boolean;

  /** Convert the subscription's own rules. When false, only a default rule set is used. */
  convertRules: boolean;
  ruleSetSource: RuleSetSource;
  /** How remote rule sets are downloaded: through the proxy, or directly. */
  ruleSetDetour: "proxy" | "direct";
  /** Add `geosite-cn` / `geoip-cn` direct rules even if the source has none. */
  addChinaDirect: boolean;
  /** Add a `geosite-category-ads-all` reject rule. */
  blockAds: boolean;

  /** Prepend an auto-latency `urltest` group over every node. */
  addAutoSelect: boolean;
  /** Group nodes into per-region `urltest` groups inferred from node names. */
  addRegionGroups: boolean;

  /** Expose the Clash API so GUIs (and rule-set caching) work. */
  clashApi: boolean;
  logLevel: "trace" | "debug" | "info" | "warn" | "error";
  targetVersion: TargetVersion;

  /* --- Tailscale ------------------------------------------------------- */

  /** Join a tailnet via a `tailscale` endpoint and route tailnet traffic into it. */
  tailscale: boolean;
  /**
   * Pre-authentication key. Optional: without one sing-box prints a login URL on
   * first start, which is preferable, because this value ends up inside the
   * subscription link.
   */
  tailscaleAuthKey: string;
  /** Machine name shown in the tailnet. Empty lets Tailscale pick. */
  tailscaleHostname: string;
  /** Accept subnet routes advertised by tailnet peers. */
  tailscaleAcceptRoutes: boolean;
  /** Route all non-tailnet traffic through this exit node instead of the proxy. */
  tailscaleExitNode: string;
  /** Where tailnet identity is persisted. Must be writable and stable across restarts. */
  tailscaleStateDir: string;

  /* --- DNS ------------------------------------------------------------- */

  /**
   * `china` replaces `remoteDns`/`localDns` with AliDNS + ByteDance for domestic
   * names and Google DoT for the rest. `manual` uses the two fields as given.
   */
  dnsPreset: "manual" | "china";
  /**
   * Query domestic and foreign resolvers concurrently and take the fastest
   * usable answer. Needs sing-box 1.14; ignored on 1.13.
   */
  dnsRace: boolean;
  /**
   * Resolve LAN and tailnet names to real addresses, leaving FakeIP for external
   * domains. Only meaningful together with `fakeIp`.
   */
  realIpLocal: boolean;

  /* --- custom routing -------------------------------------------------- */

  /** Routing DSL source; see `custom-rules.ts`. */
  customRules: string;
  /**
   * How `customRules` combines with the subscription's own rules: `before` and
   * `after` merge, `replace` ignores the subscription's rules entirely.
   */
  customRulesMode: "off" | "replace" | "before" | "after";
}

export const DEFAULT_OPTIONS: ConvertOptions = {
  tun: true,
  tunStack: "mixed",
  mixed: true,
  mixedPort: 2080,

  remoteDns: "https://1.1.1.1/dns-query",
  localDns: "https://223.5.5.5/dns-query",
  dnsStrategy: "prefer_ipv4",
  fakeIp: false,

  convertRules: true,
  ruleSetSource: "sagernet",
  // GitHub raw is widely blocked where these configs are used, so default to
  // fetching rule sets through the proxy.
  ruleSetDetour: "proxy",
  addChinaDirect: true,
  blockAds: false,

  addAutoSelect: true,
  addRegionGroups: false,

  clashApi: true,
  logLevel: "info",
  targetVersion: "1.14",

  tailscale: false,
  tailscaleAuthKey: "",
  tailscaleHostname: "",
  tailscaleAcceptRoutes: true,
  tailscaleExitNode: "",
  // Relative, so it lands inside sing-box's working/data directory. An absolute
  // /var/lib path would need root, which breaks desktop runs.
  tailscaleStateDir: "tailscale",

  dnsPreset: "china",
  dnsRace: true,
  realIpLocal: true,

  customRules: "",
  customRulesMode: "off",
};

/**
 * Short keys used in the packed `o=` parameter. Keeping them stable matters:
 * changing one invalidates every subscription link already in the wild.
 */
const KEY_MAP = {
  tun: "t",
  tunStack: "ts",
  mixed: "m",
  mixedPort: "mp",
  remoteDns: "rd",
  localDns: "ld",
  dnsStrategy: "ds",
  fakeIp: "f",
  convertRules: "cr",
  ruleSetSource: "rs",
  ruleSetDetour: "rsd",
  addChinaDirect: "cd",
  blockAds: "ba",
  addAutoSelect: "as",
  addRegionGroups: "rg",
  clashApi: "ca",
  logLevel: "ll",
  targetVersion: "v",

  tailscale: "tl",
  tailscaleAuthKey: "tk",
  tailscaleHostname: "th",
  tailscaleAcceptRoutes: "tr",
  tailscaleExitNode: "te",
  tailscaleStateDir: "tsd",

  dnsPreset: "dp",
  dnsRace: "dr",
  realIpLocal: "rl",

  customRules: "cu",
  customRulesMode: "cm",
} as const satisfies Record<keyof ConvertOptions, string>;

const REVERSE_KEY_MAP = Object.fromEntries(
  Object.entries(KEY_MAP).map(([long, short]) => [short, long]),
) as Record<string, keyof ConvertOptions>;

/* ------------------------------------------------------- base64url helpers */

export function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* ---------------------------------------------------------- (de)serialising */

const TUN_STACKS: TunStack[] = ["system", "gvisor", "mixed"];
const DNS_STRATEGIES: DomainStrategy[] = ["prefer_ipv4", "prefer_ipv6", "ipv4_only", "ipv6_only"];
const LOG_LEVELS: ConvertOptions["logLevel"][] = ["trace", "debug", "info", "warn", "error"];

function coerce<K extends keyof ConvertOptions>(
  key: K,
  raw: unknown,
): ConvertOptions[K] | undefined {
  const fallback = DEFAULT_OPTIONS[key];

  if (typeof fallback === "boolean") {
    if (typeof raw === "boolean") return raw as ConvertOptions[K];
    if (raw === 1 || raw === "1" || raw === "true") return true as ConvertOptions[K];
    if (raw === 0 || raw === "0" || raw === "false") return false as ConvertOptions[K];
    return undefined;
  }

  if (typeof fallback === "number") {
    const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
    return n as ConvertOptions[K];
  }

  const s = typeof raw === "string" ? raw.trim() : undefined;
  // An empty string is how "not set" arrives for the optional text fields, so for
  // those it is the default rather than a rejection.
  if (s === "" && fallback === "") return "" as ConvertOptions[K];
  if (!s) return undefined;
  switch (key) {
    case "tunStack":
      return TUN_STACKS.includes(s as TunStack) ? (s as ConvertOptions[K]) : undefined;
    case "dnsStrategy":
      return DNS_STRATEGIES.includes(s as DomainStrategy) ? (s as ConvertOptions[K]) : undefined;
    case "logLevel":
      return LOG_LEVELS.includes(s as ConvertOptions["logLevel"])
        ? (s as ConvertOptions[K])
        : undefined;
    case "ruleSetSource":
      return s === "sagernet" || s === "metacubex" ? (s as ConvertOptions[K]) : undefined;
    case "ruleSetDetour":
      return s === "proxy" || s === "direct" ? (s as ConvertOptions[K]) : undefined;
    case "targetVersion":
      return s === "1.14" || s === "1.13" ? (s as ConvertOptions[K]) : undefined;
    case "dnsPreset":
      return s === "manual" || s === "china" ? (s as ConvertOptions[K]) : undefined;
    case "customRulesMode":
      return ["off", "replace", "before", "after"].includes(s) ? (s as ConvertOptions[K]) : undefined;
    case "tailscaleHostname":
      // Tailscale itself only accepts DNS-label-ish names.
      return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(s) ? (s as ConvertOptions[K]) : undefined;
    case "tailscaleStateDir":
      return /^[^\s"'\\]+$/.test(s) ? (s as ConvertOptions[K]) : undefined;
    case "tailscaleAuthKey":
      return /^[A-Za-z0-9._-]+$/.test(s) ? (s as ConvertOptions[K]) : undefined;
    case "tailscaleExitNode":
      return /^[A-Za-z0-9._:-]+$/.test(s) ? (s as ConvertOptions[K]) : undefined;
    case "remoteDns":
    case "localDns":
      // Guard against a DNS field being used to smuggle something odd into the config.
      return /^[a-z0-9]+:\/\/[^\s"'\\]+$/i.test(s) || s === "local"
        ? (s as ConvertOptions[K])
        : undefined;
    default:
      return s as ConvertOptions[K];
  }
}

/** Fills in defaults for anything missing or invalid in a partial option bag. */
export function normaliseOptions(input: unknown): {
  options: ConvertOptions;
  rejected: string[];
} {
  const options: ConvertOptions = { ...DEFAULT_OPTIONS };
  const rejected: string[] = [];
  if (input == null || typeof input !== "object") return { options, rejected };

  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = (REVERSE_KEY_MAP[rawKey] ?? rawKey) as keyof ConvertOptions;
    if (!Object.hasOwn(DEFAULT_OPTIONS, key)) {
      rejected.push(`unknown option "${rawKey}"`);
      continue;
    }
    const value = coerce(key, rawValue);
    if (value === undefined) {
      rejected.push(`invalid value for "${key}": ${JSON.stringify(rawValue)}`);
      continue;
    }
    (options[key] as ConvertOptions[typeof key]) = value;
  }

  if (!options.tun && !options.mixed) {
    // A config with no inbound cannot carry traffic; keep the safer one.
    options.mixed = true;
    rejected.push("at least one inbound is required; re-enabled the mixed inbound");
  }
  if (options.fakeIp && !options.tun) {
    options.fakeIp = false;
    rejected.push("FakeIP needs the TUN inbound; disabled it");
  }
  if (options.dnsRace && options.targetVersion === "1.13") {
    // `evaluate` / `race` DNS actions do not exist before 1.14; 1.13.21 rejects
    // the config outright rather than ignoring them.
    options.dnsRace = false;
    rejected.push("Concurrent DNS needs sing-box 1.14; fell back to rule-based split DNS");
  }

  return { options, rejected };
}

/** Serialises only the values that differ from the defaults. */
export function packOptions(options: ConvertOptions): string | undefined {
  const diff: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_OPTIONS) as Array<keyof ConvertOptions>) {
    if (options[key] !== DEFAULT_OPTIONS[key]) diff[KEY_MAP[key]] = options[key];
  }
  return Object.keys(diff).length === 0 ? undefined : b64urlEncode(JSON.stringify(diff));
}

export function unpackOptions(packed: string | null | undefined): {
  options: ConvertOptions;
  rejected: string[];
} {
  if (!packed) return { options: { ...DEFAULT_OPTIONS }, rejected: [] };
  try {
    return normaliseOptions(JSON.parse(b64urlDecode(packed)));
  } catch {
    return {
      options: { ...DEFAULT_OPTIONS },
      rejected: ["the options segment of the link is corrupt; used defaults"],
    };
  }
}

/* ------------------------------------------------------------ subscriptions */

export interface SubscriptionRequest {
  /** Upstream Clash subscription URLs to fetch and merge. */
  urls: string[];
  options: ConvertOptions;
}

export class InvalidSubscriptionUrl extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSubscriptionUrl";
  }
}

/**
 * Validates an upstream subscription URL.
 *
 * The Worker fetches whatever it is given, so this is the only thing standing
 * between the public endpoint and being used as a request proxy. Cloudflare
 * cannot reach RFC1918 space, but rejecting obvious internal targets and
 * non-HTTP schemes keeps the endpoint from being useful for probing at all.
 *
 * `allowPrivateHosts` exists so `vite dev` can convert a subscription served
 * from localhost. Callers derive it from a build-time constant, so the check is
 * unconditional in a production bundle.
 */
export function validateSubscriptionUrl(
  raw: string,
  { allowPrivateHosts = false }: { allowPrivateHosts?: boolean } = {},
): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InvalidSubscriptionUrl(`"${truncate(raw)}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidSubscriptionUrl(`unsupported scheme "${url.protocol}" (use http or https)`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (allowPrivateHosts) return url;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host) ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new InvalidSubscriptionUrl(`"${host}" is not a public address`);
  }
  return url;
}

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Builds the stateless `/sub` path for a set of upstream URLs and options. */
export function buildSubscriptionPath(urls: string[], options: ConvertOptions): string {
  const params = new URLSearchParams();
  for (const url of urls) params.append("u", b64urlEncode(url));
  const packed = packOptions(options);
  if (packed) params.set("o", packed);
  return `/sub?${params.toString()}`;
}

export function parseSubscriptionParams(params: URLSearchParams): {
  urls: string[];
  options: ConvertOptions;
  rejected: string[];
} {
  const urls: string[] = [];
  for (const value of params.getAll("u")) {
    if (!value) continue;
    // Accept both packed and plain URLs so links stay hand-editable.
    urls.push(value.includes("://") ? value : b64urlDecode(value));
  }
  for (const value of params.getAll("url")) {
    if (value) urls.push(value);
  }
  const { options, rejected } = unpackOptions(params.get("o"));

  // Individual options may also be passed as plain query params, which wins.
  const inline: Record<string, unknown> = {};
  for (const [key, value] of params) {
    if (key === "u" || key === "url" || key === "o" || key === "token") continue;
    inline[key] = value;
  }
  if (Object.keys(inline).length > 0) {
    const merged = normaliseOptions({ ...packOptionsToRecord(options), ...inline });
    return { urls, options: merged.options, rejected: [...rejected, ...merged.rejected] };
  }

  return { urls, options, rejected };
}

function packOptionsToRecord(options: ConvertOptions): Record<string, unknown> {
  return Object.fromEntries(
    (Object.keys(DEFAULT_OPTIONS) as Array<keyof ConvertOptions>).map((key) => [key, options[key]]),
  );
}
