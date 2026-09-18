import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { convertClashToSingBox } from "../src/core/convert";
import { parseClashConfig } from "../src/core/clash";
import { DEFAULT_OPTIONS, normaliseOptions, packOptions, unpackOptions } from "../src/core/options";
import { splitRuleLine } from "../src/core/rules";
import type { SingBoxConfig } from "../src/core/singbox";
import { readFileSync } from "node:fs";

/**
 * A real provider subscription — 46 nodes, 11 groups, 9,816 rules — with every
 * server address, password and UUID replaced by a placeholder. The scale is the
 * point: it is what the rule-merging in `rules.ts` exists for.
 */
const EXAMPLE = readFileSync(
  new URL("./fixtures/clash-subscription.yaml", import.meta.url),
  "utf8",
);

/** sing-box binaries fetched by `scripts/fetch-singbox.sh`, if present. */
const BINARIES = ["1.14.1", "1.13.21"]
  .map((version) => ({
    version,
    path: new URL(`../.tools/sing-box-${version}`, import.meta.url).pathname,
  }))
  .filter((entry) => existsSync(entry.path));

const workDir = mkdtempSync(join(tmpdir(), "meowing-"));

/**
 * Runs `sing-box check` against a generated config.
 *
 * This is the assertion that really matters: the schema is large, changes
 * between releases, and hand-written expectations drift. The binary is the spec.
 *
 * `versions` defaults to the 1.14 line, because that is what `targetVersion`
 * defaults to and a 1.14-targeted config uses `http_clients`, which 1.13 rejects.
 *
 * Deprecation warnings are failures on the version the config targets: sing-box
 * removes deprecated options two minors later, so emitting one means the output
 * has a known expiry date. They are tolerated on other lines, since targeting
 * 1.13 means deliberately using options that 1.14 has since deprecated.
 */
function singBoxCheck(
  config: SingBoxConfig,
  name: string,
  versions = ["1.14.1"],
  target = "1.14",
): void {
  const applicable = BINARIES.filter((b) => versions.includes(b.version));
  if (applicable.length === 0) {
    console.warn(`sing-box ${versions.join("/")} not found in .tools/; skipping validation`);
    return;
  }
  const file = join(workDir, `${name}.json`);
  writeFileSync(file, JSON.stringify(config, null, 2));

  for (const { version, path } of applicable) {
    // spawnSync, not execFileSync: warnings go to stderr with a zero exit, so
    // stderr has to be captured on success too.
    const result = spawnSync(path, ["check", "-c", file], { encoding: "utf8" });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/\u001B\[[\d;]*m/g, "");

    if (result.status !== 0) {
      throw new Error(`sing-box ${version} rejected "${name}":\n${output}`);
    }
    if (version.startsWith(`${target}.`)) {
      const deprecated = output.split("\n").filter((line) => /deprecated/i.test(line));
      if (deprecated.length > 0) {
        throw new Error(
          `sing-box ${version} reported deprecations for "${name}" (target ${target}):\n` +
            deprecated.join("\n"),
        );
      }
    }
  }
}

/**
 * Actually starts sing-box.
 *
 * `check` only validates and constructs the config; it does not run the startup
 * path, and it happily accepted a DNS server whose `detour` pointed at the plain
 * `direct` outbound — which sing-box rejects on boot. Only a real run catches
 * that class of bug, so the happy path is booted for a few seconds.
 */
function singBoxRun(config: SingBoxConfig, name: string): void {
  const binary = BINARIES[0];
  if (!binary) return;

  const dir = mkdtempSync(join(tmpdir(), `meowing-run-${name}-`));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(config, null, 2));

  let output = "";
  try {
    // Exits 0 on a clean shutdown, so a timeout kill is the success case.
    output = execFileSync(
      "/bin/sh",
      ["-c", `"${binary.path}" run -c "${file}" -D "${dir}" 2>&1 & pid=$!; sleep 8; kill $pid`],
      { encoding: "utf8", timeout: 60_000 },
    );
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string };
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  // Strip ANSI colouring before matching on level names.
  const clean = output.replace(/\u001B\[[\d;]*m/g, "");
  const fatal = clean.split("\n").filter((line) => /\bFATAL\b|\bPANIC\b/.test(line));
  if (fatal.length > 0) {
    throw new Error(`sing-box ${binary.version} failed to start "${name}":\n${clean}`);
  }
  if (!/started|sing-box started/i.test(clean)) {
    throw new Error(`sing-box ${binary.version} never reported startup for "${name}":\n${clean}`);
  }
}

