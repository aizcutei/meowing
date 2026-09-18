/**
 * Orchestrates a full Clash YAML -> sing-box JSON conversion.
 *
 * Beyond wiring the other modules together, this is where two whole-config
 * concerns live: choosing which group acts as "the proxy" (referenced by
 * `route.final`, the Global rule and proxied DNS), and a final pass that drops
 * dangling outbound references so the generated config actually starts.
 */

import { parseClashConfig, type ClashProxy } from "./clash";
import { BLOCK_TAG, DIRECT_TAG, convertGroups, resolveBuiltinTarget } from "./groups";
import { UnsupportedProxyError, convertProxy } from "./outbounds";
import type { ConvertOptions } from "./options";
import { convertRules, type RuleTarget, type RulesResult } from "./rules";
import type {
  Outbound,
  ProxyOutbound,
  RouteRule,
  RuleSet,
  SelectorOutbound,
  SingBoxConfig,
  UrlTestOutbound,
} from "./singbox";
import {
  LOCAL_DNS_TAG,
  buildDns,
  buildExperimental,
  buildInbounds,
  buildLeadingRules,
  buildLog,
  buildTrailingRules,
} from "./template";

const AUTO_SELECT_TAG = "⚡ 自动选择";
const FALLBACK_SELECT_TAG = "🚀 节点选择";
const TEST_URL = "https://www.gstatic.com/generate_204";

export interface ConvertStats {
  proxiesIn: number;
  proxiesOut: number;
  proxiesSkipped: number;
  groupsIn: number;
  groupsOut: number;
  rulesIn: number;
  rulesOut: number;
  rulesSkipped: number;
  ruleSets: number;
}

export interface ConvertResult {
  config: SingBoxConfig;
  warnings: string[];
  stats: ConvertStats;
}

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversionError";
  }
}

function uniqueTag(base: string, used: Set<string>): string {
  const cleaned = base.trim() === "" ? "proxy" : base.trim();
  if (!used.has(cleaned)) {
    used.add(cleaned);
    return cleaned;
  }
  let n = 2;
  while (used.has(`${cleaned} #${n}`)) n++;
  const tag = `${cleaned} #${n}`;
  used.add(tag);
  return tag;
}

/* --------------------------------------------------------- region grouping */

/**
 * Region detection for the optional per-region groups.
 *
 * Keywords are checked before flag emoji on purpose: subscriptions frequently
 * label Taiwanese nodes with 🇨🇳, so the text is the more reliable signal.
 */
const REGIONS: Array<{ label: string; keywords: string[]; flags: string[] }> = [
  { label: "🇭🇰 香港", keywords: ["香港", "hong kong", "hongkong", "hk"], flags: ["🇭🇰"] },
  { label: "🇹🇼 台湾", keywords: ["台湾", "台灣", "taiwan", "tw"], flags: ["🇹🇼"] },
  { label: "🇯🇵 日本", keywords: ["日本", "japan", "jp", "tokyo", "osaka"], flags: ["🇯🇵"] },
  { label: "🇸🇬 新加坡", keywords: ["新加坡", "狮城", "singapore", "sg"], flags: ["🇸🇬"] },
  { label: "🇰🇷 韩国", keywords: ["韩国", "韓國", "korea", "kr", "seoul"], flags: ["🇰🇷"] },
  { label: "🇺🇸 美国", keywords: ["美国", "美國", "united states", "usa", "us"], flags: ["🇺🇸", "🇺🇲"] },
  { label: "🇬🇧 英国", keywords: ["英国", "英國", "united kingdom", "uk", "london"], flags: ["🇬🇧"] },
  { label: "🇩🇪 德国", keywords: ["德国", "德國", "germany", "de"], flags: ["🇩🇪"] },
  { label: "🇫🇷 法国", keywords: ["法国", "法國", "france", "fr"], flags: ["🇫🇷"] },
  { label: "🇨🇦 加拿大", keywords: ["加拿大", "canada", "ca"], flags: ["🇨🇦"] },
  { label: "🇦🇺 澳大利亚", keywords: ["澳大利亚", "澳洲", "australia", "au"], flags: ["🇦🇺"] },
  { label: "🇷🇺 俄罗斯", keywords: ["俄罗斯", "俄羅斯", "russia", "ru"], flags: ["🇷🇺"] },
  { label: "🇮🇳 印度", keywords: ["印度", "india", "in"], flags: ["🇮🇳"] },
  { label: "🇹🇷 土耳其", keywords: ["土耳其", "turkey", "tr"], flags: ["🇹🇷"] },
];

function detectRegion(name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const region of REGIONS) {
    if (region.keywords.some((k) => lower.includes(k))) return region.label;
  }
  for (const region of REGIONS) {
    if (region.flags.some((f) => name.includes(f))) return region.label;
  }
  return undefined;
}

