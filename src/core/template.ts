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
  ExperimentalOptions,
  Inbound,
  LogOptions,
  RouteRule,
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

const FAKEIP_INET4 = "198.18.0.0/15";
const FAKEIP_INET6 = "fc00::/18";

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

  const rules: DnsOptions["rules"] = [
    { clash_mode: "Direct", server: LOCAL_DNS_TAG },
    { clash_mode: "Global", server: REMOTE_DNS_TAG },
  ];

  if (options.addChinaDirect) {
    rules.push({ rule_set: ["geosite-cn"], server: LOCAL_DNS_TAG });
    requiredRuleSets.push({ kind: "geosite", name: "cn" });
  }

  if (options.fakeIp) {
    // Everything that reaches this point is proxied, so hand it a fake address
    // and let sing-box map it back to the hostname when the connection is made.
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
  rules.push({ ip_is_private: true, outbound: DIRECT_TAG });
  rules.push({ clash_mode: "Direct", outbound: DIRECT_TAG });
  rules.push({ clash_mode: "Global", outbound: proxyTag });

  if (options.blockAds) {
    rules.push({ rule_set: ["geosite-category-ads-all"], action: "reject" });
  }

  return rules;
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
