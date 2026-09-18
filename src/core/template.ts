/**
 * The parts of a sing-box config that do not come from the Clash source: DNS,
 * inbounds, the leading route rules and `experimental`.
 *
 * These are what turn a bag of outbounds into something a client can actually
 * run, and they are also where the 1.14 schema is strictest (new-style DNS
 * servers, a mandatory `route.default_domain_resolver`).
 */

import { DIRECT_TAG } from "./groups";
import type { ConvertOptions } from "./options";
import type {
  DnsOptions,
  DnsServer,
  Endpoint,
  ExperimentalOptions,
  Inbound,
  LogOptions,
  RouteRule,
  TailscaleEndpoint,
} from "./singbox";

/**
 * Tag of the always-present `local` (system) server. It exists to bootstrap DNS
 * servers that are themselves addressed by hostname; it is deliberately *not*
 * the default domain resolver, because the host's resolver may be pointed at
 * another proxy handing out FakeIP addresses.
 */
export const SYSTEM_DNS_TAG = "dns-system";
export const REMOTE_DNS_TAG = "dns-remote";
export const LOCAL_DNS_TAG = "dns-local";
export const FAKEIP_DNS_TAG = "dns-fakeip";
/** Second domestic resolver, only present when racing is on. */
export const LOCAL_DNS_ALT_TAG = "dns-local-alt";
export const TAILSCALE_DNS_TAG = "dns-tailscale";
/** Tag of the `tailscale` endpoint, shared by the route rules and the DNS server. */
export const TAILSCALE_TAG = "tailscale";

const FAKEIP_INET4 = "198.18.0.0/15";
const FAKEIP_INET6 = "fc00::/18";

/** Tailnet addresses (CGNAT) and MagicDNS names. */
export const TAILSCALE_CIDR = "100.64.0.0/10";
export const TAILSCALE_SUFFIX = "ts.net";

/**
 * Suffixes that must resolve to real addresses rather than FakeIP.
 *
 * This has to be expressed as domains, not IP ranges: the FakeIP decision is
 * made on the query, before any address is known, and sing-box rejects
 * `ip_cidr`/`ip_is_private` in DNS rules unless `match_response` is set.
 */
const LOCAL_SUFFIXES = ["local", "lan", "home.arpa", "internal"];
const REVERSE_ZONES = ["in-addr.arpa", "ip6.arpa"];

/**
 * The `china` preset. AliDNS speaks DoT at 223.5.5.5, so it is addressed by IP
 * with the hostname in `tls.server_name` — that avoids needing a resolver to
 * find the resolver. ByteDance publishes plain UDP/TCP only; its DoH/DoT is
 * still listed as planned, and TLS handshakes to 180.184.1.1:853 fail, so do not
 * emit an encrypted form for it.
 */
const PRESET_DOMESTIC: DnsServer = {
  type: "tls",
  tag: LOCAL_DNS_TAG,
  server: "223.5.5.5",
  server_port: 853,
  tls: { enabled: true, server_name: "dns.alidns.com" },
};
const PRESET_DOMESTIC_ALT: DnsServer = {
  type: "udp",
  tag: LOCAL_DNS_ALT_TAG,
  server: "180.184.1.1",
};
const PRESET_FOREIGN = (detour: string): DnsServer => ({
  type: "tls",
  tag: REMOTE_DNS_TAG,
  server: "8.8.8.8",
  server_port: 853,
  tls: { enabled: true, server_name: "dns.google" },
  detour,
});

/**
 * Parses a DNS server written as a URL into sing-box's 1.12+ server object.
 *
 * The pre-1.12 `{"address": "tls://1.1.1.1"}` form was *removed* in 1.14, so
 * the scheme has to become a `type` and the host a `server`.
 */