describe("Clash parsing", () => {
  it("reads the example subscription", () => {
    const { config } = parseClashConfig(EXAMPLE);
    expect(config.proxies.length).toBeGreaterThan(40);
    expect(config.groups.length).toBe(11);
    expect(config.rules.length).toBeGreaterThan(9000);
  });

  it("rejects documents that are not Clash configs", () => {
    expect(() => parseClashConfig("hello: world")).toThrow(/proxies/);
    expect(() => parseClashConfig("[1, 2, 3]")).toThrow(/mapping/);
  });

  it("normalises loose scalars and legacy transport keys", () => {
    const { config } = parseClashConfig(`
proxies:
  - name: legacy
    type: vmess
    server: example.com
    port: "443"
    uuid: b831381d-6324-4d53-ad4f-8cda48b30811
    tls: "true"
    network: ws
    ws-path: /legacy
    ws-headers:
      Host: legacy.example.com
`);
    const proxy = config.proxies[0]!;
    expect(proxy.port).toBe(443);
    expect(proxy["ws-opts"]).toEqual({ path: "/legacy", headers: { Host: "legacy.example.com" } });
  });
});

describe("rule line splitting", () => {
  it("keeps commas inside regex quantifiers out of the target", () => {
    expect(splitRuleLine("DOMAIN-REGEX,^ad{1,3}\\.example\\.com$,REJECT")).toEqual({
      type: "DOMAIN-REGEX",
      value: "^ad{1,3}\\.example\\.com$",
      target: "REJECT",
      modifiers: [],
    });
  });

  it("peels trailing modifiers", () => {
    expect(splitRuleLine("IP-CIDR,1.2.3.0/24,DIRECT,no-resolve")).toEqual({
      type: "IP-CIDR",
      value: "1.2.3.0/24",
      target: "DIRECT",
      modifiers: ["no-resolve"],
    });
  });
});

describe("options packing", () => {
  it("round-trips through the stateless link format", () => {
    const options = { ...DEFAULT_OPTIONS, fakeIp: true, mixedPort: 7890, blockAds: true };
    const packed = packOptions(options);
    expect(packed).toBeTypeOf("string");
    expect(unpackOptions(packed).options).toEqual(options);
  });

  it("omits defaults entirely", () => {
    expect(packOptions(DEFAULT_OPTIONS)).toBeUndefined();
  });

  it("repairs impossible combinations", () => {
    const { options, rejected } = normaliseOptions({ tun: false, mixed: false });
    expect(options.mixed).toBe(true);
    expect(rejected.join(" ")).toMatch(/inbound/);
  });

  it("refuses a DNS value that is not a plain URL", () => {
    const { options, rejected } = normaliseOptions({ remoteDns: 'https://x/" , "evil": "1' });
    expect(options.remoteDns).toBe(DEFAULT_OPTIONS.remoteDns);
    expect(rejected.join(" ")).toMatch(/remoteDns/);
  });
});

describe("conversion of the example subscription", () => {
  const result = convertClashToSingBox(EXAMPLE, DEFAULT_OPTIONS);

  it("converts every node", () => {
    expect(result.stats.proxiesSkipped).toBe(0);
    expect(result.stats.proxiesOut).toBe(result.stats.proxiesIn);
  });

  it("collapses the rule list by orders of magnitude", () => {
    expect(result.stats.rulesIn).toBeGreaterThan(9000);
    expect(result.stats.rulesOut).toBeLessThan(80);
  });

  it("keeps every outbound reference resolvable", () => {
    const tags = new Set(result.config.outbounds!.map((o) => o.tag));
    for (const outbound of result.config.outbounds!) {
      if (outbound.type === "selector" || outbound.type === "urltest") {
        for (const member of outbound.outbounds) expect(tags).toContain(member);
      }
    }
    for (const rule of result.config.route!.rules!) {
      if (rule.outbound) expect(tags).toContain(rule.outbound);
    }
    expect(tags).toContain(result.config.route!.final);
  });

  it("declares every rule_set it references", () => {
    const declared = new Set(result.config.route!.rule_set!.map((s) => s.tag));
    const referenced = [
      ...result.config.route!.rules!.flatMap((r) => r.rule_set ?? []),
      ...(result.config.dns!.rules ?? []).flatMap((r) => r.rule_set ?? []),
    ];
    for (const tag of referenced) expect(declared).toContain(tag);
  });

  it("preserves Clash rule ordering when merging", () => {
    // In the source, `DOMAIN-KEYWORD,steampipe,DIRECT` follows
    // `DOMAIN-SUFFIX,cm.steampowered.com,<Steam group>`. Merging must not hoist
    // the keyword rule above the suffix rule, or Steam logins break.
    const rules = result.config.route!.rules!;
    const keywordIndex = rules.findIndex((r) => r.domain_keyword?.includes("steampipe"));
    const suffixIndex = rules.findIndex((r) =>
      r.domain_suffix?.includes("cm.steampowered.com"),
    );
    expect(suffixIndex).toBeGreaterThanOrEqual(0);
    expect(keywordIndex).toBeGreaterThan(suffixIndex);
  });

  it("is accepted by sing-box", () => {
    singBoxCheck(result.config, "example-default");
  });
});

