/**
 * Type definitions for the sing-box configuration format.
 *
 * Field names and shapes are transcribed from the `option` package of
 * sing-box v1.14.1 (github.com/SagerNet/sing-box/tree/v1.14.1/option), which is
 * the schema the generated configs are validated against in the test suite.
 *
 * Two hard constraints of the 1.14 line that shape this file:
 *   - the pre-1.12 DNS server format (`{"address": "tls://1.1.1.1"}`) was
 *     *removed*, so servers must use the discriminated `type` form;
 *   - `route.default_domain_resolver` is mandatory unless every dial field
 *     carries its own `domain_resolver`.
 */

export const SINGBOX_TARGET_VERSION = "1.14.1";

export interface SingBoxConfig {
  log?: LogOptions;
  dns?: DnsOptions;
  /** sing-box 1.14+ only. Older releases reject the key outright. */
  http_clients?: HttpClient[];
  inbounds?: Inbound[];
  outbounds?: Outbound[];
  /** Bidirectional protocols (WireGuard, Tailscale). Present since sing-box 1.11. */
  endpoints?: Endpoint[];
  route?: RouteOptions;
  experimental?: ExperimentalOptions;
}

/**
 * A Tailscale endpoint.
 *
 * Endpoints are not outbounds: they also accept inbound connections, which is why
 * a tailnet cannot be modelled as an outbound. They do share the outbound tag
 * namespace, so a route rule reaches one through the ordinary `outbound` field.
 */
export interface TailscaleEndpoint {
  type: "tailscale";
  tag: string;
  /** Where tailnet identity is persisted. Without it, every restart re-authenticates. */
  state_directory?: string;
  auth_key?: string;
  control_url?: string;
  ephemeral?: boolean;
  hostname?: string;
  /** Accept subnet routes advertised by peers. */
  accept_routes?: boolean;
  exit_node?: string;
  exit_node_allow_lan_access?: boolean;
  advertise_routes?: string[];
  advertise_exit_node?: boolean;
  udp_timeout?: string;
  /** Use a real OS TUN interface instead of the userspace netstack. */
  system_interface?: boolean;
  system_interface_name?: string;
  system_interface_mtu?: number;
  detour?: string;
  domain_resolver?: DomainResolveOptions | string;
}

export type Endpoint = TailscaleEndpoint;

/**
 * A named HTTP client, introduced in sing-box 1.14 for things the router itself
 * fetches (remote rule sets). It replaces the per-rule-set `download_detour`,
 * which 1.14 deprecates and 1.16 removes.
 */
export interface HttpClient {
  tag: string;
  /** Omitted means dial directly. */
  detour?: string;
  headers?: Record<string, string | string[]>;
}

export interface LogOptions {
  disabled?: boolean;
  level?: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "panic";
  output?: string;
  timestamp?: boolean;
}

/* ------------------------------------------------------------------ shared */

export interface TlsOptions {
  enabled: boolean;
  disable_sni?: boolean;
  server_name?: string;
  insecure?: boolean;
  alpn?: string[];
  min_version?: string;
  max_version?: string;
  certificate?: string[];
  utls?: { enabled: boolean; fingerprint?: string };
  reality?: { enabled: boolean; public_key?: string; short_id?: string };
  ech?: { enabled: boolean; config?: string[] };
}

export type Transport =
  | {
      type: "ws";
      path?: string;
      headers?: Record<string, string | string[]>;
      max_early_data?: number;
      early_data_header_name?: string;
    }
  | {
      type: "http";
      host?: string[];
      path?: string;
      method?: string;
      headers?: Record<string, string | string[]>;
    }
  | { type: "grpc"; service_name?: string; permit_without_stream?: boolean }
  | { type: "httpupgrade"; host?: string; path?: string; headers?: Record<string, string | string[]> }
  | { type: "quic" };

export interface MultiplexOptions {
  enabled: boolean;
  protocol?: "h2mux" | "smux" | "yamux";
  max_connections?: number;
  min_streams?: number;
  max_streams?: number;
  padding?: boolean;
  brutal?: { enabled: boolean; up_mbps?: number; down_mbps?: number };
}

export interface DomainResolveOptions {
  server: string;
  strategy?: DomainStrategy;
  rewrite_ttl?: number;
}

export type DomainStrategy = "prefer_ipv4" | "prefer_ipv6" | "ipv4_only" | "ipv6_only";

