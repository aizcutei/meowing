/**
 * Clash proxy -> sing-box outbound conversion.
 *
 * One Clash proxy usually becomes one sing-box outbound, but not always: a
 * `shadow-tls` plugin on a Shadowsocks node becomes a `shadowtls` outbound plus
 * a Shadowsocks outbound that dials through it via `detour`. Converters
 * therefore return a list of outbounds and the tag callers should reference.
 */

import { asBool, asInt, asString, asStringList, pick, type ClashProxy } from "./clash";
import type {
  MultiplexOptions,
  ProxyOutbound,
  TlsOptions,
  Transport,
  VmessOutbound,
} from "./singbox";

export interface ConvertedProxy {
  /** The outbound the rest of the config should reference. */
  tag: string;
  /** Emitted outbounds, in dependency order (helpers first). */
  outbounds: ProxyOutbound[];
}

export class UnsupportedProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedProxyError";
  }
}

/* ----------------------------------------------------------------- helpers */

/** Clash writes `interval: 300`; sing-box wants a Go duration string. */
export function seconds(value: unknown): string | undefined {
  const n = asInt(value);
  return n != null && n > 0 ? `${n}s` : undefined;
}

/**
 * Parses Hysteria-style bandwidth values into plain Mbps.
 * Accepts `100`, `"100"`, `"100 Mbps"`, `"100mbps"`, `"1 gbps"`, `"50 kbps"`.
 */
export function bandwidthMbps(value: unknown): number | undefined {
  if (typeof value === "number") return value > 0 ? Math.round(value) : undefined;
  const s = asString(value);
  if (!s) return undefined;
  const m = /^\s*([\d.]+)\s*([kmg]?)b?(?:ps)?\s*$/i.exec(s);
  if (!m?.[1]) return undefined;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const scale = { k: 1 / 1000, m: 1, g: 1000, "": 1 }[(m[2] ?? "").toLowerCase()] ?? 1;
  return Math.max(1, Math.round(n * scale));
}

function requireServer(proxy: ClashProxy): { server: string; server_port: number } {
  const server = asString(pick(proxy, "server"));
  const port = asInt(pick(proxy, "port"));
  if (!server) throw new UnsupportedProxyError(`missing "server"`);
  if (port == null || port < 1 || port > 65535) {
    throw new UnsupportedProxyError(`invalid port ${JSON.stringify(proxy.port)}`);
  }
  return { server, server_port: port };
}

/** Clash's `udp: false` means TCP-only; sing-box expresses that via `network`. */
function networkField(proxy: ClashProxy): { network?: "tcp" } {
  return asBool(pick(proxy, "udp")) === false ? { network: "tcp" } : {};
}

const UTLS_FINGERPRINTS = new Set([
  "chrome",
  "firefox",
  "edge",
  "safari",
  "360",
  "qq",
  "ios",
  "android",
  "random",
  "randomized",
]);

/**
 * Builds the shared `tls` object.
 *
 * `alwaysOn` is for protocols where TLS is structural rather than optional
 * (trojan, hysteria2, tuic, anytls): Clash omits `tls: true` for those because
 * it is implied.
 */