describe("sing-box actually starts", () => {
  // Local, unreachable servers: the point is exercising the startup path (DNS
  // servers, rule-set loading, inbound binding), not dialling anything real.
  const yaml = `
proxies:
  - {name: ss-node, type: ss, server: 127.0.0.1, port: 18388, cipher: aes-256-gcm, password: pw}
  - {name: vmess-node, type: vmess, server: 127.0.0.1, port: 18389, uuid: b831381d-6324-4d53-ad4f-8cda48b30811, cipher: auto}
proxy-groups:
  - {name: PROXY, type: select, proxies: [ss-node, vmess-node, DIRECT]}
rules:
  - DOMAIN-SUFFIX,google.com,PROXY
  - GEOIP,CN,DIRECT,no-resolve
  - MATCH,PROXY
`;

  // Remote rule sets are fetched at startup, which would make these tests depend
  // on reaching GitHub; the URLs are covered by `rule set URLs` below instead.
  const noRuleSets = { convertRules: false, addChinaDirect: false, blockAds: false };

  it("boots a mixed-inbound config", () => {
    // TUN would need elevated privileges, so only the mixed inbound is enabled.
    const { options } = normaliseOptions({
      ...noRuleSets,
      tun: false,
      mixed: true,
      mixedPort: 12080,
    });
    singBoxRun(convertClashToSingBox(yaml, options).config, "mixed");
  });

  it("boots with FakeIP disabled and a plain DNS pair", () => {
    const { options } = normaliseOptions({
      ...noRuleSets,
      tun: false,
      mixed: true,
      mixedPort: 12081,
      remoteDns: "tls://8.8.8.8",
      localDns: "udp://223.5.5.5",
    });
    singBoxRun(convertClashToSingBox(yaml, options).config, "plain-dns");
  });
});