/** Fields every dialable outbound shares. */
interface DialerFields {
  detour?: string;
  bind_interface?: string;
  domain_resolver?: DomainResolveOptions | string;
  network?: "tcp" | "udp" | Array<"tcp" | "udp">;
  connect_timeout?: string;
  tcp_fast_open?: boolean;
  udp_fragment?: boolean;
}

interface ServerFields {
  server: string;
  server_port: number;
}

/* --------------------------------------------------------------- outbounds */

export interface DirectOutbound extends DialerFields {
  type: "direct";
  tag: string;
}

/**
 * The dedicated `block` outbound is deprecated in favour of the `reject` rule
 * action, but it remains valid in 1.14 and is the only way to express a REJECT
 * *member of a selector group*, which route actions cannot do.
 */
export interface BlockOutbound {
  type: "block";
  tag: string;
}

export interface ShadowsocksOutbound extends DialerFields, ServerFields {
  type: "shadowsocks";
  tag: string;
  method: string;
  password: string;
  plugin?: string;
  plugin_opts?: string;
  udp_over_tcp?: boolean | { enabled: boolean; version?: number };
  multiplex?: MultiplexOptions;
}

export interface VmessOutbound extends DialerFields, ServerFields {
  type: "vmess";
  tag: string;
  uuid: string;
  security?: string;
  alter_id?: number;
  global_padding?: boolean;
  authenticated_length?: boolean;
  packet_encoding?: "packetaddr" | "xudp";
  tls?: TlsOptions;
  transport?: Transport;
  multiplex?: MultiplexOptions;
}

export interface VlessOutbound extends DialerFields, ServerFields {
  type: "vless";
  tag: string;
  uuid: string;
  flow?: string;
  packet_encoding?: "packetaddr" | "xudp";
  tls?: TlsOptions;
  transport?: Transport;
  multiplex?: MultiplexOptions;
}

export interface TrojanOutbound extends DialerFields, ServerFields {
  type: "trojan";
  tag: string;
  password: string;
  tls?: TlsOptions;
  transport?: Transport;
  multiplex?: MultiplexOptions;
}

export interface Hysteria2Outbound extends DialerFields, ServerFields {
  type: "hysteria2";
  tag: string;
  password?: string;
  server_ports?: string[];
  hop_interval?: string;
  up_mbps?: number;
  down_mbps?: number;
  obfs?: { type: "salamander"; password: string };
  tls?: TlsOptions;
  brutal_debug?: boolean;
}

export interface HysteriaOutbound extends DialerFields, ServerFields {
  type: "hysteria";
  tag: string;
  up?: string;
  up_mbps?: number;
  down?: string;
  down_mbps?: number;
  obfs?: string;
  auth_str?: string;
  auth?: string;
  recv_window_conn?: number;
  recv_window?: number;
  disable_mtu_discovery?: boolean;
  tls?: TlsOptions;
}

export interface TuicOutbound extends DialerFields, ServerFields {
  type: "tuic";
  tag: string;
  uuid?: string;
  password?: string;
  congestion_control?: "cubic" | "new_reno" | "bbr";
  udp_relay_mode?: "native" | "quic";
  udp_over_stream?: boolean;
  zero_rtt_handshake?: boolean;
  heartbeat?: string;
  tls?: TlsOptions;
}

export interface AnytlsOutbound extends DialerFields, ServerFields {
  type: "anytls";
  tag: string;
  password?: string;
  idle_session_check_interval?: string;
  idle_session_timeout?: string;
  min_idle_session?: number;
  tls?: TlsOptions;
}

export interface ShadowTlsOutbound extends DialerFields, ServerFields {
  type: "shadowtls";
  tag: string;
  version?: number;
  password?: string;
  tls?: TlsOptions;
}

export interface SocksOutbound extends DialerFields, ServerFields {
  type: "socks";
  tag: string;
  version?: "4" | "4a" | "5";
  username?: string;
  password?: string;
  udp_over_tcp?: boolean | { enabled: boolean; version?: number };
}

export interface HttpOutbound extends DialerFields, ServerFields {
  type: "http";
  tag: string;
  username?: string;
  password?: string;
  path?: string;
  headers?: Record<string, string | string[]>;
  tls?: TlsOptions;
}

export interface SshOutbound extends DialerFields, ServerFields {
  type: "ssh";
  tag: string;
  user?: string;
  password?: string;
  private_key?: string[];
  private_key_passphrase?: string;
  host_key?: string[];
  host_key_algorithms?: string[];
  client_version?: string;
}

