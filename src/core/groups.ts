/**
 * Clash `proxy-groups` -> sing-box `selector` / `urltest` outbounds.
 *
 * sing-box only has two group kinds, so several Clash group types collapse:
 * `select` maps to `selector`, and `url-test` / `fallback` / `load-balance` all
 * map to `urltest` (with a warning where the semantics genuinely differ).
 */

import { asBool, asInt, asString, type ClashProxy, type ClashProxyGroup } from "./clash";
import { seconds } from "./outbounds";
import type { SelectorOutbound, UrlTestOutbound } from "./singbox";

export const DIRECT_TAG = "direct";
export const BLOCK_TAG = "block";

const DEFAULT_TEST_URL = "https://www.gstatic.com/generate_204";

/** Clash's reserved policy names, which are outbounds rather than group members. */
const BUILTIN_TARGETS: Record<string, string> = {
  DIRECT: DIRECT_TAG,
  REJECT: BLOCK_TAG,
  "REJECT-DROP": BLOCK_TAG,
  PASS: DIRECT_TAG,
};

export function resolveBuiltinTarget(name: string): string | undefined {
  return BUILTIN_TARGETS[name.trim().toUpperCase()];
}

/**
 * Translates a Clash (Go `regexp`) filter into a JS `RegExp`.
 *
 * The only incompatibility that shows up in practice is Go's inline flag syntax
 * (`(?i)` for case-insensitive), which JS rejects; it is lifted into real flags.
 * Filters that still fail to compile are reported and treated as "match all".
 */
export function compileClashFilter(
  filter: string,
  warn: (msg: string) => void,
): RegExp | undefined {
  let source = filter;
  let flags = "u";
  const inline = /^\(\?([ims]+)\)/.exec(source);
  if (inline?.[1]) {
    source = source.slice(inline[0].length);
    for (const flag of inline[1]) if (!flags.includes(flag)) flags += flag;
  }
  try {
    return new RegExp(source, flags);
  } catch {
    try {
      // Emoji-heavy names occasionally break under the `u` flag; retry without it.
      return new RegExp(source, flags.replace("u", ""));
    } catch {
      warn(`filter /${filter}/ is not a valid JavaScript regular expression; ignored`);
      return undefined;
    }
  }
}

export interface GroupContext {
  /** All Clash proxies, in subscription order. */
  proxies: ClashProxy[];
  /** Clash proxy name -> sing-box outbound tag. */
  proxyTags: Map<string, string>;
  /** Clash group name -> sing-box outbound tag. */
  groupTags: Map<string, string>;
  warn: (msg: string) => void;
}

export interface GroupsResult {
  outbounds: Array<SelectorOutbound | UrlTestOutbound>;
  /** True when any group references REJECT and therefore needs a `block` outbound. */
  needsBlock: boolean;
  /** Groups dropped because they ended up with no usable members. */
  droppedGroups: Set<string>;
}

/** Expands the members of one group into concrete sing-box outbound tags. */
function memberTags(group: ClashProxyGroup, ctx: GroupContext): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const push = (tag: string) => {
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  };

  const include = asBool(group["include-all"]) === true ||
    asBool(group["include-all-proxies"]) === true ||
    // A group backed only by providers has no literal members we can read, so
    // the whole proxy list is the best available approximation.
    ((group.use?.length ?? 0) > 0 && (group.proxies?.length ?? 0) === 0);

  if (include) {
    const filter = asString(group.filter);
    const exclude = asString(group["exclude-filter"]);
    const filterRe = filter ? compileClashFilter(filter, ctx.warn) : undefined;
    const excludeRe = exclude ? compileClashFilter(exclude, ctx.warn) : undefined;

    for (const proxy of ctx.proxies) {
      const tag = ctx.proxyTags.get(proxy.name);
      if (!tag) continue;
      if (filterRe && !filterRe.test(proxy.name)) continue;
      if (excludeRe && excludeRe.test(proxy.name)) continue;
      push(tag);
    }
  }

  for (const member of group.proxies ?? []) {
    const builtin = resolveBuiltinTarget(member);
    if (builtin) {
      push(builtin);
      continue;
    }
    const proxyTag = ctx.proxyTags.get(member);
    if (proxyTag) {
      push(proxyTag);
      continue;
    }
    const groupTag = ctx.groupTags.get(member);
    if (groupTag) {
      push(groupTag);
      continue;
    }
    ctx.warn(`group "${group.name}" references unknown proxy "${member}"; skipped`);
  }

  return tags;
}