export function parseDnsServer(
  spec: string,
  tag: string,
  detour: string | undefined,
): DnsServer | undefined {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "local") return { type: "local", tag };

  const match = /^([a-z0-9+]+):\/\/(.+)$/i.exec(trimmed);
  if (!match?.[1] || !match[2]) return undefined;
  const scheme = match[1].toLowerCase();

  let url: URL;
  try {
    // Normalise via URL so IPv6 brackets, ports and paths are handled for us.
    url = new URL(`${scheme === "h3" ? "https" : scheme}://${match[2]}`);
  } catch {
    return undefined;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "") return undefined;
  const port = url.port === "" ? undefined : Number.parseInt(url.port, 10);

  switch (scheme) {
    case "udp":
    case "dns":
    case "tcp":
    case "tls":
    case "quic": {
      const server: DnsServer = {
        type: scheme === "dns" ? "udp" : (scheme as "udp" | "tcp" | "tls" | "quic"),
        tag,
        server: host,
      };
      if (port != null) server.server_port = port;
      if (detour) server.detour = detour;
      return server;
    }
    case "https":
    case "h3": {
      const server: DnsServer = { type: scheme === "h3" ? "h3" : "https", tag, server: host };
      if (port != null) server.server_port = port;
      // `/dns-query` is the default; only carry a path that differs.
      if (url.pathname !== "/dns-query" && url.pathname !== "/") server.path = url.pathname;
      if (detour) server.detour = detour;
      return server;
    }
    default:
      return undefined;
  }
}

/** True when a DNS server is addressed by name and therefore needs a resolver. */
function needsDomainResolver(server: DnsServer): boolean {
  return "server" in server && !/^[\d.]+$/.test(server.server) && !server.server.includes(":");
}

export interface DnsBuildResult {
  dns: DnsOptions;
  /** Rule-set tags the DNS rules reference; the caller must register them. */
  requiredRuleSets: Array<{ kind: "geosite" | "geoip"; name: string }>;
  warnings: string[];
}

/**
 * Builds the DNS section.
 *
 * `proxyTag` is the outbound proxied DNS is sent through — usually the main
 * selector, so that switching node in a GUI also switches the resolver.
 */