export interface SelectorOutbound {
  type: "selector";
  tag: string;
  outbounds: string[];
  default?: string;
  interrupt_exist_connections?: boolean;
}

export interface UrlTestOutbound {
  type: "urltest";
  tag: string;
  outbounds: string[];
  url?: string;
  interval?: string;
  tolerance?: number;
  idle_timeout?: string;
  interrupt_exist_connections?: boolean;
}

export type ProxyOutbound =
  | ShadowsocksOutbound
  | VmessOutbound
  | VlessOutbound
  | TrojanOutbound
  | Hysteria2Outbound
  | HysteriaOutbound
  | TuicOutbound
  | AnytlsOutbound
  | ShadowTlsOutbound
  | SocksOutbound
  | HttpOutbound
  | SshOutbound;

export type Outbound =
  | ProxyOutbound
  | SelectorOutbound
  | UrlTestOutbound
  | DirectOutbound
  | BlockOutbound;

/* ---------------------------------------------------------------- inbounds */

export interface TunInbound {
  type: "tun";
  tag: string;
  address?: string[];
  mtu?: number;
  auto_route?: boolean;
  strict_route?: boolean;
  auto_redirect?: boolean;
  route_exclude_address?: string[];
  stack?: "system" | "gvisor" | "mixed";
  endpoint_independent_nat?: boolean;
  platform?: { http_proxy?: { enabled: boolean; server: string; server_port: number } };
}

export interface MixedInbound {
  type: "mixed";
  tag: string;
  listen: string;
  listen_port: number;
  users?: Array<{ username: string; password: string }>;
  set_system_proxy?: boolean;
}

export type Inbound = TunInbound | MixedInbound;

/* -------------------------------------------------------------------- DNS */

export type DnsServer =
  | { type: "local"; tag: string }
  | {
      type: "hosts";
      tag: string;
      path?: string[];
      predefined?: Record<string, string | string[]>;
    }
  | {
      type: "udp" | "tcp" | "tls" | "quic";
      tag: string;
      server: string;
      server_port?: number;
      detour?: string;
      domain_resolver?: DomainResolveOptions | string;
      /**
       * Lets a DoT/DoQ server be addressed by IP while still presenting the right
       * SNI, which removes the need to resolve the resolver.
       */
      tls?: TlsOptions;
    }
  | {
      type: "https" | "h3";
      tag: string;
      server: string;
      server_port?: number;
      path?: string;
      detour?: string;
      domain_resolver?: DomainResolveOptions | string;
    }
  | { type: "fakeip"; tag: string; inet4_range?: string; inet6_range?: string }
  | {
      /**
       * Resolves through a tailnet. Notably does *not* embed dial fields, so it
       * takes no `detour` or `domain_resolver`.
       */
      type: "tailscale";
      tag: string;
      /** Tag of a `tailscale` endpoint. */
      endpoint: string;
      accept_default_resolvers?: boolean;
      /** sing-box 1.14+ only. */
      accept_search_domain?: boolean;
    };

export interface DnsRule {
  /** Present only on `default` rules. */
  domain?: string[];
  domain_suffix?: string[];
  domain_keyword?: string[];
  domain_regex?: string[];
  rule_set?: string[];
  query_type?: Array<string | number>;
  clash_mode?: string;
  ip_accept_any?: boolean;
  invert?: boolean;
  /**
   * Matches destinations the named outbounds or DNS servers claim as their own.
   * For a tailnet that means live MagicDNS names and peers' advertised subnet
   * routes, so it tracks the tailnet instead of hardcoding ranges.
   */
  preferred_by?: string[];
  /** Present only on `logical` rules. */
  type?: "logical";
  mode?: "and" | "or";
  rules?: DnsRule[];
  /**
   * Action. `server` implies `action: "route"`.
   *
   * `evaluate` (1.14+) queries a server and stores the answer under `tag` without
   * ending rule matching, which is what makes concurrent queries possible.
   */
  action?: "route" | "route-options" | "reject" | "predefined" | "evaluate" | "respond";
  server?: string;
  /** Names the stored response of an `evaluate` rule. */
  tag?: string;
  /** Matches against a stored response rather than the query. Required by `race`. */
  match_response?: boolean | string;
  /** First matching response wins, regardless of rule order. Needs `match_response`. */
  race?: boolean;
  response_rcode?: string;
  strategy?: DomainStrategy;
  disable_cache?: boolean;
  rewrite_ttl?: number;
}

