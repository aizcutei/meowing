/**
 * Parsing and normalisation of Clash / mihomo (Clash.Meta) subscription YAML.
 *
 * Real-world subscriptions are inconsistent: ports arrive as strings, booleans as
 * `"true"`, and transport options appear in both the modern nested form
 * (`ws-opts: {path, headers}`) and the legacy flat form (`ws-path`, `ws-headers`).
 * Everything downstream of this module assumes the normalised shape produced here.
 */

import { parse as parseYaml } from "yaml";

export interface ClashProxy {
  name: string;
  type: string;
  server?: string;
  port?: number;
  [key: string]: unknown;
}

export interface ClashProxyGroup {
  name: string;
  type: string;
  proxies?: string[];
  use?: string[];
  url?: string;
  interval?: number;
  tolerance?: number;
  lazy?: boolean;
  filter?: string;
  "exclude-filter"?: string;
  "include-all"?: boolean;
  "include-all-proxies"?: boolean;
  strategy?: string;
  [key: string]: unknown;
}

export interface ClashConfig {
  proxies: ClashProxy[];
  groups: ClashProxyGroup[];
  rules: string[];
  /** Names of `proxy-providers`, which we cannot follow without extra fetches. */
  providerNames: string[];
  /** `rule-providers` keyed by name, used to map `RULE-SET` rules. */
  ruleProviders: Record<string, ClashRuleProvider>;
}

export interface ClashRuleProvider {
  type?: string;
  behavior?: string;
  format?: string;
  url?: string;
  path?: string;
}

export class ClashParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClashParseError";
  }
}

const truthy = new Set(["true", "1", "yes", "on"]);
const falsy = new Set(["false", "0", "no", "off", ""]);

/** Coerces the loose YAML scalars found in subscriptions into real booleans. */
export function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (truthy.has(v)) return true;
    if (falsy.has(v)) return false;
  }
  return undefined;
}

