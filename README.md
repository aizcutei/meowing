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

Two layers matter:

- **`sing-box check`** on every option combination. It fully constructs outbounds, so it
  catches bad ciphers and malformed keys, not just unknown fields.
- **`sing-box run`**, booted for a few seconds. `check` accepted a DNS server whose `detour`
  pointed at the plain `direct` outbound, which sing-box rejects at startup — only a real boot
  finds that class of bug.

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

## Layout

```
src/core/       Pure TypeScript conversion, no runtime dependencies
  clash.ts        Parses and normalises Clash YAML
  outbounds.ts    Proxy -> outbound, per protocol
  groups.ts       proxy-groups -> selector / urltest
  rules.ts        rules -> route.rules, including the merging
  template.ts     Generated dns / inbounds / route scaffolding
  convert.ts      Orchestration, group selection, dangling-reference pruning
  options.ts      Options plus the stateless link encoding
  singbox.ts      sing-box schema types
src/worker/     Hono API and upstream fetching
src/client/     React UI
```

`src/core` deliberately has no Workers or Node dependencies, which is why it can be unit
tested directly and reused elsewhere.