describe("option variations produce valid configs", () => {
  const variations: Array<[string, Partial<typeof DEFAULT_OPTIONS>]> = [
    ["tun-only", { mixed: false }],
    ["mixed-only", { tun: false }],
    ["fakeip", { fakeIp: true }],
    ["no-clash-api", { clashApi: false }],
    ["block-ads", { blockAds: true }],
    ["regions", { addRegionGroups: true }],
    ["no-auto-select", { addAutoSelect: false }],
    ["no-rules", { convertRules: false }],
    ["no-china-direct", { addChinaDirect: false }],
    ["metacubex", { ruleSetSource: "metacubex" as const }],
    ["gvisor", { tunStack: "gvisor" as const }],
    ["ipv6", { dnsStrategy: "prefer_ipv6" as const }],
    ["plain-dns", { remoteDns: "tls://8.8.8.8", localDns: "udp://223.5.5.5" }],
    ["direct-rulesets", { ruleSetDetour: "direct" as const }],
    ["dns-manual", { dnsPreset: "manual" as const }],
    ["dns-no-race", { dnsRace: false }],
    ["tailscale", { tailscale: true }],
    ["tailscale-fakeip", { tailscale: true, fakeIp: true, realIpLocal: true }],
    ["tailscale-exit-node", { tailscale: true, tailscaleExitNode: "exit-1" }],
    ["no-real-ip-local", { fakeIp: true, realIpLocal: false }],
    [
      "custom-rules-replace",
      {
        customRulesMode: "replace" as const,
        customRules: "reject ads\ndirect lan, tailscale\nproxy geosite:geolocation-!cn\nfinal proxy",
      },
    ],
    [
      "custom-rules-after",
      { customRulesMode: "after" as const, customRules: "direct suffix:corp.internal" },
    ],
  ];

  for (const [name, overrides] of variations) {
    it(name, () => {
      const { options } = normaliseOptions({ ...DEFAULT_OPTIONS, ...overrides });
      const result = convertClashToSingBox(EXAMPLE, options);
      singBoxCheck(result.config, `example-${name}`);
    });
  }

  it("keeps Tailscale rules, whose tag is an endpoint rather than an outbound", () => {
    const { options } = normaliseOptions({ ...DEFAULT_OPTIONS, tailscale: true });
    const result = convertClashToSingBox(EXAMPLE, options);
    expect(result.config.endpoints).toHaveLength(1);
    expect(result.config.endpoints![0]).toMatchObject({ type: "tailscale", tag: "tailscale" });
    // Dangling-reference pruning works off outbound tags; if it does not also know
    // about endpoints it silently deletes every one of these.
    const toTailnet = result.config.route!.rules!.filter((r) => r.outbound === "tailscale");
    expect(toTailnet).toHaveLength(3);
    expect(toTailnet[0]).toMatchObject({ preferred_by: ["tailscale"] });
  });

  it("exempts tailnet and LAN names from FakeIP by ordering them first", () => {
    const { options } = normaliseOptions({
      ...DEFAULT_OPTIONS,
      tailscale: true,
      fakeIp: true,
      realIpLocal: true,
    });
    const rules = convertClashToSingBox(EXAMPLE, options).config.dns!.rules!;
    const fakeIpIndex = rules.findIndex((r) => r.server === "dns-fakeip");
    expect(fakeIpIndex).toBeGreaterThan(-1);
    // FakeIP is a catch-all, so every exemption has to precede it.
    expect(rules.findIndex((r) => r.server === "dns-tailscale")).toBeLessThan(fakeIpIndex);
    expect(rules.findIndex((r) => r.domain_suffix?.includes("lan"))).toBeLessThan(fakeIpIndex);
    expect(fakeIpIndex).toBe(rules.length - 1);
  });

  it("never puts an IP matcher in a DNS rule, which sing-box rejects there", () => {
    const { options } = normaliseOptions({
      ...DEFAULT_OPTIONS,
      fakeIp: true,
      realIpLocal: true,
      tailscale: true,
    });
    for (const rule of convertClashToSingBox(EXAMPLE, options).config.dns!.rules!) {
      // The FakeIP decision happens on the query, before any address is known, so
      // sing-box requires `match_response` for these and fails startup otherwise.
      expect(rule).not.toHaveProperty("ip_cidr");
      expect(rule).not.toHaveProperty("ip_is_private");
    }
  });

  it("races the two domestic resolvers rather than domestic against foreign", () => {
    const { options } = normaliseOptions({ ...DEFAULT_OPTIONS, dnsRace: true });
    const config = convertClashToSingBox(EXAMPLE, options).config;
    const evaluates = config.dns!.rules!.filter((r) => r.action === "evaluate");
    expect(evaluates).toHaveLength(2);
    expect(evaluates.map((r) => r.server)).toEqual(["dns-local", "dns-local-alt"]);
    // Racing foreign DNS too would answer everything and leave FakeIP unreachable.
    expect(evaluates.every((r) => r.rule_set?.includes("geosite-cn"))).toBe(true);
    for (const rule of config.dns!.rules!.filter((r) => r.race)) {
      expect(rule.match_response).toBeTruthy();
    }
  });

  it("drops concurrent DNS when targeting 1.13, which has no evaluate action", () => {
    const { options, rejected } = normaliseOptions({
      ...DEFAULT_OPTIONS,
      targetVersion: "1.13",
      dnsRace: true,
    });
    expect(options.dnsRace).toBe(false);
    expect(rejected.join(" ")).toMatch(/1\.14/);
    const config = convertClashToSingBox(EXAMPLE, options).config;
    expect(config.dns!.rules!.some((r) => r.action === "evaluate")).toBe(false);
    // 1.13 rejects `preferred_by` on DNS rules, though it allows it on route rules.
    expect(config.dns!.rules!.some((r) => r.preferred_by)).toBe(false);
  });

  it("targeting 1.13 with Tailscale is accepted by 1.13", () => {
    const { options } = normaliseOptions({
      ...DEFAULT_OPTIONS,
      targetVersion: "1.13",
      tailscale: true,
      fakeIp: true,
    });
    const result = convertClashToSingBox(EXAMPLE, options);
    singBoxCheck(result.config, "example-tailscale-113", ["1.13.21"], "1.13");
  });

  it("refuses to convert when the custom ruleset has errors", () => {
    const { options } = normaliseOptions({
      ...DEFAULT_OPTIONS,
      customRulesMode: "replace",
      customRules: "proxy suffix:ok.com\nbogus-target suffix:x.com",
    });
    // Misrouting is worse than failing, so a bad ruleset must not be guessed at.
    expect(() => convertClashToSingBox(EXAMPLE, options)).toThrow(/bogus-target/);
  });

  it("places custom rules before or after the subscription's, as asked", () => {
    const custom = "direct suffix:corp.internal";
    const before = convertClashToSingBox(
      EXAMPLE,
      normaliseOptions({ ...DEFAULT_OPTIONS, customRulesMode: "before", customRules: custom })
        .options,
    ).config.route!.rules!;
    const after = convertClashToSingBox(
      EXAMPLE,
      normaliseOptions({ ...DEFAULT_OPTIONS, customRulesMode: "after", customRules: custom }).options,
    ).config.route!.rules!;

    const at = (rules: typeof before) =>
      rules.findIndex((r) => r.domain_suffix?.includes("corp.internal"));
    // The subscription contributes the bulk of the rules, so "before" must land
    // much earlier than "after".
    expect(at(before)).toBeLessThan(at(after));
  });

  it("warns when a Tailscale auth key would be baked into the link", () => {
    const { options } = normaliseOptions({
      ...DEFAULT_OPTIONS,
      tailscale: true,
      tailscaleAuthKey: "tskey-auth-abc123",
    });
    const result = convertClashToSingBox(EXAMPLE, options);
    expect(result.warnings.join(" ")).toMatch(/auth key/i);
  });

  it("targeting 1.13 produces a config both lines accept", () => {
    const { options } = normaliseOptions({ ...DEFAULT_OPTIONS, targetVersion: "1.13" });
    const result = convertClashToSingBox(EXAMPLE, options);
    // No `http_clients`, which 1.13 rejects outright.
    expect(result.config.http_clients).toBeUndefined();
    expect(result.config.route!.default_http_client).toBeUndefined();
    expect(result.config.route!.rule_set![0]).toHaveProperty("download_detour");
    singBoxCheck(result.config, "example-compat-113", ["1.14.1", "1.13.21"], "1.13");
  });

  it("targeting 1.14 uses http_clients instead of download_detour", () => {
    const result = convertClashToSingBox(EXAMPLE, DEFAULT_OPTIONS);
    expect(result.config.http_clients).toEqual([
      { tag: "rule-set-download", detour: result.config.route!.final },
    ]);
    expect(result.config.route!.default_http_client).toBe("rule-set-download");
    for (const set of result.config.route!.rule_set!) {
      expect(set).not.toHaveProperty("download_detour");
    }
  });
});