/* ---------------------------------------------------------------- pipeline */

export function convertClashToSingBox(
  clashText: string,
  options: ConvertOptions,
): ConvertResult {
  const warnings: string[] = [];
  const warn = (msg: string) => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  const { config: clash, warnings: parseWarnings } = parseClashConfig(clashText);
  warnings.push(...parseWarnings);

  /* --- proxies ---------------------------------------------------------- */

  const usedTags = new Set<string>([DIRECT_TAG, BLOCK_TAG, "dns"]);
  const proxyTags = new Map<string, string>();
  const proxyOutbounds: ProxyOutbound[] = [];
  const convertedProxies: ClashProxy[] = [];
  const skipReasons = new Map<string, number>();

  for (const proxy of clash.proxies) {
    const tag = uniqueTag(proxy.name, usedTags);
    try {
      const converted = convertProxy(proxy, tag, (msg) => warn(`${proxy.name}: ${msg}`));
      proxyOutbounds.push(...converted.outbounds);
      proxyTags.set(proxy.name, converted.tag);
      convertedProxies.push(proxy);
    } catch (err) {
      usedTags.delete(tag);
      const reason =
        err instanceof UnsupportedProxyError ? err.message : `unexpected error: ${String(err)}`;
      skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
    }
  }

  for (const [reason, count] of [...skipReasons].sort((a, b) => b[1] - a[1])) {
    warn(count > 1 ? `Skipped ${count} nodes: ${reason}` : `Skipped a node: ${reason}`);
  }

  if (proxyTags.size === 0) {
    throw new ConversionError(
      "None of the proxies in this subscription can be represented in sing-box.",
    );
  }

  /* --- synthetic groups ------------------------------------------------- */

  const allProxyTags = [...proxyTags.values()];
  const syntheticGroups: Array<SelectorOutbound | UrlTestOutbound> = [];

  let autoTag: string | undefined;
  if (options.addAutoSelect) {
    autoTag = uniqueTag(AUTO_SELECT_TAG, usedTags);
    syntheticGroups.push({
      type: "urltest",
      tag: autoTag,
      outbounds: allProxyTags,
      url: TEST_URL,
      interval: "3m",
      tolerance: 50,
    });
  }

  const regionTags: string[] = [];
  if (options.addRegionGroups) {
    const byRegion = new Map<string, string[]>();
    for (const proxy of convertedProxies) {
      const region = detectRegion(proxy.name);
      const tag = proxyTags.get(proxy.name);
      if (!region || !tag) continue;
      const bucket = byRegion.get(region);
      if (bucket) bucket.push(tag);
      else byRegion.set(region, [tag]);
    }
    for (const [region, tags] of byRegion) {
      // A one-node "group" adds a layer of indirection for no benefit.
      if (tags.length < 2) continue;
      const tag = uniqueTag(region, usedTags);
      regionTags.push(tag);
      syntheticGroups.push({
        type: "urltest",
        tag,
        outbounds: tags,
        url: TEST_URL,
        interval: "3m",
        tolerance: 50,
      });
    }
    if (regionTags.length === 0) {
      warn("Could not infer any regions from the node names; no region groups were added.");
    }
  }

  /* --- source groups ---------------------------------------------------- */

  const groupTags = new Map<string, string>();
  for (const group of clash.groups) {
    groupTags.set(group.name, uniqueTag(group.name, usedTags));
  }

  const groupsResult = convertGroups(clash.groups, {
    proxies: convertedProxies,
    proxyTags,
    groupTags,
    warn,
  });
  for (const dropped of groupsResult.droppedGroups) groupTags.delete(dropped);

  const groupOutbounds = [...groupsResult.outbounds];

  /* --- pick the main proxy group ---------------------------------------- */

  // Parse the source rules once with a permissive resolver so we can see which
  // group `MATCH` points at before deciding what "the proxy" is.
  const matchTarget = findMatchTarget(clash.rules);
  let mainTag: string | undefined;
  if (matchTarget) {
    const resolved = groupTags.get(matchTarget) ?? proxyTags.get(matchTarget);
    if (resolved && resolved !== DIRECT_TAG) mainTag = resolved;
  }
  mainTag ??= firstSelectorTag(clash, groupTags);

  if (!mainTag) {
    // Subscriptions that ship only a `proxies:` list still need something
    // selectable, and `route.final` cannot point at a bare node list.
    mainTag = uniqueTag(FALLBACK_SELECT_TAG, usedTags);
    const members = [...(autoTag ? [autoTag] : []), ...regionTags, ...allProxyTags, DIRECT_TAG];
    groupOutbounds.unshift({ type: "selector", tag: mainTag, outbounds: members });
    if (autoTag) {
      (groupOutbounds[0] as SelectorOutbound).default = autoTag;
    }
  } else {
    const main = groupOutbounds.find((g) => g.tag === mainTag);
    if (main) {
      // Make the synthetic groups reachable from the group the user actually sees,
      // and adopt any node no group mentions — otherwise nodes from a second
      // merged subscription, or ones the source simply forgot, are unselectable.
      const grouped = new Set(groupOutbounds.flatMap((g) => g.outbounds));
      const orphans = allProxyTags.filter((t) => !grouped.has(t));
      const extras = [...(autoTag ? [autoTag] : []), ...regionTags, ...orphans].filter(
        (t) => !main.outbounds.includes(t),
      );
      main.outbounds = [...extras, ...main.outbounds];
      if (autoTag && main.type === "selector" && !main.default) main.default = autoTag;
      if (orphans.length > 0) {
        warn(`${orphans.length} node(s) belonged to no group and were added to "${mainTag}".`);
      }
    }
  }

  /* --- rules ------------------------------------------------------------ */

  const resolveTarget = (name: string): RuleTarget => {
    const builtin = resolveBuiltinTarget(name);
    if (builtin === DIRECT_TAG) return { kind: "route", outbound: DIRECT_TAG };
    if (builtin === BLOCK_TAG) return { kind: "reject" };
    const groupTag = groupTags.get(name);
    if (groupTag) return { kind: "route", outbound: groupTag };
    const proxyTag = proxyTags.get(name);
    if (proxyTag) return { kind: "route", outbound: proxyTag };
    if (name.trim().toUpperCase() === "GLOBAL") return { kind: "route", outbound: mainTag! };
    return { kind: "skip", reason: "no such proxy or group" };
  };

  // Where the router fetches remote rule sets from. Under the 1.14 schema this
  // is declared once as an `http_clients` entry; 1.13 has no such concept and
  // needs the (now deprecated) per-rule-set `download_detour`.
  const downloadDetour = options.ruleSetDetour === "proxy" ? mainTag! : undefined;
  const legacyDownloadDetour =
    options.targetVersion === "1.13" ? (downloadDetour ?? DIRECT_TAG) : undefined;

  let rulesResult: RulesResult = {
    rules: [],
    ruleSets: [],
    finalRejects: false,
    stats: { parsed: 0, skipped: 0, emitted: 0 },
  };
  if (options.convertRules && clash.rules.length > 0) {
    rulesResult = convertRules(clash.rules, {
      resolveTarget,
      ruleProviders: clash.ruleProviders,
      ruleSetSource: options.ruleSetSource,
      ruleSetUpdateInterval: "1d",
      ...(legacyDownloadDetour ? { ruleSetDownloadDetour: legacyDownloadDetour } : {}),
      warn,
    });
  } else if (!options.convertRules) {
    warn("Source rules were not converted; only the built-in default rules apply.");
  }

  const dnsResult = buildDns(options, mainTag!);
  warnings.push(...dnsResult.warnings);

  /* --- rule sets -------------------------------------------------------- */

  const ruleSets = new Map<string, RuleSet>();
  for (const set of rulesResult.ruleSets) ruleSets.set(set.tag, set);
  const extraSets: Array<{ kind: "geosite" | "geoip"; name: string }> = [
    ...dnsResult.requiredRuleSets,
  ];
  if (options.addChinaDirect) {
    extraSets.push({ kind: "geosite", name: "cn" }, { kind: "geoip", name: "cn" });
  }
  if (options.blockAds) {
    extraSets.push({ kind: "geosite", name: "category-ads-all" });
  }
  for (const { kind, name } of extraSets) {
    const tag = `${kind}-${name}`;
    if (ruleSets.has(tag)) continue;
    ruleSets.set(tag, {
      type: "remote",
      tag,
      format: "binary",
      url:
        options.ruleSetSource === "sagernet"
          ? kind === "geosite"
            ? `https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-${name}.srs`
            : `https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-${name}.srs`
          : `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/${kind}/${name}.srs`,
      update_interval: "1d",
      ...(legacyDownloadDetour ? { download_detour: legacyDownloadDetour } : {}),
    });
  }

  /* --- assemble --------------------------------------------------------- */

  const outbounds: Outbound[] = [
    ...groupOutbounds,
    ...syntheticGroups,
    ...proxyOutbounds,
    { type: "direct", tag: DIRECT_TAG },
  ];
  if (groupsResult.needsBlock || rulesResult.rules.some((r) => r.action === "reject")) {
    outbounds.push({ type: "block", tag: BLOCK_TAG });
  }

  const routeRules: RouteRule[] = [
    ...buildLeadingRules(options, mainTag!),
    ...rulesResult.rules,
    ...buildTrailingRules(options),
  ];
  if (rulesResult.finalRejects) {
    // `MATCH,REJECT` cannot be expressed as `route.final`, which must name an
    // outbound; a matcher-less reject rule at the very end is equivalent.
    routeRules.push({ action: "reject" });
  }

  // Declaring the download client explicitly, even when it just dials directly,
  // avoids 1.14's "implicit default HTTP client using default outbound"
  // deprecation. 1.13 has no `http_clients`, so it uses `download_detour` above.
  const useHttpClient = options.targetVersion === "1.14" && ruleSets.size > 0;
  const httpClientTag = "rule-set-download";

  const config: SingBoxConfig = {
    log: buildLog(options),
    dns: dnsResult.dns,
    ...(useHttpClient
      ? {
          http_clients: [
            { tag: httpClientTag, ...(downloadDetour ? { detour: downloadDetour } : {}) },
          ],
        }
      : {}),
    inbounds: buildInbounds(options),
    outbounds,
    route: {
      rules: routeRules,
      rule_set: [...ruleSets.values()],
      final: rulesResult.final ?? mainTag!,
      auto_detect_interface: true,
      // Proxy server hostnames resolve through the direct resolver rather than
      // the system one: it is reached by IP, so it needs no bootstrapping, and it
      // cannot be hijacked by whatever the host's DNS currently points at.
      default_domain_resolver: { server: LOCAL_DNS_TAG },
      ...(useHttpClient ? { default_http_client: httpClientTag } : {}),
    },
  };
  const experimental = buildExperimental(options);
  if (experimental) config.experimental = experimental;

  const removed = pruneDanglingReferences(config, warn);
  if (removed > 0) {
    warn(`Removed ${removed} reference(s) to outbounds that no longer exist.`);
  }

  return {
    config,
    warnings,
    stats: {
      proxiesIn: clash.proxies.length,
      proxiesOut: proxyTags.size,
      proxiesSkipped: clash.proxies.length - proxyTags.size,
      groupsIn: clash.groups.length,
      groupsOut: groupOutbounds.length + syntheticGroups.length,
      rulesIn: clash.rules.length,
      rulesOut: rulesResult.rules.length,
      rulesSkipped: rulesResult.stats.skipped,
      ruleSets: ruleSets.size,
    },
  };
}