export function buildDns(options: ConvertOptions, proxyTag: string): DnsBuildResult {
  const warnings: string[] = [];
  const servers: DnsServer[] = [];
  const requiredRuleSets: DnsBuildResult["requiredRuleSets"] = [];

  if (options.dnsPreset === "china") {
    servers.push(PRESET_FOREIGN(proxyTag), { ...PRESET_DOMESTIC });
    // The second domestic resolver only earns its place if it is actually raced.
    if (options.dnsRace) servers.push({ ...PRESET_DOMESTIC_ALT });
  } else {
    const remote = parseDnsServer(options.remoteDns, REMOTE_DNS_TAG, proxyTag);
    if (remote) {
      servers.push(remote);
    } else {
      warnings.push(`could not parse remote DNS "${options.remoteDns}"; used https://1.1.1.1`);
      servers.push({ type: "https", tag: REMOTE_DNS_TAG, server: "1.1.1.1", detour: proxyTag });
    }

    // No `detour` on purpose: a DNS server without one already dials directly, and
    // sing-box refuses to start when a detour points at a plain `direct` outbound
    // ("detour to an empty direct outbound makes no sense").
    const local = parseDnsServer(options.localDns, LOCAL_DNS_TAG, undefined);
    if (local) {
      servers.push(local);
    } else {
      warnings.push(`could not parse local DNS "${options.localDns}"; used https://223.5.5.5`);
      servers.push({ type: "https", tag: LOCAL_DNS_TAG, server: "223.5.5.5" });
    }
  }

  if (options.tailscale) {
    // Resolves MagicDNS names through the tailnet. `accept_default_resolvers`
    // stays off so the tailnet does not become the resolver for everything;
    // `accept_search_domain` does not exist before 1.14.
    servers.push({
      type: "tailscale",
      tag: TAILSCALE_DNS_TAG,
      endpoint: TAILSCALE_TAG,
      accept_default_resolvers: false,
      ...(options.targetVersion === "1.14" ? { accept_search_domain: true } : {}),
    });
  }

  // The system resolver bootstraps everything else: proxy server hostnames and
  // any DNS server given as a name rather than an address.
  servers.push({ type: "local", tag: SYSTEM_DNS_TAG });
  for (const server of servers) {
    if (needsDomainResolver(server)) {
      (server as { domain_resolver?: { server: string } }).domain_resolver = {
        server: SYSTEM_DNS_TAG,
      };
    }
  }

  if (options.fakeIp) {
    servers.push({
      type: "fakeip",
      tag: FAKEIP_DNS_TAG,
      inet4_range: FAKEIP_INET4,
      inet6_range: FAKEIP_INET6,
    });
  }

  const rules: DnsOptions["rules"] = [];

  // Tailnet names first: they are only answerable by the tailnet, and they must
  // get real CGNAT addresses so the route rules can match them.
  if (options.tailscale) {
    // `preferred_by` reaches DNS rules only in 1.14 — 1.13 accepts it on route
    // rules but rejects the key here — so 1.13 gets the suffix match alone and
    // loses dynamic MagicDNS matching.
    if (options.targetVersion === "1.14") {
      rules.push({ preferred_by: [TAILSCALE_DNS_TAG], server: TAILSCALE_DNS_TAG });
    }
    rules.push({ domain_suffix: [TAILSCALE_SUFFIX], server: TAILSCALE_DNS_TAG });
  }

  // LAN names and reverse lookups need real answers too, so they go ahead of
  // anything that could hand back a fake address.
  if (options.realIpLocal) {
    rules.push({ domain_suffix: [...LOCAL_SUFFIXES], server: SYSTEM_DNS_TAG });
    rules.push({ domain_keyword: [...REVERSE_ZONES], server: SYSTEM_DNS_TAG });
  }

  rules.push({ clash_mode: "Direct", server: LOCAL_DNS_TAG });
  rules.push({ clash_mode: "Global", server: REMOTE_DNS_TAG });

  if (options.addChinaDirect) {
    if (options.dnsRace) {
      // Ask both domestic resolvers at once and take the first usable answer.
      // `evaluate` stores a response without ending rule matching; the `race`
      // rules then settle on whichever arrived first, so a resolver that is slow
      // or returns NXDOMAIN cannot hold up the query.
      rules.push({ action: "evaluate", server: LOCAL_DNS_TAG, tag: "cn", rule_set: ["geosite-cn"] });
      rules.push({
        action: "evaluate",
        server: LOCAL_DNS_ALT_TAG,
        tag: "cn-alt",
        rule_set: ["geosite-cn"],
      });
      rules.push({ match_response: "cn", response_rcode: "NOERROR", race: true, action: "respond" });
      rules.push({
        match_response: "cn-alt",
        response_rcode: "NOERROR",
        race: true,
        action: "respond",
      });
    } else {
      rules.push({ rule_set: ["geosite-cn"], server: LOCAL_DNS_TAG });
    }
    requiredRuleSets.push({ kind: "geosite", name: "cn" });
  }

  if (options.fakeIp) {
    // Whatever is left is proxied, so it never needs a real address: hand out a
    // fake one and let sing-box map it back to the hostname on connect. This is
    // last on purpose — every rule above is an exemption from FakeIP.
    rules.push({ query_type: ["A", "AAAA"], server: FAKEIP_DNS_TAG });
  }

  const dns: DnsOptions = {
    servers,
    rules,
    final: REMOTE_DNS_TAG,
    strategy: options.dnsStrategy,
  };
  if (options.fakeIp && options.targetVersion === "1.13") {
    // FakeIP addresses must not be cached as if they were real answers. 1.14 always
    // keys the cache by transport, which makes the option meaningless and deprecated.
    dns.independent_cache = true;
  }

  return { dns, requiredRuleSets, warnings };
}

export function buildLog(options: ConvertOptions): LogOptions {
  return { level: options.logLevel, timestamp: true };
}