describe("protocol coverage", () => {
  // One node per protocol, exercising the transport/TLS/plugin branches.
  const yaml = `
proxies:
  - {name: ss-plain, type: ss, server: a.example.com, port: 8388, cipher: aes-256-gcm, password: pw, udp: true}
  - {name: ss-obfs, type: ss, server: a.example.com, port: 8389, cipher: chacha20-ietf-poly1305, password: pw, plugin: obfs, plugin-opts: {mode: tls, host: bing.com}}
  - {name: ss-v2ray, type: ss, server: a.example.com, port: 8390, cipher: aes-128-gcm, password: pw, plugin: v2ray-plugin, plugin-opts: {mode: websocket, tls: true, host: c.example.com, path: /ws}}
  - {name: ss-shadowtls, type: ss, server: a.example.com, port: 8391, cipher: aes-256-gcm, password: pw, plugin: shadow-tls, plugin-opts: {host: www.apple.com, password: stpw, version: 3}}
  - {name: ss-2022, type: ss, server: a.example.com, port: 8392, cipher: 2022-blake3-aes-128-gcm, password: "86f4Nx8ZaONkYkVRPEgcag=="}
  - {name: vmess-ws-tls, type: vmess, server: b.example.com, port: 443, uuid: b831381d-6324-4d53-ad4f-8cda48b30811, alterId: 0, cipher: auto, tls: true, servername: b.example.com, network: ws, ws-opts: {path: /path, headers: {Host: b.example.com}, max-early-data: 2048, early-data-header-name: Sec-WebSocket-Protocol}}
  - {name: vmess-grpc, type: vmess, server: b.example.com, port: 443, uuid: b831381d-6324-4d53-ad4f-8cda48b30811, cipher: auto, tls: true, network: grpc, grpc-opts: {grpc-service-name: TunService}}
  - {name: vmess-h2, type: vmess, server: b.example.com, port: 443, uuid: b831381d-6324-4d53-ad4f-8cda48b30811, cipher: auto, tls: true, network: h2, h2-opts: {host: [b.example.com], path: /h2}}
  - {name: vmess-httpupgrade, type: vmess, server: b.example.com, port: 80, uuid: b831381d-6324-4d53-ad4f-8cda48b30811, cipher: auto, network: ws, ws-opts: {path: /up, v2ray-http-upgrade: true, headers: {Host: up.example.com}}}
  - {name: vless-reality, type: vless, server: c.example.com, port: 443, uuid: b831381d-6324-4d53-ad4f-8cda48b30811, flow: xtls-rprx-vision, client-fingerprint: chrome, reality-opts: {public-key: tEUHbVvWE3R_ckPI2FGffQUFjAQNGTkl0b26uR8Gk0Y, short-id: 6ba85179e30d4fc2}, servername: www.microsoft.com}
  - {name: vless-ws, type: vless, server: c.example.com, port: 443, uuid: b831381d-6324-4d53-ad4f-8cda48b30811, tls: true, network: ws, ws-opts: {path: /v}}
  - {name: trojan, type: trojan, server: d.example.com, port: 443, password: pw, sni: d.example.com, skip-cert-verify: true, alpn: [h2, http/1.1]}
  - {name: trojan-ws, type: trojan, server: d.example.com, port: 443, password: pw, network: ws, ws-opts: {path: /t}}
  - {name: hysteria2, type: hysteria2, server: e.example.com, port: 443, password: pw, up: "100 Mbps", down: "500 Mbps", obfs: salamander, obfs-password: opw, sni: e.example.com}
  - {name: hysteria2-hop, type: hysteria2, server: e.example.com, port: 443, ports: 20000-30000, password: pw, sni: e.example.com}
  - {name: hysteria, type: hysteria, server: f.example.com, port: 443, auth-str: pw, up: 50, down: 200, protocol: udp, sni: f.example.com}
  - {name: tuic, type: tuic, server: g.example.com, port: 443, uuid: b831381d-6324-4d53-ad4f-8cda48b30811, password: pw, congestion-controller: bbr, udp-relay-mode: native, reduce-rtt: true, alpn: [h3], sni: g.example.com}
  - {name: anytls, type: anytls, server: h.example.com, port: 443, password: pw, sni: h.example.com}
  - {name: socks5, type: socks5, server: i.example.com, port: 1080, username: u, password: p}
  - {name: http-proxy, type: http, server: j.example.com, port: 8080, username: u, password: p, tls: true}
  - {name: ssh, type: ssh, server: k.example.com, port: 22, username: root, password: pw}
  - {name: mux, type: vmess, server: l.example.com, port: 443, uuid: b831381d-6324-4d53-ad4f-8cda48b30811, cipher: auto, tls: true, smux: {enabled: true, protocol: h2mux, max-connections: 4, padding: true, brutal-opts: {enabled: true, up: "50", down: "100"}}}
  - {name: unsupported-ssr, type: ssr, server: m.example.com, port: 443, cipher: aes-256-cfb, password: pw, obfs: plain, protocol: origin}
  - {name: unsupported-wg, type: wireguard, server: n.example.com, port: 51820, private-key: aaa, public-key: bbb, ip: 10.0.0.2}
proxy-groups:
  - {name: PROXY, type: select, proxies: [ss-plain, vmess-ws-tls, auto, DIRECT, REJECT]}
  - {name: auto, type: url-test, proxies: [ss-plain, vmess-ws-tls], url: "http://cp.cloudflare.com/generate_204", interval: 120, tolerance: 20}
  - {name: fb, type: fallback, proxies: [ss-plain, vmess-ws-tls]}
  - {name: lb, type: load-balance, proxies: [ss-plain, vmess-ws-tls], strategy: round-robin}
  - {name: all, type: select, include-all: true, filter: "(?i)vmess|trojan"}
rules:
  - DOMAIN,example.com,PROXY
  - DOMAIN-SUFFIX,google.com,PROXY
  - DOMAIN-KEYWORD,youtube,PROXY
  - DOMAIN-REGEX,^ad[0-9]{1,3}\\.example\\.com$,REJECT
  - IP-CIDR,1.1.1.1/32,PROXY,no-resolve
  - IP-CIDR6,2606:4700::/32,PROXY,no-resolve
  - SRC-IP-CIDR,192.168.1.0/24,DIRECT
  - DST-PORT,443,PROXY
  - SRC-PORT,8080-9000,DIRECT
  - NETWORK,udp,PROXY
  - PROCESS-NAME,curl,DIRECT
  - GEOSITE,netflix,PROXY
  - GEOIP,CN,DIRECT,no-resolve
  - RULE-SET,telegramcidr,PROXY
  - RULE-SET,some-unknown-provider,PROXY
  - IP-ASN,13335,PROXY
  - AND,((DOMAIN,a.com),(NETWORK,udp)),PROXY
  - MATCH,fb
rule-providers:
  telegramcidr: {type: http, behavior: ipcidr, url: "https://example.com/telegram.yaml"}
  some-unknown-provider: {type: http, behavior: classical, url: "https://example.com/x.yaml"}
`;

  const result = convertClashToSingBox(yaml, DEFAULT_OPTIONS);

  it("converts every supported protocol and skips the rest", () => {
    const types = new Set(result.config.outbounds!.map((o) => o.type));
    for (const expected of [
      "shadowsocks",
      "vmess",
      "vless",
      "trojan",
      "hysteria2",
      "hysteria",
      "tuic",
      "anytls",
      "shadowtls",
      "socks",
      "http",
      "ssh",
    ]) {
      expect(types, `missing ${expected}`).toContain(expected);
    }
    // ssr and wireguard have no sing-box outbound equivalent.
    expect(result.stats.proxiesSkipped).toBe(2);
    expect(result.warnings.join("\n")).toMatch(/ShadowsocksR/);
    expect(result.warnings.join("\n")).toMatch(/WireGuard/);
  });

  it("chains shadow-tls through a detour", () => {
    const ss = result.config.outbounds!.find((o) => o.tag === "ss-shadowtls");
    expect(ss).toMatchObject({ type: "shadowsocks", detour: "ss-shadowtls (shadow-tls)" });
    expect(result.config.outbounds!.find((o) => o.tag === "ss-shadowtls (shadow-tls)"))
      .toMatchObject({ type: "shadowtls", version: 3 });
  });

  it("maps websocket early data and grpc service names", () => {
    expect(result.config.outbounds!.find((o) => o.tag === "vmess-ws-tls")).toMatchObject({
      transport: {
        type: "ws",
        path: "/path",
        max_early_data: 2048,
        early_data_header_name: "Sec-WebSocket-Protocol",
      },
    });
    expect(result.config.outbounds!.find((o) => o.tag === "vmess-grpc")).toMatchObject({
      transport: { type: "grpc", service_name: "TunService" },
    });
    expect(result.config.outbounds!.find((o) => o.tag === "vmess-httpupgrade")).toMatchObject({
      transport: { type: "httpupgrade", path: "/up", host: "up.example.com" },
    });
  });

  it("turns REJECT targets into reject actions and keeps a block outbound for groups", () => {
    const rules = result.config.route!.rules!;
    expect(rules.some((r) => r.action === "reject" && r.domain_regex)).toBe(true);
    expect(result.config.outbounds!.some((o) => o.type === "block")).toBe(true);
  });

  it("applies group filters", () => {
    const all = result.config.outbounds!.find((o) => o.tag === "all");
    expect(all?.type).toBe("selector");
    const members = (all as { outbounds: string[] }).outbounds;
    expect(members).toContain("vmess-ws-tls");
    expect(members).toContain("trojan");
    expect(members).not.toContain("ss-plain");
  });

  it("reports the rules it could not convert", () => {
    const text = result.warnings.join("\n");
    expect(text).toMatch(/IP-ASN/);
    expect(text).toMatch(/logical rule/);
    expect(text).toMatch(/some-unknown-provider/);
  });

  it("is accepted by sing-box", () => {
    singBoxCheck(result.config, "protocols");
  });
});