/** Reads the target of the trailing `MATCH` / `FINAL` rule, if there is one. */
function findMatchTarget(rules: string[]): string | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const parts = (rules[i] ?? "").split(",").map((p) => p.trim());
    const type = (parts[0] ?? "").toUpperCase();
    if (type === "MATCH" || type === "FINAL") return parts[1];
  }
  return undefined;
}

function firstSelectorTag(
  clash: { groups: Array<{ name: string; type: string }> },
  groupTags: Map<string, string>,
): string | undefined {
  for (const group of clash.groups) {
    if (group.type === "select") {
      const tag = groupTags.get(group.name);
      if (tag) return tag;
    }
  }
  for (const group of clash.groups) {
    const tag = groupTags.get(group.name);
    if (tag) return tag;
  }
  return undefined;
}

/**
 * Drops references to outbounds that were never emitted.
 *
 * sing-box refuses to start on an unknown tag, and a dropped node or group can
 * leave one behind in a selector or a rule. Anything that would be left empty
 * falls back to `direct` rather than being deleted, so the config stays valid.
 */
function pruneDanglingReferences(config: SingBoxConfig, warn: (msg: string) => void): number {
  const known = new Set((config.outbounds ?? []).map((o) => o.tag));
  let removed = 0;

  for (const outbound of config.outbounds ?? []) {
    if (outbound.type !== "selector" && outbound.type !== "urltest") continue;
    const kept = outbound.outbounds.filter((tag) => known.has(tag));
    removed += outbound.outbounds.length - kept.length;
    if (kept.length === 0) {
      warn(`group "${outbound.tag}" lost all of its members; it now points at direct.`);
      kept.push(DIRECT_TAG);
    }
    outbound.outbounds = kept;
    if (outbound.type === "selector" && outbound.default && !known.has(outbound.default)) {
      delete outbound.default;
    }
  }

  const rules = config.route?.rules;
  if (rules) {
    const kept = rules.filter((rule) => {
      if (rule.outbound == null || known.has(rule.outbound)) return true;
      removed++;
      return false;
    });
    config.route!.rules = kept;
  }

  if (config.route?.final && !known.has(config.route.final)) {
    config.route.final = DIRECT_TAG;
    removed++;
  }

  return removed;
}