export function buildInbounds(options: ConvertOptions): Inbound[] {
  const inbounds: Inbound[] = [];

  if (options.tun) {
    inbounds.push({
      type: "tun",
      tag: "tun-in",
      address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
      mtu: 9000,
      auto_route: true,
      strict_route: true,
      stack: options.tunStack,
    });
  }

  if (options.mixed) {
    inbounds.push({
      type: "mixed",
      tag: "mixed-in",
      listen: "127.0.0.1",
      listen_port: options.mixedPort,
    });
  }

  return inbounds;
}

/**
 * Route rules that must precede the converted ones.
 *
 * `action: "sniff"` is what makes domain rules work at all for TUN traffic
 * (sing-box 1.11 moved sniffing out of the inbound config), and `hijack-dns`
 * captures the DNS queries a TUN inbound receives.
 */
export function buildLeadingRules(options: ConvertOptions, proxyTag: string): RouteRule[] {
  const rules: RouteRule[] = [{ action: "sniff" }];

  if (options.tun) {
    rules.push({ protocol: ["dns"], action: "hijack-dns" });
  }

  // Tailnet traffic is decided before anything else, so it can never be caught by
  // an ad-block or LAN rule on its way out. `preferred_by` covers MagicDNS names
  // and peers' advertised subnet routes; the CGNAT range is the backstop for
  // before the endpoint has finished coming up, when `preferred_by` matches
  // nothing. Note this still traverses the endpoint as a proxied connection —
  // sing-box has no layer-3 forwarding action.
  if (options.tailscale) {
    rules.push({ preferred_by: [TAILSCALE_TAG], outbound: TAILSCALE_TAG });
    rules.push({ ip_cidr: [TAILSCALE_CIDR], outbound: TAILSCALE_TAG });
    rules.push({ domain_suffix: [TAILSCALE_SUFFIX], outbound: TAILSCALE_TAG });
  }

  if (options.blockAds) {
    rules.push({ rule_set: ["geosite-category-ads-all"], action: "reject" });
  }

  rules.push({ ip_is_private: true, outbound: DIRECT_TAG });
  rules.push({ clash_mode: "Direct", outbound: DIRECT_TAG });
  rules.push({ clash_mode: "Global", outbound: proxyTag });

  return rules;
}

/**
 * The `endpoints` array. Empty unless Tailscale is on.
 *
 * `auth_key` is optional by design: without one sing-box prints a login URL on
 * first start, which keeps the key out of the subscription link.
 */
export function buildEndpoints(options: ConvertOptions): Endpoint[] {
  if (!options.tailscale) return [];

  const endpoint: TailscaleEndpoint = {
    type: "tailscale",
    tag: TAILSCALE_TAG,
    state_directory: options.tailscaleStateDir,
    accept_routes: options.tailscaleAcceptRoutes,
  };
  if (options.tailscaleAuthKey) endpoint.auth_key = options.tailscaleAuthKey;
  if (options.tailscaleHostname) endpoint.hostname = options.tailscaleHostname;
  if (options.tailscaleExitNode) {
    endpoint.exit_node = options.tailscaleExitNode;
    endpoint.exit_node_allow_lan_access = true;
  }
  return [endpoint];
}

/** Route rules appended after the converted ones, just before `final` applies. */
export function buildTrailingRules(options: ConvertOptions): RouteRule[] {
  if (!options.addChinaDirect) return [];
  return [
    { rule_set: ["geosite-cn"], outbound: DIRECT_TAG },
    { rule_set: ["geoip-cn"], outbound: DIRECT_TAG },
  ];
}

export function buildExperimental(options: ConvertOptions): ExperimentalOptions | undefined {
  const experimental: ExperimentalOptions = {
    cache_file: { enabled: true, store_fakeip: options.fakeIp },
  };
  if (options.clashApi) {
    experimental.clash_api = {
      external_controller: "127.0.0.1:9090",
      external_ui: "ui",
      external_ui_download_url:
        "https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip",
      default_mode: "rule",
    };
  }
  return experimental;
}
