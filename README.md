# 🐾 Meowing

Converts Clash / mihomo subscriptions into [sing-box](https://github.com/SagerNet/sing-box)
configurations. Runs entirely on Cloudflare Workers, needs no database, and gives you the
result as a file download, a copyable link, or a QR code.

## What it does

Point it at a Clash subscription URL (or paste a config) and it produces a sing-box config
with the nodes, policy groups and routing rules carried across:

| Clash | sing-box |
| --- | --- |
| `proxies` | `outbounds` — ss, vmess, vless, trojan, hysteria, hysteria2, tuic, anytls, shadowtls, socks, http, ssh |
| `proxy-groups` | `selector` (`select`) and `urltest` (`url-test`, `fallback`, `load-balance`) |
| `rules` | `route.rules`, merged; `GEOSITE`/`GEOIP` become remote `rule_set`s |
| — | a generated `dns`, `inbounds`, `route` and `experimental` section |

Anything that cannot be represented — ShadowsocksR, WireGuard, `relay` groups, Clash
`rule-providers` with no geosite equivalent — is skipped and reported rather than silently
dropped.

### Rule merging

Provider subscriptions ship enormous rule lists; the bundled example has **9,816** rules,
which becomes **22** sing-box rules.

The merging is deliberately conservative. sing-box ORs `domain`, `domain_suffix`,
`domain_keyword`, `domain_regex` and `ip_cidr` together inside a single rule (they all feed
one match group in `route/rule/rule_abstract.go`), so a run of Clash rules sharing a target
can collapse into one. Only **adjacent** runs are merged, which preserves Clash's
first-match-wins ordering exactly. Merging by target across the whole list would be faster
but wrong: a later `DOMAIN-KEYWORD,steam,DIRECT` hoisted above
`DOMAIN-SUFFIX,cm.steampowered.com,<proxy>` would silently steal its traffic. There is a test
for that specific case.

`rule_set` matchers are kept in their own rules, because sing-box ANDs them against the
domain/IP group rather than ORing them.

## Optional extras

All off-by-default unless noted, and all validated against both sing-box binaries.

### Custom routing, without writing JSON

Routing can be described in a one-line-per-rule DSL, either merged with the
subscription's rules or replacing them entirely. The UI has a point-and-click
builder and preset buttons that write the same syntax, so anything you click stays
readable and hand-editable.

```
reject  ads
direct  lan, tailscale
proxy   geosite:geolocation-!cn
proxy   suffix:openai.com & port:443
final   proxy
```

Targets are `proxy`, `direct`, `reject`, or any policy group from the
subscription. Matchers are `domain:`, `suffix:`, `keyword:`, `regex:`, `ip:`,
`geosite:`, `geoip:`, `port:`, `process:`, plus the presets `ads`, `lan`,
`tailscale` and `cn`. A bare token means domain suffix.

**Matchers on one line are OR-ed**; `&` ANDs them. That does not map onto sing-box
directly — it ORs `domain*`/`ip_cidr` within a rule but ANDs `rule_set` and `port`
against them, so `direct suffix:a.com, geosite:cn` would silently mean "a.com *and*
in China". Mixed groups are split into separate rules sharing the target to keep OR
semantics. Parse errors name the line and fail the conversion rather than dropping
a rule, since misrouted traffic is worse than a failed build.

### Tailscale

Joins a tailnet through an `endpoints` entry and sends tailnet-bound traffic into
it, ahead of every other rule so it cannot be caught by an ad-block or LAN rule.

Matching uses `preferred_by`, which asks the endpoint whether a destination is
its own; that tracks live MagicDNS names and peers' advertised subnet routes rather
than hardcoding anything. The `100.64.0.0/10` CGNAT range stays as a backstop for
the window before the endpoint is up, when `preferred_by` matches nothing.

Two caveats worth stating plainly:

- **There is no layer-3 forwarding.** Traffic traverses the endpoint as a proxied
  connection. `route` actions have no L3 option (probing for one is a parse error),
  and the only real L3 knob is `system_interface` on the endpoint, which swaps the
  userspace netstack for an OS TUN and is not a routing concept.
- **Leave the auth key blank** if you can. sing-box prints a one-time login URL on
  first start; a key typed here is written into both the config and the
  subscription link, and the conversion warns when you do it.

### DNS

The default `china` preset uses AliDNS over DoT and ByteDance over plain UDP for
domestic names, and Google DoT for everything else. Encrypted servers are addressed
by IP with the hostname in `tls.server_name`, which avoids needing DNS to find the
DNS server and sidesteps 1.14's fatal "missing domain resolver" error.

ByteDance deliberately gets no encrypted form: its DoH/DoT is still listed as
planned and TLS handshakes to `180.184.1.1:853` fail.

**Concurrent queries** (on by default, needs 1.14) race the two *domestic*
resolvers via the `evaluate` + `race` DNS actions and take the first usable answer,
so a slow or poisoned resolver can't hold up a lookup. Only the domestic pair is
raced — racing the foreign resolver too would answer every query and leave FakeIP
unreachable. On the 1.13 target this degrades to rule-based split DNS, because
`evaluate` does not exist there.

### Real IPs for LAN and tailnet, FakeIP for the rest

With FakeIP on, LAN names (`.local`, `.lan`, `.home.arpa`, `.internal`), reverse
zones, and tailnet names resolve to real addresses; everything else gets a fake
one. The tailnet part is load-bearing: `preferred_by` route rules can only match
real CGNAT addresses.

This is expressed with **domain suffixes, never IP ranges** — not a stylistic
choice. The FakeIP decision happens on the query, before any address exists, and
sing-box rejects `ip_cidr`/`ip_is_private` in DNS rules without `match_response`:

```
FATAL initialize dns router: validate dns rule[3]: Response Match Fields
(ip_cidr, ip_is_private, ...) require match_response to be enabled
```

### Stateless subscription links

The generated link carries everything it needs:

```
https://your-worker.workers.dev/sub?u=<base64url upstream URL>&o=<base64url non-default options>
```

No KV namespace, no expiry, nothing to provision — and because the link stays live, sing-box
clients can use it as a remote profile and keep auto-updating. Only options that differ from
the defaults are encoded, so a default conversion produces a short link that fits comfortably
in a QR code.

The upstream `subscription-userinfo` header is passed through, so clients still show your
data quota.

> The link embeds your upstream subscription URL, including any token in it. Treat it as a
> credential.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm run deploy   # build + wrangler deploy
```

To restrict access, set a token — requests then need `Authorization: Bearer <token>` or
`?token=<token>`:

```bash
npx wrangler secret put ACCESS_TOKEN
```

## API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/convert` | `{ urls?, yaml?, options? }` → config, warnings, statistics, and the `/sub` link. Used by the UI. |
| `GET /sub?u=…&o=…` | The stateless subscription. Add `&download=1` for a file download. |
| `GET /api/qr?d=…` | Renders a QR code as SVG. |
| `POST /api/link` | Builds a `/sub` link without running a conversion. |
| `GET /api/health` | Liveness, target sing-box version, and the default options. |

## Testing

Tests validate against the real sing-box binary rather than a transcribed schema, because the
schema is large and moves between releases:

```bash
npm test        # fetches the binaries on first run, then runs vitest
npm run typecheck
```

Three layers matter:

- **`sing-box check`** on every option combination. It fully constructs outbounds, so it
  catches bad ciphers and malformed keys, not just unknown fields.
- **Deprecation warnings are failures** on whichever version a config targets, since a
  deprecated option means the output has a known expiry date. They exit 0 and go to
  stderr, so a plain exit-code check cannot see them.
- **`sing-box run`**, booted for a few seconds. `check` accepted a DNS server whose `detour`
  pointed at the plain `direct` outbound, which sing-box rejects at startup — only a real boot
  finds that class of bug. It also caught a Tailscale state directory that needed root.

One thing the binary will *not* do for you: `check` accepts route rules naming
outbounds that do not exist, and even starts cleanly. Reference validation is
therefore ours to do, which is what `pruneDanglingReferences` is for — and why it
has to know that endpoint tags share the outbound namespace.

The fixture in `test/fixtures/` is a real 46-node, 9,816-rule subscription with every server
address, password and UUID replaced.

## Version targeting

Default output targets **sing-box 1.14** (current stable). Two constraints of that line shape
the generated config:

- the pre-1.12 DNS server format (`{"address": "tls://1.1.1.1"}`) was *removed* in 1.14, so
  servers use the discriminated `type` form;
- `route.default_domain_resolver` is mandatory.

Remote rule sets are downloaded through a declared `http_clients` entry, which avoids 1.14's
"implicit default HTTP client" deprecation warning. Selecting the **1.13** target instead
emits the older `download_detour` (deprecated in 1.14, removed in 1.16) and omits
`http_clients`, which 1.13 does not recognise. The test suite checks each target against its
matching binary.

What differs between the two lines, all confirmed against the binaries:

| | 1.14 | 1.13 |
| --- | --- | --- |
| Tailscale endpoint and DNS server | yes | yes |
| `preferred_by` on **route** rules | yes | yes |
| `preferred_by` on **DNS** rules | yes | no |
| `accept_search_domain` | yes | no |
| Concurrent DNS (`evaluate` / `race`) | yes | no |
| `dns.independent_cache` | deprecated | fine |

Choosing the 1.13 target therefore silently costs you concurrent DNS and dynamic
MagicDNS matching in DNS rules; both degrade rather than fail, and the conversion
says so.

## Layout

```
src/core/       Pure TypeScript conversion, no runtime dependencies
  clash.ts        Parses and normalises Clash YAML
  outbounds.ts    Proxy -> outbound, per protocol
  groups.ts       proxy-groups -> selector / urltest
  rules.ts        rules -> route.rules, including the merging
  custom-rules.ts the routing DSL
  template.ts     Generated dns / inbounds / route scaffolding
  convert.ts      Orchestration, group selection, dangling-reference pruning
  options.ts      Options plus the stateless link encoding
  singbox.ts      sing-box schema types
src/worker/     Hono API and upstream fetching
src/client/     React UI
```

`src/core` deliberately has no Workers or Node dependencies, which is why it can be unit
tested directly and reused elsewhere.
