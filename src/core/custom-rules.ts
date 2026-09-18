/**
 * A small routing DSL, so routing can be described without hand-writing
 * sing-box JSON and without depending on whatever rules the subscription ships.
 *
 * One rule per line:
 *
 *     <target>  <matcher>[, <matcher> ...]
 *
 * Matchers on a line are OR-ed, which is what you want when listing places that
 * should share a target. `&` inside a matcher group ANDs instead:
 *
 *     reject  ads
 *     direct  lan, tailscale
 *     proxy   geosite:geolocation-!cn
 *     proxy   suffix:openai.com & port:443
 *     final   proxy
 *
 * OR is not free in sing-box: it ORs `domain*`/`ip_cidr` inside one rule, but
 * ANDs `rule_set` and `port` against them. So an OR group that mixes those has
 * to become separate rules sharing a target, which this module does for you.
 */

import type { RouteRule, RuleSet } from "./singbox";
import type { RuleSetSource } from "./rules";

/** Resolves a DSL target word into a sing-box action. */
export type TargetResolver = (name: string) =>
  | { kind: "route"; outbound: string }
  | { kind: "reject" }
  | { kind: "unknown" };

export interface CustomRulesContext {
  resolveTarget: TargetResolver;
  ruleSetSource: RuleSetSource;
  ruleSetUpdateInterval: string;
  ruleSetDownloadDetour?: string;
}

export interface CustomRulesResult {
  rules: RouteRule[];
  ruleSets: RuleSet[];
  /** Set by a `final <target>` line. */
  final?: string;
  finalRejects: boolean;
  /** Parse failures, each prefixed with its line number. Non-empty means reject the input. */
  errors: string[];
  warnings: string[];
  stats: { lines: number; emitted: number };
}

/** Named shorthands. `lan` and `tailscale` are the ones item 3/4 ordering needs. */
const PRESETS: Record<string, string[]> = {
  ads: ["geosite:category-ads-all"],
  // Tailscale hands out CGNAT addresses and MagicDNS names under .ts.net.
  tailscale: ["ip:100.64.0.0/10", "suffix:.ts.net"],
  cn: ["geosite:cn", "geoip:cn"],
  china: ["geosite:cn", "geoip:cn"],
};

type Term =
  | { field: "domain" | "domain_suffix" | "domain_keyword" | "domain_regex" | "ip_cidr"; value: string }
  | { field: "rule_set"; kind: "geosite" | "geoip"; name: string }
  | { field: "port"; value: number }
  | { field: "port_range"; value: string }
  | { field: "process_name"; value: string }
  | { field: "ip_is_private" };

/** `suffix:` etc. Anything without a prefix is treated as a domain suffix. */
function parseTerm(raw: string, lineNo: number, errors: string[]): Term[] {
  const token = raw.trim();
  if (!token) return [];

  // Checked before PRESETS so that `lan` -> `private` cannot recurse.
  const lower = token.toLowerCase();
  if (lower === "private" || lower === "lan") return [{ field: "ip_is_private" }];

  const preset = PRESETS[lower];
  if (preset) return preset.flatMap((p) => parseTerm(p, lineNo, errors));

  const colon = token.indexOf(":");
  // An IP literal has colons too (v6) but no recognised prefix before them.
  const prefix = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
  const value = colon > 0 ? token.slice(colon + 1).trim() : token;

  switch (prefix) {
    case "domain":
      return [{ field: "domain", value }];
    case "suffix":
      return [{ field: "domain_suffix", value }];
    case "keyword":
      return [{ field: "domain_keyword", value }];
    case "regex":
      return [{ field: "domain_regex", value }];
    case "ip":
    case "cidr":
      return [{ field: "ip_cidr", value }];
    case "geosite":
      return [{ field: "rule_set", kind: "geosite", name: value }];
    case "geoip":
      return [{ field: "rule_set", kind: "geoip", name: value }];
    case "process":
      return [{ field: "process_name", value }];
    case "port": {
      if (/^\d+$/.test(value)) {
        const port = Number(value);
        if (port < 1 || port > 65535) {
          errors.push(`line ${lineNo}: port out of range: ${value}`);
          return [];
        }
        return [{ field: "port", value: port }];
      }
      const range = value.match(/^(\d+)\s*[-:]\s*(\d+)$/);
      if (range) return [{ field: "port_range", value: `${range[1]}:${range[2]}` }];
      errors.push(`line ${lineNo}: cannot read port "${value}"`);
      return [];
    }
    case "":
      // Bare token: a domain suffix, which is the common case in hand-written lists.
      return [{ field: "domain_suffix", value }];
    default:
      errors.push(`line ${lineNo}: unknown matcher "${prefix}"`);
      return [];
  }
}