function buildTls(
  proxy: ClashProxy,
  opts: { alwaysOn?: boolean; warn: (msg: string) => void },
): TlsOptions | undefined {
  const reality = asRecord(pick(proxy, "reality-opts"));
  const explicit = asBool(pick(proxy, "tls"));
  const enabled = opts.alwaysOn === true || explicit === true || reality != null;
  if (!enabled) return undefined;

  const tls: TlsOptions = { enabled: true };

  const serverName = asString(pick(proxy, "servername", "sni", "server-name"));
  if (serverName) tls.server_name = serverName;
  // Clash lets `ws-opts.headers.Host` stand in for the SNI on TLS websocket nodes.
  else {
    const wsHost = asString(asRecord(asRecord(pick(proxy, "ws-opts"))?.headers)?.Host);
    if (wsHost) tls.server_name = wsHost;
  }

  if (asBool(pick(proxy, "skip-cert-verify")) === true) tls.insecure = true;
  const alpn = asStringList(pick(proxy, "alpn"));
  if (alpn) tls.alpn = alpn;

  const fingerprint = asString(pick(proxy, "client-fingerprint"));
  if (fingerprint && fingerprint !== "none") {
    if (UTLS_FINGERPRINTS.has(fingerprint)) {
      tls.utls = { enabled: true, fingerprint };
    } else {
      opts.warn(`unknown client-fingerprint "${fingerprint}"; using "chrome"`);
      tls.utls = { enabled: true, fingerprint: "chrome" };
    }
  }

  if (reality) {
    const publicKey = asString(pick(reality, "public-key", "publicKey"));
    if (!publicKey) throw new UnsupportedProxyError("reality-opts is missing public-key");
    tls.reality = { enabled: true, public_key: publicKey };
    const shortId = asString(pick(reality, "short-id", "shortId"));
    if (shortId) tls.reality.short_id = shortId;
    // REALITY always needs uTLS; Clash defaults to chrome when unset.
    if (!tls.utls) tls.utls = { enabled: true, fingerprint: "chrome" };
  }

  // Clash's `fingerprint` is a hex SHA-256 of the certificate. sing-box's
  // equivalent (`certificate_public_key_sha256`) pins the *public key*, so the
  // values are not interchangeable.
  if (asString(pick(proxy, "fingerprint"))) {
    opts.warn("certificate `fingerprint` pinning has no sing-box equivalent; dropped");
  }

  return tls;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function headerMap(value: unknown): Record<string, string | string[]> | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (Array.isArray(v)) {
      const list = v.map((x) => asString(x)).filter((x): x is string => x != null);
      if (list.length > 0) out[k] = list.length === 1 ? list[0]! : list;
    } else {
      const s = asString(v);
      if (s != null) out[k] = s;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Builds the V2Ray `transport` object from Clash's `network` + `*-opts`. */
function buildTransport(
  proxy: ClashProxy,
  warn: (msg: string) => void,
): Transport | undefined {
  const network = asString(pick(proxy, "network"))?.toLowerCase();
  if (!network || network === "tcp") return undefined;

  switch (network) {
    case "ws": {
      const opts = asRecord(pick(proxy, "ws-opts")) ?? {};
      const headers = headerMap(opts.headers);
      const path = asString(opts.path) ?? "/";

      // mihomo tunnels websocket-shaped traffic over HTTPUpgrade with this flag.
      if (asBool(pick(opts, "v2ray-http-upgrade")) === true) {
        const upgrade: Transport = { type: "httpupgrade", path };
        const host = asString(asRecord(opts.headers)?.Host);
        if (host) upgrade.host = host;
        if (headers) upgrade.headers = headers;
        return upgrade;
      }

      const ws: Transport = { type: "ws", path };
      if (headers) ws.headers = headers;
      const maxEarlyData = asInt(pick(opts, "max-early-data"));
      if (maxEarlyData != null && maxEarlyData > 0) ws.max_early_data = maxEarlyData;
      const earlyDataHeader = asString(pick(opts, "early-data-header-name"));
      if (earlyDataHeader) ws.early_data_header_name = earlyDataHeader;
      return ws;
    }
    case "grpc": {
      const opts = asRecord(pick(proxy, "grpc-opts")) ?? {};
      const serviceName = asString(pick(opts, "grpc-service-name", "serviceName"));
      return serviceName ? { type: "grpc", service_name: serviceName } : { type: "grpc" };
    }
    case "h2":
    case "http": {
      const key = network === "h2" ? "h2-opts" : "http-opts";
      const opts = asRecord(pick(proxy, key)) ?? {};
      const transport: Transport = { type: "http" };
      const host = asStringList(opts.host);
      if (host) transport.host = host;
      // Clash's http-opts.path is a list of paths; sing-box takes a single one.
      const paths = asStringList(opts.path);
      if (paths) {
        transport.path = paths[0];
        if (paths.length > 1) {
          warn(`only the first of ${paths.length} http paths is used ("${paths[0]}")`);
        }
      }
      const method = asString(opts.method);
      if (method) transport.method = method;
      const headers = headerMap(opts.headers);
      if (headers) transport.headers = headers;
      return transport;
    }
    case "httpupgrade": {
      const opts = asRecord(pick(proxy, "http-upgrade-opts", "ws-opts")) ?? {};
      const transport: Transport = { type: "httpupgrade" };
      const path = asString(opts.path);
      if (path) transport.path = path;
      const host = asString(pick(opts, "host")) ?? asString(asRecord(opts.headers)?.Host);
      if (host) transport.host = host;
      const headers = headerMap(opts.headers);
      if (headers) transport.headers = headers;
      return transport;
    }
    case "quic":
      return { type: "quic" };
    default:
      throw new UnsupportedProxyError(`unsupported transport network "${network}"`);
  }
}

function buildMultiplex(proxy: ClashProxy): MultiplexOptions | undefined {
  const smux = asRecord(pick(proxy, "smux"));
  if (!smux || asBool(pick(smux, "enabled")) !== true) return undefined;

  const mux: MultiplexOptions = { enabled: true };
  const protocol = asString(pick(smux, "protocol"))?.toLowerCase();
  if (protocol === "h2mux" || protocol === "smux" || protocol === "yamux") mux.protocol = protocol;
  const maxConnections = asInt(pick(smux, "max-connections"));
  if (maxConnections != null) mux.max_connections = maxConnections;
  const minStreams = asInt(pick(smux, "min-streams"));
  if (minStreams != null) mux.min_streams = minStreams;
  const maxStreams = asInt(pick(smux, "max-streams"));
  if (maxStreams != null) mux.max_streams = maxStreams;
  if (asBool(pick(smux, "padding")) === true) mux.padding = true;

  const brutal = asRecord(pick(smux, "brutal-opts"));
  if (brutal && asBool(pick(brutal, "enabled")) === true) {
    mux.brutal = { enabled: true };
    const up = bandwidthMbps(pick(brutal, "up"));
    if (up != null) mux.brutal.up_mbps = up;
    const down = bandwidthMbps(pick(brutal, "down"));
    if (down != null) mux.brutal.down_mbps = down;
  }
  return mux;
}

/* --------------------------------------------------------- shadowsocks bits */

/** sing-box's accepted Shadowsocks methods, plus the aliases Clash tolerates. */
const SS_METHOD_ALIASES: Record<string, string> = {
  dummy: "none",
  plain: "none",
  "chacha20-poly1305": "chacha20-ietf-poly1305",
  "xchacha20-poly1305": "xchacha20-ietf-poly1305",
  "aes-128-gcm-2022": "2022-blake3-aes-128-gcm",
  "aes-256-gcm-2022": "2022-blake3-aes-256-gcm",
};

const SS_METHODS = new Set([
  "none",
  "aes-128-gcm",
  "aes-192-gcm",
  "aes-256-gcm",
  "chacha20-ietf-poly1305",
  "xchacha20-ietf-poly1305",
  "2022-blake3-aes-128-gcm",
  "2022-blake3-aes-256-gcm",
  "2022-blake3-chacha20-poly1305",
  "aes-128-ctr",
  "aes-192-ctr",
  "aes-256-ctr",
  "aes-128-cfb",
  "aes-192-cfb",
  "aes-256-cfb",
  "rc4-md5",
  "chacha20-ietf",
  "xchacha20",
]);

/** Serialises Clash's structured `plugin-opts` into an SIP003 option string. */
function pluginOptsString(pairs: Array<[string, string | true]>): string {
  return pairs.map(([k, v]) => (v === true ? k : `${k}=${v}`)).join(";");
}

function shadowsocksPlugin(
  proxy: ClashProxy,
  warn: (msg: string) => void,
): { plugin: string; plugin_opts?: string } | undefined {
  const plugin = asString(pick(proxy, "plugin"))?.toLowerCase();
  if (!plugin) return undefined;
  const opts = asRecord(pick(proxy, "plugin-opts")) ?? {};

  switch (plugin) {
    case "obfs":
    case "simple-obfs": {
      const pairs: Array<[string, string | true]> = [
        ["obfs", asString(pick(opts, "mode")) ?? "http"],
      ];
      const host = asString(pick(opts, "host"));
      if (host) pairs.push(["obfs-host", host]);
      return { plugin: "obfs-local", plugin_opts: pluginOptsString(pairs) };
    }
    case "v2ray-plugin": {
      const pairs: Array<[string, string | true]> = [
        ["mode", asString(pick(opts, "mode")) ?? "websocket"],
      ];
      if (asBool(pick(opts, "tls")) === true) pairs.push(["tls", true]);
      const host = asString(pick(opts, "host"));
      if (host) pairs.push(["host", host]);
      const path = asString(pick(opts, "path"));
      if (path) pairs.push(["path", path]);
      if (asBool(pick(opts, "mux")) === false) pairs.push(["mux", "0"]);
      return { plugin: "v2ray-plugin", plugin_opts: pluginOptsString(pairs) };
    }
    default:
      warn(`unsupported Shadowsocks plugin "${plugin}"; node dropped`);
      throw new UnsupportedProxyError(`unsupported plugin "${plugin}"`);
  }
}

/* -------------------------------------------------------------- converters */

type Converter = (
  proxy: ClashProxy,
  tag: string,
  warn: (msg: string) => void,
) => ConvertedProxy;

const convertShadowsocks: Converter = (proxy, tag, warn) => {
  const raw = asString(pick(proxy, "cipher", "method"))?.toLowerCase() ?? "";
  const method = SS_METHOD_ALIASES[raw] ?? raw;
  if (!SS_METHODS.has(method)) {
    throw new UnsupportedProxyError(`unsupported Shadowsocks cipher "${raw || "(missing)"}"`);
  }
  const password = asString(pick(proxy, "password")) ?? "";

  // `shadow-tls` is not an SIP003 plugin in sing-box: it is a separate outbound
  // that Shadowsocks dials through.
  const pluginName = asString(pick(proxy, "plugin"))?.toLowerCase();
  if (pluginName === "shadow-tls") {
    const opts = asRecord(pick(proxy, "plugin-opts")) ?? {};
    const { server, server_port } = requireServer(proxy);
    const stTag = `${tag} (shadow-tls)`;
    const version = asInt(pick(opts, "version")) ?? 2;
    const stls: ProxyOutbound = {
      type: "shadowtls",
      tag: stTag,
      server,
      server_port,
      version,
      password: asString(pick(opts, "password")) ?? "",
      tls: {
        enabled: true,
        server_name: asString(pick(opts, "host")) ?? server,
        ...(asBool(pick(opts, "skip-cert-verify")) === true ? { insecure: true } : {}),
        ...(asStringList(pick(opts, "alpn")) ? { alpn: asStringList(pick(opts, "alpn"))! } : {}),
        utls: { enabled: true, fingerprint: asString(pick(opts, "client-fingerprint")) ?? "chrome" },
      },
    };
    const ss: ProxyOutbound = {
      type: "shadowsocks",
      tag,
      // A detoured Shadowsocks outbound still needs a syntactically valid
      // destination; the real dial happens through the shadowtls outbound.
      server: "127.0.0.1",
      server_port: 1080,
      method,
      password,
      detour: stTag,
      ...networkField(proxy),
    };
    const mux = buildMultiplex(proxy);
    if (mux) (ss as { multiplex?: MultiplexOptions }).multiplex = mux;
    return { tag, outbounds: [stls, ss] };
  }

  const out: ProxyOutbound = {
    type: "shadowsocks",
    tag,
    ...requireServer(proxy),
    method,
    password,
    ...networkField(proxy),
  };
  const plugin = shadowsocksPlugin(proxy, warn);
  if (plugin) Object.assign(out, plugin);

  if (asBool(pick(proxy, "udp-over-tcp")) === true) {
    const version = asInt(pick(proxy, "udp-over-tcp-version"));
    (out as { udp_over_tcp?: unknown }).udp_over_tcp =
      version != null ? { enabled: true, version } : true;
  }
  const mux = buildMultiplex(proxy);
  if (mux) (out as { multiplex?: MultiplexOptions }).multiplex = mux;

  return { tag, outbounds: [out] };
};

const VMESS_SECURITY = new Set([
  "auto",
  "none",
  "zero",
  "aes-128-cfb",
  "aes-128-gcm",
  "chacha20-poly1305",
]);

const convertVmess: Converter = (proxy, tag, warn) => {
  const uuid = asString(pick(proxy, "uuid"));
  if (!uuid) throw new UnsupportedProxyError('missing "uuid"');

  const rawSecurity = asString(pick(proxy, "cipher", "security"))?.toLowerCase();
  let security = rawSecurity ?? "auto";
  if (!VMESS_SECURITY.has(security)) {
    warn(`unsupported VMess cipher "${rawSecurity}"; falling back to "auto"`);
    security = "auto";
  }

  const out: VmessOutbound = {
    type: "vmess",
    tag,
    ...requireServer(proxy),
    uuid,
    security,
    ...networkField(proxy),
  };

  const alterId = asInt(pick(proxy, "alterId", "alterid", "alter-id", "alter_id"));
  if (alterId != null && alterId > 0) out.alter_id = alterId;
  if (asBool(pick(proxy, "global-padding")) === true) out.global_padding = true;
  if (asBool(pick(proxy, "authenticated-length")) === true) out.authenticated_length = true;

  const packetEncoding = asString(pick(proxy, "packet-encoding"))?.toLowerCase();
  if (packetEncoding === "packetaddr" || packetEncoding === "xudp") {
    out.packet_encoding = packetEncoding;
  }

  const tls = buildTls(proxy, { warn });
  if (tls) out.tls = tls;
  const transport = buildTransport(proxy, warn);
  if (transport) out.transport = transport;
  const mux = buildMultiplex(proxy);
  if (mux) out.multiplex = mux;

  return { tag, outbounds: [out] };
};

const convertVless: Converter = (proxy, tag, warn) => {
  const uuid = asString(pick(proxy, "uuid"));
  if (!uuid) throw new UnsupportedProxyError('missing "uuid"');

  const out: ProxyOutbound = {
    type: "vless",
    tag,
    ...requireServer(proxy),
    uuid,
    ...networkField(proxy),
  };

  const flow = asString(pick(proxy, "flow"));
  if (flow && flow !== "none") {
    if (flow !== "xtls-rprx-vision") {
      warn(`VLESS flow "${flow}" is not supported by sing-box; using xtls-rprx-vision`);
    }
    (out as { flow?: string }).flow = "xtls-rprx-vision";
  }
  const packetEncoding = asString(pick(proxy, "packet-encoding"))?.toLowerCase();
  if (packetEncoding === "packetaddr" || packetEncoding === "xudp") {
    (out as { packet_encoding?: string }).packet_encoding = packetEncoding;
  }

  // VLESS is only meaningful over TLS; Clash omits `tls: true` when REALITY is set.
  const tls = buildTls(proxy, { warn });
  if (tls) (out as { tls?: TlsOptions }).tls = tls;
  const transport = buildTransport(proxy, warn);
  if (transport) (out as { transport?: Transport }).transport = transport;
  const mux = buildMultiplex(proxy);
  if (mux) (out as { multiplex?: MultiplexOptions }).multiplex = mux;

  return { tag, outbounds: [out] };
};

const convertTrojan: Converter = (proxy, tag, warn) => {
  const password = asString(pick(proxy, "password"));
  if (!password) throw new UnsupportedProxyError('missing "password"');

  const out: ProxyOutbound = {
    type: "trojan",
    tag,
    ...requireServer(proxy),
    password,
    ...networkField(proxy),
  };
  (out as { tls?: TlsOptions }).tls = buildTls(proxy, { alwaysOn: true, warn });
  const transport = buildTransport(proxy, warn);
  if (transport) (out as { transport?: Transport }).transport = transport;
  const mux = buildMultiplex(proxy);
  if (mux) (out as { multiplex?: MultiplexOptions }).multiplex = mux;

  return { tag, outbounds: [out] };
};

/** Clash writes port hop ranges as `1000-2000`; sing-box uses `1000:2000`. */
function serverPorts(value: unknown): string[] | undefined {
  const list = asStringList(value);
  if (!list) return undefined;
  const out = list
    .flatMap((entry) => entry.split(/[,/]/))
    .map((entry) => entry.trim().replace(/-/g, ":"))
    .filter((entry) => /^\d+(:\d+)?$/.test(entry));
  return out.length > 0 ? out : undefined;
}

const convertHysteria2: Converter = (proxy, tag, warn) => {
  const out: ProxyOutbound = {
    type: "hysteria2",
    tag,
    ...requireServer(proxy),
  };
  const password = asString(pick(proxy, "password", "auth", "auth-str"));
  if (password) (out as { password?: string }).password = password;

  const up = bandwidthMbps(pick(proxy, "up", "up-mbps", "up_mbps"));
  if (up != null) (out as { up_mbps?: number }).up_mbps = up;
  const down = bandwidthMbps(pick(proxy, "down", "down-mbps", "down_mbps"));
  if (down != null) (out as { down_mbps?: number }).down_mbps = down;

  const obfs = asString(pick(proxy, "obfs"))?.toLowerCase();
  if (obfs === "salamander") {
    const obfsPassword = asString(pick(proxy, "obfs-password"));
    if (obfsPassword) {
      (out as { obfs?: unknown }).obfs = { type: "salamander", password: obfsPassword };
    } else {
      warn("hysteria2 obfs=salamander without obfs-password; obfs dropped");
    }
  } else if (obfs) {
    warn(`unsupported hysteria2 obfs "${obfs}"; dropped`);
  }

  const ports = serverPorts(pick(proxy, "ports", "server-ports"));
  if (ports) {
    (out as { server_ports?: string[] }).server_ports = ports;
    const hop = seconds(pick(proxy, "hop-interval"));
    if (hop) (out as { hop_interval?: string }).hop_interval = hop;
  }

  (out as { tls?: TlsOptions }).tls = buildTls(proxy, { alwaysOn: true, warn });
  return { tag, outbounds: [out] };
};

const convertHysteria: Converter = (proxy, tag, warn) => {
  const out: ProxyOutbound = {
    type: "hysteria",
    tag,
    ...requireServer(proxy),
  };
  const up = bandwidthMbps(pick(proxy, "up", "up-mbps", "up_mbps"));
  if (up != null) (out as { up_mbps?: number }).up_mbps = up;
  const down = bandwidthMbps(pick(proxy, "down", "down-mbps", "down_mbps"));
  if (down != null) (out as { down_mbps?: number }).down_mbps = down;

  const authStr = asString(pick(proxy, "auth-str", "auth_str", "auth-string"));
  if (authStr) (out as { auth_str?: string }).auth_str = authStr;
  const obfs = asString(pick(proxy, "obfs"));
  if (obfs) (out as { obfs?: string }).obfs = obfs;

  const protocol = asString(pick(proxy, "protocol"));
  if (protocol && protocol !== "udp") {
    warn(`hysteria protocol "${protocol}" is not supported by sing-box (udp only)`);
  }
  const recvWindowConn = asInt(pick(proxy, "recv-window-conn"));
  if (recvWindowConn != null) (out as { recv_window_conn?: number }).recv_window_conn = recvWindowConn;
  const recvWindow = asInt(pick(proxy, "recv-window"));
  if (recvWindow != null) (out as { recv_window?: number }).recv_window = recvWindow;
  if (asBool(pick(proxy, "disable-mtu-discovery")) === true) {
    (out as { disable_mtu_discovery?: boolean }).disable_mtu_discovery = true;
  }

  (out as { tls?: TlsOptions }).tls = buildTls(proxy, { alwaysOn: true, warn });
  return { tag, outbounds: [out] };
};

const convertTuic: Converter = (proxy, tag, warn) => {
  const out: ProxyOutbound = {
    type: "tuic",
    tag,
    ...requireServer(proxy),
  };
  const uuid = asString(pick(proxy, "uuid"));
  if (uuid) (out as { uuid?: string }).uuid = uuid;
  const password = asString(pick(proxy, "password", "token"));
  if (password) (out as { password?: string }).password = password;
  if (!uuid && !password) throw new UnsupportedProxyError("missing uuid/password");

  const congestion = asString(pick(proxy, "congestion-controller", "congestion-control"))
    ?.toLowerCase()
    .replace("newreno", "new_reno");
  if (congestion === "cubic" || congestion === "new_reno" || congestion === "bbr") {
    (out as { congestion_control?: string }).congestion_control = congestion;
  }
  const relayMode = asString(pick(proxy, "udp-relay-mode"))?.toLowerCase();
  if (relayMode === "native" || relayMode === "quic") {
    (out as { udp_relay_mode?: string }).udp_relay_mode = relayMode;
  }
  if (asBool(pick(proxy, "reduce-rtt")) === true) {
    (out as { zero_rtt_handshake?: boolean }).zero_rtt_handshake = true;
  }
  if (asBool(pick(proxy, "udp-over-stream")) === true) {
    (out as { udp_over_stream?: boolean }).udp_over_stream = true;
  }
  const heartbeat = seconds(pick(proxy, "heartbeat-interval"));
  if (heartbeat) (out as { heartbeat?: string }).heartbeat = heartbeat;

  (out as { tls?: TlsOptions }).tls = buildTls(proxy, { alwaysOn: true, warn });
  return { tag, outbounds: [out] };
};

const convertAnytls: Converter = (proxy, tag, warn) => {
  const out: ProxyOutbound = {
    type: "anytls",
    tag,
    ...requireServer(proxy),
  };
  const password = asString(pick(proxy, "password"));
  if (password) (out as { password?: string }).password = password;
  const minIdle = asInt(pick(proxy, "min-idle-session"));
  if (minIdle != null) (out as { min_idle_session?: number }).min_idle_session = minIdle;
  const checkInterval = seconds(pick(proxy, "idle-session-check-interval"));
  if (checkInterval) {
    (out as { idle_session_check_interval?: string }).idle_session_check_interval = checkInterval;
  }
  const timeout = seconds(pick(proxy, "idle-session-timeout"));
  if (timeout) (out as { idle_session_timeout?: string }).idle_session_timeout = timeout;

  (out as { tls?: TlsOptions }).tls = buildTls(proxy, { alwaysOn: true, warn });
  return { tag, outbounds: [out] };
};

const convertSocks: Converter = (proxy, tag) => {
  const out: ProxyOutbound = {
    type: "socks",
    tag,
    ...requireServer(proxy),
    version: "5",
    ...networkField(proxy),
  };
  const username = asString(pick(proxy, "username"));
  if (username) (out as { username?: string }).username = username;
  const password = asString(pick(proxy, "password"));
  if (password) (out as { password?: string }).password = password;
  if (asBool(pick(proxy, "udp-over-tcp")) === true) {
    (out as { udp_over_tcp?: boolean }).udp_over_tcp = true;
  }
  return { tag, outbounds: [out] };
};

const convertHttp: Converter = (proxy, tag, warn) => {
  const out: ProxyOutbound = {
    type: "http",
    tag,
    ...requireServer(proxy),
  };
  const username = asString(pick(proxy, "username"));
  if (username) (out as { username?: string }).username = username;
  const password = asString(pick(proxy, "password"));
  if (password) (out as { password?: string }).password = password;
  const headers = headerMap(pick(proxy, "headers"));
  if (headers) (out as { headers?: unknown }).headers = headers;

  const tls = buildTls(proxy, { warn });
  if (tls) (out as { tls?: TlsOptions }).tls = tls;
  return { tag, outbounds: [out] };
};

const convertSsh: Converter = (proxy, tag) => {
  const out: ProxyOutbound = {
    type: "ssh",
    tag,
    ...requireServer(proxy),
  };
  const user = asString(pick(proxy, "username", "user"));
  if (user) (out as { user?: string }).user = user;
  const password = asString(pick(proxy, "password"));
  if (password) (out as { password?: string }).password = password;
  const privateKey = asStringList(pick(proxy, "private-key"));
  if (privateKey) (out as { private_key?: string[] }).private_key = privateKey;
  const passphrase = asString(pick(proxy, "private-key-passphrase"));
  if (passphrase) (out as { private_key_passphrase?: string }).private_key_passphrase = passphrase;
  const hostKey = asStringList(pick(proxy, "host-key"));
  if (hostKey) (out as { host_key?: string[] }).host_key = hostKey;
  const hostKeyAlgorithms = asStringList(pick(proxy, "host-key-algorithms"));
  if (hostKeyAlgorithms) {
    (out as { host_key_algorithms?: string[] }).host_key_algorithms = hostKeyAlgorithms;
  }
  return { tag, outbounds: [out] };
};

const CONVERTERS: Record<string, Converter> = {
  ss: convertShadowsocks,
  shadowsocks: convertShadowsocks,
  vmess: convertVmess,
  vless: convertVless,
  trojan: convertTrojan,
  hysteria2: convertHysteria2,
  hy2: convertHysteria2,
  hysteria: convertHysteria,
  hy: convertHysteria,
  tuic: convertTuic,
  anytls: convertAnytls,
  socks5: convertSocks,
  socks: convertSocks,
  http: convertHttp,
  https: convertHttp,
  ssh: convertSsh,
};

/** Clash proxy types sing-box has no implementation for, with the reason why. */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  ssr: "ShadowsocksR is not implemented by sing-box",
  snell: "Snell is not implemented by sing-box",
  mieru: "Mieru is not implemented by sing-box",
  wireguard: "WireGuard is an `endpoint`, not an outbound, and cannot join a proxy group",
  tailscale: "Tailscale is an `endpoint`, not an outbound",
  direct: "`direct` is provided by the generated config itself",
  dns: "`dns` proxies are replaced by the generated DNS section",
  reject: "`reject` is expressed as a route action",
};

export function isSupportedProxyType(type: string): boolean {
  return Object.hasOwn(CONVERTERS, type.toLowerCase());
}

/**
 * Converts a single Clash proxy. Throws `UnsupportedProxyError` when the node
 * cannot be represented in sing-box, so callers can skip it with a warning.
 */
export function convertProxy(
  proxy: ClashProxy,
  tag: string,
  warn: (msg: string) => void,
): ConvertedProxy {
  const type = proxy.type.toLowerCase();
  const converter = CONVERTERS[type];
  if (!converter) {
    const reason = KNOWN_UNSUPPORTED[type] ?? `unknown proxy type "${type}"`;
    throw new UnsupportedProxyError(reason);
  }
  return converter(proxy, tag, warn);
}
