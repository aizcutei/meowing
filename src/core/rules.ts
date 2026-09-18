/**
 * Clash `rules` -> sing-box `route.rules`.
 *
 * The interesting part is volume: a provider subscription routinely ships ~10k
 * one-matcher-per-line rules, which would make an unusable sing-box config. We
 * collapse them, but only in ways that provably preserve Clash's
 * first-match-wins ordering — see `mergeRuns`.
 */

import { asString, type ClashRuleProvider } from "./clash";
import type { RouteRule, RuleSet } from "./singbox";

export type RuleSetSource = "sagernet" | "metacubex";

/** Where `GEOSITE` / `GEOIP` rules are pointed at. Both were verified reachable. */
const RULE_SET_URLS: Record<RuleSetSource, { geosite: (n: string) => string; geoip: (n: string) => string }> = {
  sagernet: {
    geosite: (n) => `https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-${n}.srs`,
    geoip: (n) => `https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-${n}.srs`,
  },
  metacubex: {
    geosite: (n) => `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/${n}.srs`,
    geoip: (n) => `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geoip/${n}.srs`,
  },
};

/**
 * Clash `rule-providers` cannot be consumed by sing-box: they are YAML/text
 * lists, not compiled `.srs` sets. The widely used provider names (from
 * Loyalsoldier/clash-rules and ACL4SSR) do have geosite/geoip equivalents
 * though, so map the ones we recognise and report the rest.
 */
const PROVIDER_EQUIVALENTS: Record<string, { kind: "geosite" | "geoip"; name: string }> = {
  reject: { kind: "geosite", name: "category-ads-all" },
  ads: { kind: "geosite", name: "category-ads-all" },
  advertising: { kind: "geosite", name: "category-ads-all" },
  privacy: { kind: "geosite", name: "category-ads-all" },
  icloud: { kind: "geosite", name: "icloud" },
  apple: { kind: "geosite", name: "apple" },
  google: { kind: "geosite", name: "google" },
  microsoft: { kind: "geosite", name: "microsoft" },
  telegram: { kind: "geosite", name: "telegram" },
  telegramcidr: { kind: "geoip", name: "telegram" },
  twitter: { kind: "geosite", name: "twitter" },
  netflix: { kind: "geosite", name: "netflix" },
  youtube: { kind: "geosite", name: "youtube" },
  openai: { kind: "geosite", name: "openai" },
  spotify: { kind: "geosite", name: "spotify" },
  steam: { kind: "geosite", name: "steam" },
  bilibili: { kind: "geosite", name: "bilibili" },
  proxy: { kind: "geosite", name: "geolocation-!cn" },
  gfw: { kind: "geosite", name: "geolocation-!cn" },
  direct: { kind: "geosite", name: "cn" },
  "tld-not-cn": { kind: "geosite", name: "geolocation-!cn" },
  cncidr: { kind: "geoip", name: "cn" },
  lancidr: { kind: "geoip", name: "private" },
  private: { kind: "geoip", name: "private" },
};

/** Resolution of a Clash rule target into a sing-box action. */
export type RuleTarget =
  | { kind: "route"; outbound: string }
  | { kind: "reject"; drop?: boolean }
  | { kind: "skip"; reason: string };

/** A target that actually produces a rule, i.e. everything but `skip`. */
type UsableTarget = Exclude<RuleTarget, { kind: "skip" }>;

export interface RulesContext {
  /** Maps a Clash policy name (group, proxy, DIRECT, REJECT, ...) to an action. */
  resolveTarget: (name: string) => RuleTarget;
  ruleProviders: Record<string, ClashRuleProvider>;
  ruleSetSource: RuleSetSource;
  ruleSetUpdateInterval: string;
  /** Outbound used to download remote rule sets, if any. */
  ruleSetDownloadDetour?: string;
  warn: (msg: string) => void;
}

