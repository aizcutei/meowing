import { useCallback, useEffect, useMemo, useState } from "react";

import { DEFAULT_OPTIONS, type ConvertOptions } from "../core/options";
import type { ConvertStats } from "../core/convert";
import type { SingBoxConfig } from "../core/singbox";
import { Button, SelectField, Section, Stat, TextField, Toggle } from "./ui";

interface ConvertResponse {
  config: SingBoxConfig;
  warnings: string[];
  stats: ConvertStats;
  filename: string;
  subscription: { path: string; url: string } | null;
  upstream: Array<{ url: string; userInfo: string | null }>;
  singBoxTarget: string;
}

type Mode = "url" | "paste";

export default function App() {
  const [mode, setMode] = useState<Mode>("url");
  const [urls, setUrls] = useState<string[]>([""]);
  const [yaml, setYaml] = useState("");
  const [token, setToken] = useState("");
  const [options, setOptions] = useState<ConvertOptions>(DEFAULT_OPTIONS);
  const [showOptions, setShowOptions] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null);
  const [result, setResult] = useState<ConvertResponse | null>(null);

  const set = useCallback(
    <K extends keyof ConvertOptions>(key: K, value: ConvertOptions[K]) =>
      setOptions((prev) => ({ ...prev, [key]: value })),
    [],
  );

  // FakeIP only does anything behind a TUN inbound; keep the UI honest about it.
  useEffect(() => {
    if (!options.tun && options.fakeIp) set("fakeIp", false);
  }, [options.tun, options.fakeIp, set]);

  const cleanUrls = useMemo(() => urls.map((u) => u.trim()).filter((u) => u !== ""), [urls]);
  const canSubmit = mode === "url" ? cleanUrls.length > 0 : yaml.trim() !== "";

  async function convert() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token.trim()) headers.authorization = `Bearer ${token.trim()}`;

      const response = await fetch("/api/convert", {
        method: "POST",
        headers,
        body: JSON.stringify({
          urls: mode === "url" ? cleanUrls : [],
          yaml: mode === "paste" ? yaml : undefined,
          options,
        }),
      });
      const body = (await response.json()) as Partial<ConvertResponse> & {
        error?: string;
        detail?: string;
      };
      if (!response.ok) {
        setError({ title: body.error ?? `HTTP ${response.status}`, detail: body.detail });
        return;
      }
      setResult(body as ConvertResponse);
    } catch (err) {
      setError({
        title: "Could not reach the converter",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto min-h-dvh max-w-5xl px-5 py-10 sm:px-8">
      <Header />

      <main className="mt-8 space-y-6">
        <SourceCard
          mode={mode}
          onModeChange={setMode}
          urls={urls}
          onUrlsChange={setUrls}
          yaml={yaml}
          onYamlChange={setYaml}
        />

        <div className="card p-5">
          <button
            type="button"
            onClick={() => setShowOptions((v) => !v)}
            className="flex w-full items-center justify-between text-left"
          >
            <span>
              <span className="text-sm font-semibold text-zinc-100">转换选项</span>
              <span className="ml-2 text-xs text-zinc-500">{summarise(options)}</span>
            </span>
            <span className="text-zinc-500">{showOptions ? "收起" : "展开"}</span>
          </button>

          {showOptions ? (
            <div className="mt-6 grid gap-8 border-t border-white/10 pt-6 md:grid-cols-2">
              <OptionsPanel options={options} set={set} />
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={convert} disabled={!canSubmit || busy}>
            {busy ? "转换中…" : "转换"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setOptions(DEFAULT_OPTIONS);
              setResult(null);
              setError(null);
            }}
            disabled={busy}
          >
            重置选项
          </Button>
          <div className="ml-auto w-full max-w-56 sm:w-56">
            <TextField
              label="访问令牌（如实例已设置）"
              type="password"
              value={token}
              onChange={setToken}
              placeholder="留空即可"
            />
          </div>
        </div>

        {error ? <ErrorCard title={error.title} detail={error.detail} /> : null}
        {result ? <ResultCard result={result} /> : null}
      </main>

      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
        🐾 Meowing
      </h1>
      <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
        把 Clash / mihomo 订阅转换成 sing-box 配置。生成的订阅链接是无状态的 —— 上游地址和选项都编码在链接里，
        没有数据库，客户端可以长期用它自动更新。
      </p>
    </header>
  );
}

function SourceCard({
  mode,
  onModeChange,
  urls,
  onUrlsChange,
  yaml,
  onYamlChange,
}: {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  urls: string[];
  onUrlsChange: (urls: string[]) => void;
  yaml: string;
  onYamlChange: (yaml: string) => void;
}) {
  return (
    <div className="card p-5">
      <div className="mb-4 flex gap-1 rounded-lg bg-black/30 p-1">
        {(
          [
            ["url", "订阅链接"],
            ["paste", "粘贴配置"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => onModeChange(value)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm transition ${
              mode === value ? "bg-white/10 text-white" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "url" ? (
        <div className="space-y-3">
          {urls.map((url, index) => (
            <div key={index} className="flex gap-2">
              <div className="flex-1">
                <TextField
                  label={index === 0 ? "Clash 订阅地址" : `附加订阅 ${index + 1}`}
                  type="url"
                  mono
                  value={url}
                  onChange={(value) => {
                    const next = [...urls];
                    next[index] = value;
                    onUrlsChange(next);
                  }}
                  placeholder="https://example.com/subscribe?token=..."
                />
              </div>
              {urls.length > 1 ? (
                <Button
                  variant="ghost"
                  className="mt-6 shrink-0"
                  onClick={() => onUrlsChange(urls.filter((_, i) => i !== index))}
                >
                  移除
                </Button>
              ) : null}
            </div>
          ))}
          <Button variant="ghost" onClick={() => onUrlsChange([...urls, ""])}>
            + 添加订阅
          </Button>
          <p className="text-xs text-zinc-500">
            多个订阅会合并节点；分组与规则取用第一个包含它们的订阅，其余订阅的节点会自动加入主策略组。
          </p>
        </div>
      ) : (
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-zinc-400">Clash YAML</span>
          <textarea
            value={yaml}
            onChange={(e) => onYamlChange(e.target.value)}
            spellCheck={false}
            rows={12}
            placeholder={"proxies:\n  - {name: 节点, type: ss, server: ..., port: 443, ...}"}
            className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[13px] text-zinc-100 placeholder:text-zinc-600"
          />
          <span className="block text-xs text-zinc-500">
            粘贴的配置没有可轮询的上游地址，因此只提供文件下载，不会生成订阅链接或二维码。
          </span>
        </label>
      )}
    </div>
  );
}

function OptionsPanel({
  options,
  set,
}: {
  options: ConvertOptions;
  set: <K extends keyof ConvertOptions>(key: K, value: ConvertOptions[K]) => void;
}) {
  return (
    <>
      <Section title="入站" description="至少需要保留一个。">
        <Toggle
          label="TUN"
          hint="透明代理，接管系统全部流量，需要管理员权限。"
          checked={options.tun}
          onChange={(v) => set("tun", v)}
          disabled={!options.mixed && options.tun}
        />
        {options.tun ? (
          <SelectField
            label="TUN 协议栈"
            value={options.tunStack}
            onChange={(v) => set("tunStack", v)}
            options={[
              { value: "mixed", label: "mixed（推荐）" },
              { value: "system", label: "system" },
              { value: "gvisor", label: "gvisor" },
            ]}
          />
        ) : null}
        <Toggle
          label="Mixed（HTTP + SOCKS）"
          hint="本地代理端口，无需特权。"
          checked={options.mixed}
          onChange={(v) => set("mixed", v)}
          disabled={!options.tun && options.mixed}
        />
        {options.mixed ? (
          <TextField
            label="Mixed 端口"
            type="number"
            value={String(options.mixedPort)}
            onChange={(v) => set("mixedPort", Number.parseInt(v, 10) || 2080)}
          />
        ) : null}
      </Section>

      <Section title="DNS" description="使用 sing-box 1.12+ 的新版 DNS 服务器格式。">
        <TextField
          label="代理 DNS"
          mono
          value={options.remoteDns}
          onChange={(v) => set("remoteDns", v)}
          placeholder="https://1.1.1.1/dns-query"
          hint="走代理解析。支持 https / h3 / tls / quic / tcp / udp。"
        />
        <TextField
          label="直连 DNS"
          mono
          value={options.localDns}
          onChange={(v) => set("localDns", v)}
          placeholder="https://223.5.5.5/dns-query"
        />
        <SelectField
          label="解析策略"
          value={options.dnsStrategy}
          onChange={(v) => set("dnsStrategy", v)}
          options={[
            { value: "prefer_ipv4", label: "prefer_ipv4" },
            { value: "prefer_ipv6", label: "prefer_ipv6" },
            { value: "ipv4_only", label: "ipv4_only" },
            { value: "ipv6_only", label: "ipv6_only" },
          ]}
        />
        <Toggle
          label="FakeIP"
          hint={options.tun ? "降低解析延迟，需要 TUN。" : "需要先启用 TUN。"}
          checked={options.fakeIp}
          onChange={(v) => set("fakeIp", v)}
          disabled={!options.tun}
        />
      </Section>

      <Section title="规则">
        <Toggle
          label="转换订阅自带规则"
          hint="相邻同目标的规则会合并，数万条通常会压缩到几十条。"
          checked={options.convertRules}
          onChange={(v) => set("convertRules", v)}
        />
        <Toggle
          label="附加国内直连规则"
          hint="追加 geosite-cn / geoip-cn 直连，作为兜底。"
          checked={options.addChinaDirect}
          onChange={(v) => set("addChinaDirect", v)}
        />
        <Toggle
          label="拦截广告"
          hint="使用 geosite-category-ads-all。"
          checked={options.blockAds}
          onChange={(v) => set("blockAds", v)}
        />
        <SelectField
          label="规则集源"
          value={options.ruleSetSource}
          onChange={(v) => set("ruleSetSource", v)}
          options={[
            { value: "sagernet", label: "SagerNet（官方）" },
            { value: "metacubex", label: "MetaCubeX meta-rules-dat" },
          ]}
        />
        <SelectField
          label="规则集下载方式"
          value={options.ruleSetDetour}
          onChange={(v) => set("ruleSetDetour", v)}
          hint="规则集托管在 GitHub raw，国内网络通常需要走代理。"
          options={[
            { value: "proxy", label: "走代理" },
            { value: "direct", label: "直连" },
          ]}
        />
      </Section>

      <Section title="策略组与其他">
        <Toggle
          label="添加「自动选择」组"
          hint="对全部节点做延迟测速的 urltest 组。"
          checked={options.addAutoSelect}
          onChange={(v) => set("addAutoSelect", v)}
        />
        <Toggle
          label="按地区分组"
          hint="从节点名推断地区，生成各地区的 urltest 组。"
          checked={options.addRegionGroups}
          onChange={(v) => set("addRegionGroups", v)}
        />
        <Toggle
          label="Clash API"
          hint="开放 127.0.0.1:9090，供 GUI 面板使用。"
          checked={options.clashApi}
          onChange={(v) => set("clashApi", v)}
        />
        <SelectField
          label="目标 sing-box 版本"
          value={options.targetVersion}
          onChange={(v) => set("targetVersion", v)}
          hint="1.14 使用新的 http_clients 声明；1.13 不认识该字段，改用已弃用的 download_detour。"
          options={[
            { value: "1.14", label: "1.14+（推荐）" },
            { value: "1.13", label: "1.13 兼容" },
          ]}
        />
        <SelectField
          label="日志级别"
          value={options.logLevel}
          onChange={(v) => set("logLevel", v)}
          options={[
            { value: "trace", label: "trace" },
            { value: "debug", label: "debug" },
            { value: "info", label: "info" },
            { value: "warn", label: "warn" },
            { value: "error", label: "error" },
          ]}
        />
      </Section>
    </>
  );
}

function ErrorCard({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-5">
      <h2 className="text-sm font-semibold text-rose-200">{title}</h2>
      {detail ? (
        <p className="mt-1.5 text-sm leading-relaxed break-words text-rose-100/80">{detail}</p>
      ) : null}
    </div>
  );
}

function ResultCard({ result }: { result: ConvertResponse }) {
  const [showConfig, setShowConfig] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);

  const json = useMemo(() => JSON.stringify(result.config, null, 2), [result.config]);
  const sizeKb = (new Blob([json]).size / 1024).toFixed(1);

  function download() {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const { stats } = result;

  return (
    <div className="card space-y-6 p-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="节点"
          value={stats.proxiesSkipped > 0 ? `${stats.proxiesOut}/${stats.proxiesIn}` : String(stats.proxiesOut)}
          {...(stats.proxiesSkipped > 0 ? { tone: "warn" as const } : {})}
        />
        <Stat label="策略组" value={String(stats.groupsOut)} />
        <Stat label="路由规则" value={`${stats.rulesIn} → ${stats.rulesOut}`} />
        <Stat label="配置大小" value={`${sizeKb} KB`} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={download}>
          ⤓ 下载 {result.filename}
        </Button>
        <Button onClick={() => void navigator.clipboard.writeText(json)}>复制配置</Button>
        <Button variant="ghost" onClick={() => setShowConfig((v) => !v)}>
          {showConfig ? "隐藏预览" : "预览配置"}
        </Button>
        <span className="text-xs text-zinc-500">目标 sing-box {result.singBoxTarget}</span>
      </div>

      {result.subscription ? (
        <ShareBlock url={result.subscription.url} />
      ) : (
        <p className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-xs text-zinc-400">
          本次使用的是粘贴的配置，没有可供客户端轮询的上游地址，因此不生成订阅链接与二维码。改用订阅链接即可获得。
        </p>
      )}

      {result.upstream.some((u) => u.userInfo) ? (
        <div className="text-xs text-zinc-400">
          {result.upstream
            .filter((u) => u.userInfo)
            .map((u) => (
              <div key={u.url} className="font-mono break-all">
                {formatUserInfo(u.userInfo!)}
              </div>
            ))}
        </div>
      ) : null}

      {result.warnings.length > 0 ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
          <button
            type="button"
            onClick={() => setShowWarnings((v) => !v)}
            className="flex w-full items-center justify-between text-left"
          >
            <span className="text-sm font-medium text-amber-200">
              {result.warnings.length} 条转换提示
            </span>
            <span className="text-xs text-amber-200/60">{showWarnings ? "收起" : "查看"}</span>
          </button>
          {showWarnings ? (
            <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-amber-100/80">
              {result.warnings.map((warning, index) => (
                <li key={index} className="break-words">
                  · {warning}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-emerald-300/80">✓ 全部内容均已转换，没有需要注意的问题。</p>
      )}

      {showConfig ? (
        <pre className="max-h-96 overflow-auto rounded-xl border border-white/10 bg-black/40 p-4 font-mono text-[12px] leading-relaxed text-zinc-300">
          {json}
        </pre>
      ) : null}
    </div>
  );
}

function ShareBlock({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="grid gap-5 rounded-xl border border-white/10 bg-black/20 p-4 sm:grid-cols-[1fr_auto]">
      <div className="min-w-0 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">订阅链接</h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            填进 sing-box 客户端的远程配置即可自动更新；扫描右侧二维码可直接传到手机。
          </p>
        </div>
        <code className="block max-h-24 overflow-auto rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-[12px] break-all text-sky-200">
          {url}
        </code>
        <div className="flex flex-wrap gap-2">
          <Button onClick={copy}>{copied ? "已复制" : "复制链接"}</Button>
          <Button variant="ghost" onClick={() => window.open(`${url}&download=1`, "_blank")}>
            直接下载
          </Button>
          <Button
            variant="ghost"
            onClick={() => window.open(`/api/qr?d=${encodeURIComponent(url)}`, "_blank")}
          >
            放大二维码
          </Button>
        </div>
        <p className="text-xs text-amber-200/70">
          链接中包含你的上游订阅地址（含令牌），请当作凭据对待，不要公开分享。
        </p>
      </div>

      <figure className="mx-auto w-40 shrink-0 sm:w-44">
        <img
          src={`/api/qr?d=${encodeURIComponent(url)}`}
          alt="订阅链接二维码"
          width={176}
          height={176}
          className="w-full rounded-lg bg-white p-2"
        />
        <figcaption className="mt-2 text-center text-xs text-zinc-500">扫码导入</figcaption>
      </figure>
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-12 border-t border-white/10 pt-6 text-xs leading-relaxed text-zinc-500">
      <p>
        转换结果以 sing-box 官方 schema 校验（<code className="font-mono">sing-box check</code>）。
        规则合并只在「相邻且同目标」的规则之间进行，因此 Clash 的首次匹配优先顺序不会改变。
      </p>
    </footer>
  );
}

/* -------------------------------------------------------------------- utils */

function summarise(options: ConvertOptions): string {
  const parts: string[] = [];
  if (options.tun) parts.push("TUN");
  if (options.mixed) parts.push(`Mixed:${options.mixedPort}`);
  if (options.fakeIp) parts.push("FakeIP");
  if (!options.convertRules) parts.push("不转换规则");
  if (options.blockAds) parts.push("拦截广告");
  if (options.addRegionGroups) parts.push("地区分组");
  return parts.join(" · ");
}

/** Renders the provider's `subscription-userinfo` header as human-readable text. */
function formatUserInfo(raw: string): string {
  const fields = new Map(
    raw
      .split(";")
      .map((part) => part.split("="))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([k, v]) => [k!.trim(), v!.trim()]),
  );
  const bytes = (value: string | undefined) => {
    const n = Number.parseFloat(value ?? "");
    if (!Number.isFinite(n)) return undefined;
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let size = n;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    return `${size.toFixed(2)} ${units[i]}`;
  };

  const used = (Number.parseFloat(fields.get("upload") ?? "0") || 0) +
    (Number.parseFloat(fields.get("download") ?? "0") || 0);
  const total = bytes(fields.get("total"));
  const expire = Number.parseFloat(fields.get("expire") ?? "");

  const parts: string[] = [];
  if (total) parts.push(`已用 ${bytes(String(used))} / ${total}`);
  if (Number.isFinite(expire) && expire > 0) {
    parts.push(`到期 ${new Date(expire * 1000).toISOString().slice(0, 10)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : raw;
}