export function parseCustomRules(source: string, ctx: CustomRulesContext): CustomRulesResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rules: RouteRule[] = [];
  const needed = new Map<string, { kind: "geosite" | "geoip"; name: string }>();
  let final: string | undefined;
  let finalRejects = false;
  let lines = 0;

  const rawLines = source.split(/\r?\n/);

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const line = rawLines[i]!.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    lines++;

    const split = line.match(/^(\S+)\s+([\s\S]+)$/);
    const head = (split ? split[1]! : line).toLowerCase();
    const rest = split ? split[2]!.trim() : "";

    /* --- final ---------------------------------------------------------- */
    if (head === "final" || head === "default") {
      if (!rest) {
        errors.push(`line ${lineNo}: "${head}" needs a target`);
        continue;
      }
      const target = ctx.resolveTarget(rest);
      if (target.kind === "unknown") {
        errors.push(`line ${lineNo}: unknown target "${rest}"`);
      } else if (target.kind === "reject") {
        finalRejects = true;
      } else {
        final = target.outbound;
      }
      continue;
    }

    if (!rest) {
      errors.push(`line ${lineNo}: "${line}" has a target but nothing to match`);
      continue;
    }

    const target = ctx.resolveTarget(head);
    if (target.kind === "unknown") {
      errors.push(`line ${lineNo}: unknown target "${head}"`);
      continue;
    }
    const action: Pick<RouteRule, "action" | "outbound"> =
      target.kind === "reject" ? { action: "reject" } : { action: "route", outbound: target.outbound };

    /* --- matchers ------------------------------------------------------- */
    // Each comma group is one OR branch; `&` within a group is an AND.
    const orGroups = rest
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean)
      .map((g) => g.split("&").flatMap((t) => parseTerm(t, lineNo, errors)))
      .filter((terms) => terms.length > 0);

    if (orGroups.length === 0) {
      if (!errors.some((e) => e.startsWith(`line ${lineNo}:`))) {
        errors.push(`line ${lineNo}: no usable matcher`);
      }
      continue;
    }

    // Groups that are purely destination matchers can share one rule, because
    // sing-box ORs those fields. Anything else needs its own rule to stay OR.
    const plain: Term[] = [];
    const separate: Term[][] = [];
    for (const terms of orGroups) {
      const isPlainDest =
        terms.length === 1 &&
        terms[0]!.field !== "rule_set" &&
        terms[0]!.field !== "port" &&
        terms[0]!.field !== "port_range" &&
        terms[0]!.field !== "process_name" &&
        terms[0]!.field !== "ip_is_private";
      if (isPlainDest) plain.push(terms[0]!);
      else separate.push(terms);
    }

    const emit = (terms: Term[]): void => {
      const rule: RouteRule = { ...action };
      for (const term of terms) {
        switch (term.field) {
          case "rule_set": {
            const tag = `${term.kind}-${term.name}`;
            needed.set(tag, { kind: term.kind, name: term.name });
            rule.rule_set = [...(rule.rule_set ?? []), tag];
            break;
          }
          case "ip_is_private":
            rule.ip_is_private = true;
            break;
          case "port":
            rule.port = [...(rule.port ?? []), term.value];
            break;
          case "port_range":
            rule.port_range = [...(rule.port_range ?? []), term.value];
            break;
          case "process_name":
            rule.process_name = [...(rule.process_name ?? []), term.value];
            break;
          default:
            rule[term.field] = [...(rule[term.field] ?? []), term.value];
        }
      }
      rules.push(rule);
    };

    if (plain.length > 0) emit(plain);
    for (const terms of separate) emit(terms);
  }

  if (lines === 0) warnings.push("No rules were found in the custom ruleset.");

  /* --- rule sets -------------------------------------------------------- */
  const urls =
    ctx.ruleSetSource === "sagernet"
      ? {
          geosite: (n: string) =>
            `https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-${n}.srs`,
          geoip: (n: string) =>
            `https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-${n}.srs`,
        }
      : {
          geosite: (n: string) =>
            `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/${n}.srs`,
          geoip: (n: string) =>
            `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geoip/${n}.srs`,
        };

  const ruleSets: RuleSet[] = [...needed.entries()].map(([tag, { kind, name }]) => ({
    type: "remote" as const,
    tag,
    format: "binary" as const,
    url: urls[kind](name),
    update_interval: ctx.ruleSetUpdateInterval,
    ...(ctx.ruleSetDownloadDetour ? { download_detour: ctx.ruleSetDownloadDetour } : {}),
  }));

  return {
    rules,
    ruleSets,
    ...(final ? { final } : {}),
    finalRejects,
    errors,
    warnings,
    stats: { lines, emitted: rules.length },
  };
}