export interface DnsOptions {
  servers?: DnsServer[];
  rules?: DnsRule[];
  final?: string;
  strategy?: DomainStrategy;
  disable_cache?: boolean;
  disable_expire?: boolean;
  independent_cache?: boolean;
  reverse_mapping?: boolean;
  client_subnet?: string;
}

/* ------------------------------------------------------------------- route */

/**
 * A route rule.
 *
 * Matching semantics, as implemented in `route/rule/rule_abstract.go`:
 *   - `domain`, `domain_suffix`, `domain_keyword`, `domain_regex` and `ip_cidr`
 *     all feed the single "destination address" group and are **OR-ed**;
 *   - `port` / `port_range` form the destination-port group (OR-ed internally);
 *   - `source_ip_cidr` and `source_port` likewise form their own groups;
 *   - every non-empty group must match (**AND** across groups), and
 *     `network`, `protocol`, `process_name`, `clash_mode`, ... are AND-ed
 *     individually.
 *
 * The OR-ing of the destination-address group is what makes it safe for
 * `rules.ts` to collapse a run of Clash domain *and* IP rules into one rule.
 */
export interface RouteRule {
  /** `default` rule matchers. */
  inbound?: string[];
  ip_version?: 4 | 6;
  network?: Array<"tcp" | "udp">;
  protocol?: string[];
  domain?: string[];
  domain_suffix?: string[];
  domain_keyword?: string[];
  domain_regex?: string[];
  source_ip_cidr?: string[];
  source_ip_is_private?: boolean;
  ip_cidr?: string[];
  ip_is_private?: boolean;
  source_port?: number[];
  source_port_range?: string[];
  port?: number[];
  port_range?: string[];
  process_name?: string[];
  process_path?: string[];
  package_name?: string[];
  clash_mode?: string;
  wifi_ssid?: string[];
  wifi_bssid?: string[];
  rule_set?: string[];
  rule_set_ip_cidr_match_source?: boolean;
  /**
   * Matches destinations the named outbounds/endpoints claim. Unlike a static
   * CIDR this follows a tailnet's live MagicDNS names and advertised subnet
   * routes. Tags here *are* validated at startup, unlike `outbound`.
   */
  preferred_by?: string[];
  invert?: boolean;
  /** `logical` rule. */
  type?: "logical";
  mode?: "and" | "or";
  rules?: RouteRule[];
  /** Action. Omitting it while setting `outbound` implies `action: "route"`. */
  action?: "route" | "route-options" | "direct" | "reject" | "hijack-dns" | "sniff" | "resolve";
  outbound?: string;
  /** `action: "reject"` */
  method?: "default" | "drop";
  no_drop?: boolean;
  /** `action: "sniff"` */
  sniffer?: string[];
  timeout?: string;
  /** `action: "resolve"` */
  server?: string;
  strategy?: DomainStrategy;
  /** `action: "route-options"` */
  udp_disable_domain_unmapping?: boolean;
}

export type RuleSet =
  | {
      type: "remote";
      tag: string;
      format: "binary" | "source";
      url: string;
      download_detour?: string;
      update_interval?: string;
    }
  | { type: "local"; tag: string; format: "binary" | "source"; path: string }
  | { type: "inline"; tag: string; rules: unknown[] };

export interface RouteOptions {
  rules?: RouteRule[];
  rule_set?: RuleSet[];
  final?: string;
  find_process?: boolean;
  auto_detect_interface?: boolean;
  override_android_vpn?: boolean;
  default_mark?: number;
  default_domain_resolver?: DomainResolveOptions | string;
  /** sing-box 1.14+ only; names an entry in the top-level `http_clients`. */
  default_http_client?: string;
}

/* ------------------------------------------------------------ experimental */

export interface ExperimentalOptions {
  cache_file?: {
    enabled: boolean;
    path?: string;
    cache_id?: string;
    store_fakeip?: boolean;
    store_rdrc?: boolean;
  };
  clash_api?: {
    external_controller?: string;
    external_ui?: string;
    external_ui_download_url?: string;
    external_ui_download_detour?: string;
    secret?: string;
    default_mode?: string;
    access_control_allow_origin?: string[];
    access_control_allow_private_network?: boolean;
  };
}