/**
 * Removes edges that would make one group (transitively) contain itself.
 * sing-box refuses to start on such a cycle, and subscriptions do produce them.
 */
function breakCycles(
  members: Map<string, string[]>,
  tagToGroupName: Map<string, string>,
  warn: (msg: string) => void,
): void {
  const state = new Map<string, "visiting" | "done">();

  const visit = (tag: string): void => {
    if (state.get(tag) === "done") return;
    state.set(tag, "visiting");
    const children = members.get(tag);
    if (children) {
      const kept: string[] = [];
      for (const child of children) {
        if (!members.has(child)) {
          kept.push(child);
          continue;
        }
        if (state.get(child) === "visiting") {
          warn(
            `dropped reference "${tagToGroupName.get(tag) ?? tag}" -> ` +
              `"${tagToGroupName.get(child) ?? child}" to break a group cycle`,
          );
          continue;
        }
        visit(child);
        kept.push(child);
      }
      members.set(tag, kept);
    }
    state.set(tag, "done");
  };

  for (const tag of members.keys()) visit(tag);
}

export function convertGroups(groups: ClashProxyGroup[], ctx: GroupContext): GroupsResult {
  const outbounds: Array<SelectorOutbound | UrlTestOutbound> = [];
  const droppedGroups = new Set<string>();
  let needsBlock = false;
  let warnedFallback = false;
  let warnedLoadBalance = false;

  // Resolve members for every group first so that `breakCycles` can see the
  // whole graph before any outbound is emitted.
  const members = new Map<string, string[]>();
  const tagToGroupName = new Map<string, string>();
  for (const group of groups) {
    const tag = ctx.groupTags.get(group.name);
    if (!tag) continue;
    members.set(tag, memberTags(group, ctx));
    tagToGroupName.set(tag, group.name);
  }
  breakCycles(members, tagToGroupName, ctx.warn);

  for (const group of groups) {
    const tag = ctx.groupTags.get(group.name);
    if (!tag) continue;
    const tags = members.get(tag) ?? [];

    if (tags.length === 0) {
      ctx.warn(`group "${group.name}" has no usable members; dropped`);
      droppedGroups.add(group.name);
      continue;
    }
    if (tags.includes(BLOCK_TAG)) needsBlock = true;

    switch (group.type) {
      case "select": {
        const selector: SelectorOutbound = { type: "selector", tag, outbounds: tags };
        // mihomo persists the user's pick; `default` is the closest static analogue.
        const preselect = asString(group.default);
        if (preselect) {
          const resolved =
            resolveBuiltinTarget(preselect) ??
            ctx.proxyTags.get(preselect) ??
            ctx.groupTags.get(preselect);
          if (resolved && tags.includes(resolved)) selector.default = resolved;
        }
        outbounds.push(selector);
        break;
      }

      case "url-test":
      case "fallback":
      case "load-balance": {
        if (group.type === "fallback" && !warnedFallback) {
          warnedFallback = true;
          ctx.warn(
            "`fallback` groups became `urltest`: sing-box picks the lowest-latency " +
              "node rather than the first reachable one in list order.",
          );
        }
        if (group.type === "load-balance" && !warnedLoadBalance) {
          warnedLoadBalance = true;
          ctx.warn(
            "`load-balance` groups became `urltest`: sing-box has no load balancer, " +
              "so traffic goes to a single lowest-latency node instead of being spread.",
          );
        }

        const urltest: UrlTestOutbound = { type: "urltest", tag, outbounds: tags };
        urltest.url = asString(group.url) ?? DEFAULT_TEST_URL;
        urltest.interval = seconds(group.interval) ?? "3m";
        const tolerance = asInt(group.tolerance);
        if (tolerance != null && tolerance > 0) urltest.tolerance = tolerance;
        outbounds.push(urltest);
        break;
      }

      case "relay":
        // A relay is a dial chain (`detour`), not a group; representing it would
        // mean rewriting every member outbound and it cannot be selected.
        ctx.warn(`group "${group.name}" is a \`relay\`, which has no sing-box group type; dropped`);
        droppedGroups.add(group.name);
        break;

      default:
        ctx.warn(`group "${group.name}" has unknown type "${group.type}"; treated as select`);
        outbounds.push({ type: "selector", tag, outbounds: tags });
        break;
    }
  }

  return { outbounds, needsBlock, droppedGroups };
}
