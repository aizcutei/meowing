import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseCustomRules, type CustomRulesContext } from "../src/core/custom-rules";
import type { SingBoxConfig } from "../src/core/singbox";

const BINARY = ["1.14.1"]
  .map((version) => ({ version, path: new URL(`../.tools/sing-box-${version}`, import.meta.url).pathname }))
  .find((entry) => existsSync(entry.path));

const workDir = mkdtempSync(join(tmpdir(), "meowing-dsl-"));

const ctx: CustomRulesContext = {
  resolveTarget: (name) => {
    const lower = name.trim().toLowerCase();
    if (lower === "proxy") return { kind: "route", outbound: "Proxy" };
    if (lower === "direct") return { kind: "route", outbound: "direct" };
    if (lower === "reject" || lower === "block") return { kind: "reject" };
    if (lower === "hk") return { kind: "route", outbound: "HK" };
    return { kind: "unknown" };
  },
  ruleSetSource: "sagernet",
  ruleSetUpdateInterval: "1d",
};

/** The DSL is only useful if sing-box accepts what it emits, so check it for real. */
function checkWithSingBox(rules: SingBoxConfig["route"], name: string): void {
  if (!BINARY) {
    console.warn("sing-box 1.14.1 not found in .tools/; skipping validation");
    return;
  }
  const config: SingBoxConfig = {
    dns: { servers: [{ type: "local", tag: "local" }] },
    outbounds: [
      { type: "direct", tag: "direct" },
      { type: "block", tag: "block" },
      { type: "selector", tag: "Proxy", outbounds: ["direct"] },
      { type: "selector", tag: "HK", outbounds: ["direct"] },
    ],
    route: { ...rules, final: rules?.final ?? "Proxy", default_domain_resolver: "local" },
  };
  const file = join(workDir, `${name}.json`);
  writeFileSync(file, JSON.stringify(config, null, 2));
  const result = spawnSync(BINARY.path, ["check", "-c", file], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/\u001B\[[\d;]*m/g, "");
  if (result.status !== 0) throw new Error(`sing-box rejected "${name}":\n${output}`);
  expect(output).not.toMatch(/deprecated/i);
}

describe("custom routing DSL", () => {
  it("parses the documented example", () => {
    const result = parseCustomRules(
      `
      # ads first, then local networks
      reject  ads
      direct  lan, tailscale
      proxy   geosite:geolocation-!cn
      final   proxy
      `,
      ctx,
    );
    expect(result.errors).toEqual([]);
    expect(result.final).toBe("Proxy");
    expect(result.finalRejects).toBe(false);
    checkWithSingBox({ rules: result.rules, rule_set: result.ruleSets }, "documented");
  });

  it("ORs plain destination matchers into one rule", () => {
    const result = parseCustomRules("proxy suffix:a.com, suffix:b.com, keyword:c, ip:1.2.3.0/24", ctx);
    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({
      domain_suffix: ["a.com", "b.com"],
      domain_keyword: ["c"],
      ip_cidr: ["1.2.3.0/24"],
      outbound: "Proxy",
    });
  });

  it("splits rule_set out of an OR group, since sing-box would AND it", () => {
    const result = parseCustomRules("direct suffix:a.com, geosite:cn", ctx);
    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(2);
    expect(result.rules[0]).toMatchObject({ domain_suffix: ["a.com"], outbound: "direct" });
    expect(result.rules[1]).toMatchObject({ rule_set: ["geosite-cn"], outbound: "direct" });
  });

  it("ANDs terms joined with &", () => {
    const result = parseCustomRules("proxy suffix:openai.com & port:443", ctx);
    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({ domain_suffix: ["openai.com"], port: [443] });
  });

  it("expands the tailscale preset to CGNAT plus MagicDNS", () => {
    const result = parseCustomRules("direct tailscale", ctx);
    expect(result.errors).toEqual([]);
    const merged = result.rules[0]!;
    expect(merged.ip_cidr).toEqual(["100.64.0.0/10"]);
    expect(merged.domain_suffix).toEqual([".ts.net"]);
  });

  it("maps lan to ip_is_private", () => {
    const result = parseCustomRules("direct lan", ctx);
    expect(result.rules[0]).toMatchObject({ ip_is_private: true, outbound: "direct" });
  });

  it("treats a bare token as a domain suffix", () => {
    const result = parseCustomRules("proxy example.com", ctx);
    expect(result.rules[0]).toMatchObject({ domain_suffix: ["example.com"] });
  });

  it("accepts port ranges", () => {
    const result = parseCustomRules("proxy port:1000-2000", ctx);
    expect(result.errors).toEqual([]);
    expect(result.rules[0]).toMatchObject({ port_range: ["1000:2000"] });
  });

  it("records a rejecting final separately, since route.final must name an outbound", () => {
    const result = parseCustomRules("final reject", ctx);
    expect(result.finalRejects).toBe(true);
    expect(result.final).toBeUndefined();
  });

  it("reports errors with line numbers instead of silently dropping rules", () => {
    const result = parseCustomRules(
      `proxy suffix:ok.com
       nonsense suffix:x.com
       proxy bogus:y
       proxy
       final`,
      ctx,
    );
    expect(result.errors).toHaveLength(4);
    expect(result.errors[0]).toMatch(/line 2:.*nonsense/);
    expect(result.errors[1]).toMatch(/line 3:.*bogus/);
    expect(result.errors[2]).toMatch(/line 4:/);
    expect(result.errors[3]).toMatch(/line 5:/);
    // The valid rule still parsed.
    expect(result.rules).toHaveLength(1);
  });

  it("ignores comments and blank lines", () => {
    const result = parseCustomRules("# a\n\n   \nproxy example.com  # trailing\n", ctx);
    expect(result.errors).toEqual([]);
    expect(result.stats.lines).toBe(1);
    expect(result.rules[0]).toMatchObject({ domain_suffix: ["example.com"] });
  });

  it("emits every matcher type in a config sing-box accepts", () => {
    const result = parseCustomRules(
      `reject  ads
       direct  lan, tailscale, cn
       hk      domain:exact.com, suffix:.hk, keyword:kw, regex:^ad\\..+, ip:10.1.0.0/16
       proxy   process:curl
       proxy   port:8080, port:1000-2000
       final   proxy`,
      ctx,
    );
    expect(result.errors).toEqual([]);
    checkWithSingBox({ rules: result.rules, rule_set: result.ruleSets }, "all-matchers");
  });
});