export interface RulesResult {
  rules: RouteRule[];
  ruleSets: RuleSet[];
  /** Outbound named by the trailing `MATCH` rule. */
  final?: string;
  /** True when `MATCH,REJECT` was used, which sing-box cannot express as `final`. */
  finalRejects: boolean;
  stats: { parsed: number; skipped: number; emitted: number };
}

/**
 * Destination-address matchers. sing-box ORs every one of these together inside
 * a single rule (`route/rule/rule_abstract.go`: they all feed the
 * `ruleMatchDestinationAddress` group), which is what licenses merging them.
 */
type DomainField = "domain" | "domain_suffix" | "domain_keyword" | "domain_regex" | "ip_cidr";

type Matcher =
  | { kind: "dest"; field: DomainField; values: string[] }
  | { kind: "ruleset"; tags: string[]; matchSource: boolean }
  | { kind: "other"; rule: RouteRule };

interface ParsedRule {
  matcher: Matcher;
  target: UsableTarget;
}

/**
 * Splits a Clash rule line.
 *
 * Naive `split(",")` breaks on `DOMAIN-REGEX` values containing `{n,m}`
 * quantifiers, so instead we peel the trailing modifiers and target off the end
 * and treat everything in between as the value.
 */
const TRAILING_MODIFIERS = new Set(["no-resolve", "src", "dst"]);

export function splitRuleLine(line: string): {
  type: string;
  value: string;
  target: string;
  modifiers: string[];
} | undefined {
  const parts = line.split(",").map((p) => p.trim());
  if (parts.length < 2) return undefined;

  const type = (parts[0] ?? "").toUpperCase();
  const rest = parts.slice(1);

  const modifiers: string[] = [];
  while (rest.length > 0 && TRAILING_MODIFIERS.has((rest[rest.length - 1] ?? "").toLowerCase())) {
    modifiers.unshift((rest.pop() ?? "").toLowerCase());
  }
  if (rest.length === 0) return undefined;

  const target = rest.pop() ?? "";
  const value = rest.join(",");
  return { type, value, target, modifiers };
}

/** Clash accepts bare addresses in IP-CIDR rules; sing-box requires a prefix. */
function normaliseCidr(value: string): string | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  if (v.includes("/")) return v;
  return v.includes(":") ? `${v}/128` : `${v}/32`;
}

function portMatcher(value: string, field: "port" | "source_port"): RouteRule | undefined {
  const rangeField = field === "port" ? "port_range" : "source_port_range";
  const ports: number[] = [];
  const ranges: string[] = [];

  for (const entry of value.split("/")) {
    const v = entry.trim();
    const range = /^(\d*)\s*-\s*(\d*)$/.exec(v);
    if (range) {
      ranges.push(`${range[1] ?? ""}:${range[2] ?? ""}`);
      continue;
    }
    const n = Number.parseInt(v, 10);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) ports.push(n);
  }
  if (ports.length === 0 && ranges.length === 0) return undefined;
  const rule: RouteRule = {};
  if (ports.length > 0) rule[field] = ports;
  if (ranges.length > 0) rule[rangeField] = ranges;
  return rule;
}

/** Converts mihomo's `*` / `?` wildcard domains into a sing-box regex. */
function wildcardToRegex(pattern: string): string {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return `^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`;
}