/** Coerces to a finite integer, returning undefined for anything unusable. */
export function asInt(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : undefined;
  if (typeof value === "string") {
    const n = Number.parseInt(value.trim(), 10);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const v = value.trim();
    return v === "" ? undefined : v;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** Returns a trimmed string list from a value that may be a scalar or a list. */
export function asStringList(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const out = raw.map((v) => asString(v)).filter((v): v is string => v != null);
  return out.length > 0 ? out : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads the first present key from a set of aliases. Subscriptions disagree on
 * casing and separators (`alterId` / `alterid` / `alter-id`), so callers pass all
 * spellings they know about.
 */
export function pick(proxy: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const v = proxy[key];
    if (v != null && v !== "") return v;
  }
  return undefined;
}

/**
 * Folds the legacy flat transport keys into the nested `*-opts` form so that
 * outbound conversion only has to handle one shape.
 */
function normaliseTransportOpts(proxy: Record<string, unknown>): void {
  const legacy: Array<[string, string, Record<string, string>]> = [
    ["ws-opts", "ws", { "ws-path": "path", "ws-headers": "headers" }],
    ["h2-opts", "h2", { "h2-host": "host", "h2-path": "path" }],
    ["grpc-opts", "grpc", { "grpc-service-name": "grpc-service-name" }],
  ];

  for (const [optsKey, _kind, mapping] of legacy) {
    const existing = asRecord(proxy[optsKey]) ?? {};
    let touched = Object.keys(existing).length > 0;
    for (const [flatKey, nestedKey] of Object.entries(mapping)) {
      const v = proxy[flatKey];
      if (v != null && existing[nestedKey] == null) {
        existing[nestedKey] = v;
        touched = true;
      }
    }
    if (touched) proxy[optsKey] = existing;
  }
}

function normaliseProxy(raw: unknown, index: number): ClashProxy | { error: string } {
  const rec = asRecord(raw);
  if (!rec) return { error: `proxies[${index}] is not a mapping` };

  const name = asString(rec.name);
  const type = asString(rec.type)?.toLowerCase();
  if (!name) return { error: `proxies[${index}] is missing "name"` };
  if (!type) return { error: `proxy "${name}" is missing "type"` };

  const proxy: ClashProxy = { ...rec, name, type };

  const port = asInt(pick(rec, "port"));
  if (port != null) proxy.port = port;
  const server = asString(pick(rec, "server"));
  if (server != null) proxy.server = server;

  normaliseTransportOpts(proxy);
  return proxy;
}

function normaliseGroup(raw: unknown, index: number): ClashProxyGroup | { error: string } {
  const rec = asRecord(raw);
  if (!rec) return { error: `proxy-groups[${index}] is not a mapping` };

  const name = asString(rec.name);
  const type = asString(rec.type)?.toLowerCase();
  if (!name) return { error: `proxy-groups[${index}] is missing "name"` };
  if (!type) return { error: `proxy group "${name}" is missing "type"` };

  const proxies = Array.isArray(rec.proxies)
    ? rec.proxies.map((p) => asString(p)).filter((p): p is string => p != null)
    : undefined;
  const use = Array.isArray(rec.use)
    ? rec.use.map((p) => asString(p)).filter((p): p is string => p != null)
    : undefined;

  return { ...rec, name, type, proxies, use } as ClashProxyGroup;
}

/**
 * Parses a Clash YAML document. Returns the normalised config plus any
 * non-fatal problems (a single malformed proxy should not sink a 400-node list).
 */
export function parseClashConfig(text: string): { config: ClashConfig; warnings: string[] } {
  const warnings: string[] = [];

  let doc: unknown;
  try {
    // Subscriptions legitimately repeat keys and use tabs; be permissive.
    doc = parseYaml(text, { uniqueKeys: false, strict: false, merge: true });
  } catch (err) {
    throw new ClashParseError(
      `Not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const root = asRecord(doc);
  if (!root) {
    throw new ClashParseError(
      "The document is not a YAML mapping. Expected a Clash config with a top-level `proxies:` key.",
    );
  }

  const rawProxies = root.proxies;
  if (!Array.isArray(rawProxies)) {
    throw new ClashParseError(
      "No `proxies:` list found. This does not look like a Clash subscription.",
    );
  }

  const proxies: ClashProxy[] = [];
  for (const [i, raw] of rawProxies.entries()) {
    const result = normaliseProxy(raw, i);
    if ("error" in result) warnings.push(`Skipped proxy: ${result.error}`);
    else proxies.push(result);
  }

  const groups: ClashProxyGroup[] = [];
  const rawGroups = root["proxy-groups"];
  if (Array.isArray(rawGroups)) {
    for (const [i, raw] of rawGroups.entries()) {
      const result = normaliseGroup(raw, i);
      if ("error" in result) warnings.push(`Skipped proxy group: ${result.error}`);
      else groups.push(result);
    }
  }

  const rules = Array.isArray(root.rules)
    ? root.rules.map((r) => asString(r)).filter((r): r is string => r != null)
    : [];

  const providerNames = Object.keys(asRecord(root["proxy-providers"]) ?? {});
  if (providerNames.length > 0) {
    warnings.push(
      `Config uses ${providerNames.length} proxy-provider(s) (${providerNames.join(", ")}). ` +
        "Their nodes live behind separate URLs and are not included; convert those URLs too.",
    );
  }

  const ruleProviders: Record<string, ClashRuleProvider> = {};
  for (const [key, value] of Object.entries(asRecord(root["rule-providers"]) ?? {})) {
    const rec = asRecord(value);
    if (rec) {
      ruleProviders[key] = {
        type: asString(rec.type),
        behavior: asString(rec.behavior),
        format: asString(rec.format),
        url: asString(rec.url),
        path: asString(rec.path),
      };
    }
  }

  if (proxies.length === 0) {
    throw new ClashParseError("The `proxies:` list is empty — nothing to convert.");
  }

  return { config: { proxies, groups, rules, providerNames, ruleProviders }, warnings };
}

/**
 * Detects whether a payload looks like a Clash YAML config as opposed to the
 * base64 URI list that many subscription endpoints return.
 */
export function looksLikeClashYaml(text: string): boolean {
  return /^\s*(proxies|proxy-groups|mixed-port|port|socks-port)\s*:/m.test(text);
}