function parseRule(line: string, ctx: RulesContext, ruleSets: Map<string, RuleSet>): ParsedRule | { skip: string } | { final: string } | { finalReject: true } {
  const parsed = splitRuleLine(line);
  if (!parsed) return { skip: `malformed rule "${line}"` };
  const { type, value, target, modifiers } = parsed;

  if (type === "MATCH" || type === "FINAL") {
    // `MATCH` has no value: the "target" is whatever followed the type.
    const finalName = value === "" ? target : value;
    const resolved = ctx.resolveTarget(finalName);
    if (resolved.kind === "route") return { final: resolved.outbound };
    if (resolved.kind === "reject") return { finalReject: true };
    return { skip: `MATCH target "${finalName}" is unusable: ${resolved.reason}` };
  }

  if (type === "AND" || type === "OR" || type === "NOT" || type === "SUB-RULE") {
    return { skip: `logical rule (${type}) is not converted` };
  }

  const resolved = ctx.resolveTarget(target);
  if (resolved.kind === "skip") {
    return { skip: `rule "${line}" targets "${target}": ${resolved.reason}` };
  }
  if (value === "") return { skip: `rule "${line}" has an empty value` };

  const dest = (field: DomainField, values: string[]): ParsedRule => ({
    matcher: { kind: "dest", field, values },
    target: resolved,
  });
  const other = (rule: RouteRule): ParsedRule => ({
    matcher: { kind: "other", rule },
    target: resolved,
  });

  switch (type) {
    case "DOMAIN":
      return dest("domain", [value.toLowerCase()]);
    case "DOMAIN-SUFFIX":
      // Clash suffixes are bare (`example.com`) and match subdomains too, which
      // is exactly sing-box's `domain_suffix` when written without a leading dot.
      return dest("domain_suffix", [value.replace(/^\.+/, "").toLowerCase()]);
    case "DOMAIN-KEYWORD":
      return dest("domain_keyword", [value.toLowerCase()]);
    case "DOMAIN-REGEX":
      return dest("domain_regex", [value]);
    case "DOMAIN-WILDCARD":
      return dest("domain_regex", [wildcardToRegex(value.toLowerCase())]);

    case "IP-CIDR":
    case "IP-CIDR6": {
      const cidr = normaliseCidr(value);
      return cidr ? dest("ip_cidr", [cidr]) : { skip: `invalid CIDR in "${line}"` };
    }

    case "SRC-IP-CIDR": {
      const cidr = normaliseCidr(value);
      return cidr ? other({ source_ip_cidr: [cidr] }) : { skip: `invalid CIDR in "${line}"` };
    }

    case "GEOIP":
    case "SRC-GEOIP": {
      const name = value.toLowerCase();
      const tag = `geoip-${name}`;
      registerRuleSet(ruleSets, tag, "geoip", name, ctx);
      return {
        matcher: { kind: "ruleset", tags: [tag], matchSource: type === "SRC-GEOIP" },
        target: resolved,
      };
    }

    case "GEOSITE": {
      const name = value.toLowerCase();
      const tag = `geosite-${name}`;
      registerRuleSet(ruleSets, tag, "geosite", name, ctx);
      return { matcher: { kind: "ruleset", tags: [tag], matchSource: false }, target: resolved };
    }

    case "RULE-SET": {
      const provider = ctx.ruleProviders[value];
      const equivalent = PROVIDER_EQUIVALENTS[value.toLowerCase()];
      if (!equivalent) {
        return {
          skip:
            `rule-provider "${value}" has no sing-box equivalent ` +
            `(${provider?.behavior ?? "unknown"} list at ${provider?.url ?? "unknown URL"})`,
        };
      }
      const tag = `${equivalent.kind}-${equivalent.name}`;
      registerRuleSet(ruleSets, tag, equivalent.kind, equivalent.name, ctx);
      return {
        matcher: {
          kind: "ruleset",
          tags: [tag],
          matchSource: modifiers.includes("src"),
        },
        target: resolved,
      };
    }

    case "DST-PORT": {
      const rule = portMatcher(value, "port");
      return rule ? other(rule) : { skip: `invalid port in "${line}"` };
    }
    case "SRC-PORT": {
      const rule = portMatcher(value, "source_port");
      return rule ? other(rule) : { skip: `invalid port in "${line}"` };
    }

    case "NETWORK": {
      const network = value.toLowerCase();
      if (network !== "tcp" && network !== "udp") return { skip: `unknown network "${value}"` };
      return other({ network: [network] });
    }

    case "PROCESS-NAME":
      return other({ process_name: [value] });
    case "PROCESS-PATH":
      return other({ process_path: [value] });
    case "PROCESS-PATH-REGEX":
      return other({ process_path_regex: [value] } as RouteRule);
    case "UID": {
      const uid = Number.parseInt(value, 10);
      return Number.isInteger(uid)
        ? other({ user_id: [uid] } as unknown as RouteRule)
        : { skip: `invalid UID in "${line}"` };
    }

    default:
      return { skip: `unsupported rule type "${type}"` };
  }
}

function registerRuleSet(
  ruleSets: Map<string, RuleSet>,
  tag: string,
  kind: "geosite" | "geoip",
  name: string,
  ctx: RulesContext,
): void {
  if (ruleSets.has(tag)) return;
  const entry: RuleSet = {
    type: "remote",
    tag,
    format: "binary",
    url: RULE_SET_URLS[ctx.ruleSetSource][kind](name),
    update_interval: ctx.ruleSetUpdateInterval,
  };
  if (ctx.ruleSetDownloadDetour) entry.download_detour = ctx.ruleSetDownloadDetour;
  ruleSets.set(tag, entry);
}

/* ----------------------------------------------------------------- merging */

function targetKey(target: UsableTarget): string {
  return target.kind === "route" ? `route:${target.outbound}` : `reject:${target.drop ? "drop" : ""}`;
}

function applyTarget(rule: RouteRule, target: UsableTarget): RouteRule {
  if (target.kind === "route") {
    rule.outbound = target.outbound;
  } else {
    rule.action = "reject";
    if (target.drop) rule.method = "drop";
  }
  return rule;
}

/**
 * Collapses *consecutive* parsed rules that share a target.
 *
 * Only adjacent runs are merged, which keeps Clash's first-match-wins order
 * exactly: any request matching the merged rule matched one of the originals,
 * and all of them pointed at the same target, so the outcome is unchanged.
 * Merging by target across the whole list would not be safe — a later
 * `DOMAIN-KEYWORD,steam,DIRECT` hoisted above
 * `DOMAIN-SUFFIX,steampowered.com,PROXY` would silently steal its traffic.
 *
 * Two run kinds are mergeable:
 *   - destination-address matchers, because sing-box ORs `domain*` and `ip_cidr`
 *     within one rule;
 *   - `rule_set` matchers, because a rule's `rule_set` list is also OR-ed.
 * The two kinds are never mixed: `rule_set` is AND-ed against the
 * destination-address group (`RuleSetItem.matchWithOuterGroups`).
 */
function mergeRuns(parsed: ParsedRule[]): RouteRule[] {
  const out: RouteRule[] = [];
  let i = 0;

  while (i < parsed.length) {
    const head = parsed[i]!;
    const key = targetKey(head.target);

    if (head.matcher.kind === "dest") {
      const fields = new Map<DomainField, string[]>();
      let j = i;
      while (j < parsed.length) {
        const cur = parsed[j]!;
        if (cur.matcher.kind !== "dest" || targetKey(cur.target) !== key) break;
        const existing = fields.get(cur.matcher.field);
        if (existing) existing.push(...cur.matcher.values);
        else fields.set(cur.matcher.field, [...cur.matcher.values]);
        j++;
      }
      const rule: RouteRule = {};
      // Emit in a stable, readable order rather than first-seen order.
      for (const field of ["domain", "domain_suffix", "domain_keyword", "domain_regex", "ip_cidr"] as const) {
        const values = fields.get(field);
        if (values) rule[field] = dedupe(values);
      }
      out.push(applyTarget(rule, head.target));
      i = j;
      continue;
    }

    if (head.matcher.kind === "ruleset") {
      const matchSource = head.matcher.matchSource;
      const tags: string[] = [];
      let j = i;
      while (j < parsed.length) {
        const cur = parsed[j]!;
        if (
          cur.matcher.kind !== "ruleset" ||
          cur.matcher.matchSource !== matchSource ||
          targetKey(cur.target) !== key
        ) {
          break;
        }
        tags.push(...cur.matcher.tags);
        j++;
      }
      const rule: RouteRule = { rule_set: dedupe(tags) };
      if (matchSource) rule.rule_set_ip_cidr_match_source = true;
      out.push(applyTarget(rule, head.target));
      i = j;
      continue;
    }

    // A run of single-field rules (`port`, `process_name`, `source_ip_cidr`, ...)
    // collapses too: values inside one field are OR-ed, whichever group the
    // field belongs to, so concatenating them is equivalent to listing the
    // rules separately. Rules carrying two fields (a `DST-PORT` with both a
    // port and a range, say) are left alone — merging those would AND them.
    const soleField = singleListField(head.matcher.rule);
    if (soleField) {
      const values: Array<string | number> = [];
      let j = i;
      while (j < parsed.length) {
        const cur = parsed[j]!;
        if (cur.matcher.kind !== "other" || targetKey(cur.target) !== key) break;
        if (singleListField(cur.matcher.rule) !== soleField) break;
        values.push(...(cur.matcher.rule[soleField] as Array<string | number>));
        j++;
      }
      out.push(applyTarget({ [soleField]: dedupe(values) } as RouteRule, head.target));
      i = j;
      continue;
    }

    out.push(applyTarget({ ...head.matcher.rule }, head.target));
    i++;
  }

  return out;
}

/** Returns the field name when a rule has exactly one, array-valued matcher. */
function singleListField(rule: RouteRule): keyof RouteRule | undefined {
  const keys = Object.keys(rule) as Array<keyof RouteRule>;
  const key = keys.length === 1 ? keys[0] : undefined;
  return key != null && Array.isArray(rule[key]) ? key : undefined;
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/* -------------------------------------------------------------- entrypoint */

export function convertRules(lines: string[], ctx: RulesContext): RulesResult {
  const parsed: ParsedRule[] = [];
  const ruleSets = new Map<string, RuleSet>();
  const skipReasons = new Map<string, number>();
  let final: string | undefined;
  let finalRejects = false;
  let skipped = 0;

  for (const line of lines) {
    const result = parseRule(line, ctx, ruleSets);
    if ("skip" in result) {
      skipped++;
      // Collapse identical reasons; 10k rules can produce 10k identical warnings.
      const reason = result.skip.replace(/"[^"]*"/g, (m) => (m.length > 40 ? '"..."' : m));
      skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
      continue;
    }
    if ("final" in result) {
      final = result.final;
      continue;
    }
    if ("finalReject" in result) {
      finalRejects = true;
      continue;
    }
    parsed.push(result);
  }

  for (const [reason, count] of [...skipReasons].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    ctx.warn(count > 1 ? `${reason} (x${count})` : reason);
  }
  if (skipReasons.size > 12) {
    ctx.warn(`... and ${skipReasons.size - 12} other kinds of unconvertible rule`);
  }

  const rules = mergeRuns(parsed);

  const result: RulesResult = {
    rules,
    ruleSets: [...ruleSets.values()],
    finalRejects,
    stats: { parsed: lines.length, skipped, emitted: rules.length },
  };
  if (final) result.final = final;
  return result;
}

/** Exposed for the UI, which lets the user pick a rule-set mirror. */
export function ruleSetSourceLabel(source: RuleSetSource): string {
  return source === "sagernet" ? "SagerNet (official)" : "MetaCubeX meta-rules-dat";
}

export function isRuleSetSource(value: unknown): value is RuleSetSource {
  return value === "sagernet" || value === "metacubex";
}

/** Re-exported so the orchestrator can label provider warnings consistently. */
export function describeProvider(provider: ClashRuleProvider | undefined): string {
  return asString(provider?.url) ?? "unknown URL";
}
