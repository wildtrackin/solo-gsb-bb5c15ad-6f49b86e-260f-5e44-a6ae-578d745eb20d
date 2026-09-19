/**
 * 路由歧义分析核心逻辑。
 *
 * 路由模式由 `/` 分隔的段组成，段有三种：
 *  - static:  字面量，精确匹配一个段
 *  - param:   `:name`，匹配任意一个非空段
 *  - star:    `*`，匹配零个或多个段
 *
 * 冲突判定：两条规则存在共同匹配的具体路径即冲突。
 * 见证路径：把每条规则看作一个段级 NFA，在二者的积自动机上做 0-1 BFS，
 *           星号“跳过”是 0 代价 epsilon 边，消费一个段是 1 代价边，
 *           得到的即段数最短的具体见证路径。
 */

export type Segment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'star' };

export interface RuleInput {
  pattern: string;
  priority: number;
  enabled: boolean;
}

export interface AnalyzedRule {
  id: string; // R1、R2……按输入顺序
  index: number;
  pattern: string; // 规范化后的模式（保证以 / 开头）
  priority: number;
  enabled: boolean;
  segments: Segment[];
  error: string | null;
}

export interface ConflictPair {
  a: string; // 规则 id
  b: string;
  witness: string; // 最短共同命中的具体路径
  winner: string | null; // 所有启用规则中模拟最终命中的规则 id
  winnerInPair: boolean; // 胜出者是否就是冲突对之一
}

export interface AnalysisResult {
  rules: AnalyzedRule[];
  conflicts: ConflictPair[];
}

export interface MatchResult {
  path: string;
  matches: string[]; // 所有命中的启用规则 id，按胜出顺序排列
  winner: string | null;
}

/** 变更影响分类：命中迁移 / 新增命中 / 变为未命中 / 无变化。 */
export type ImpactCategory = 'migrated' | 'added' | 'removed' | 'unchanged';

/** 胜出规则的对外标识；是否“同一规则”只看规范化模式与优先级。 */
export interface WinnerRef {
  id: string; // 规则 id，仅用于展示
  pattern: string; // 规范化后的模式
  priority: number;
}

export interface SampleImpact {
  line: number; // 样本在输入中的行号（1 起）
  count: number; // 请求次数
  path: string; // 规范化后的请求路径
  baseline: WinnerRef | null; // 基线规则下的胜出规则
  candidate: WinnerRef | null; // 候选规则下的胜出规则
  category: ImpactCategory;
}

export interface InvalidSample {
  line: number;
  raw: string;
  error: string;
}

export interface CategorySummary {
  samples: number; // 样本条数
  requests: number; // 请求次数合计
}

export interface ImpactResult {
  baselineRules: AnalyzedRule[];
  candidateRules: AnalyzedRule[];
  samples: SampleImpact[];
  invalidSamples: InvalidSample[];
  summary: Record<ImpactCategory, CategorySummary> & { total: CategorySummary };
}

// ---------- 最小复现包 ----------

/** 复现包中的一个冲突对（同时给出该对最短见证路径）。 */
export interface ReproConflict {
  index: number; // 在本复现包冲突对序列中的下标（0 起）
  a: string;
  b: string;
  witness: string; // 该冲突对的最短共同命中路径（候选路径来源）
}

/** 复现包中的一条具体路径及其实际命中情况。 */
export interface ReproPath {
  path: string;
  segments: number; // 路径总段数（并列时的决胜指标之一）
  matchedRules: string[]; // 该路径实际命中的已选规则 id，按胜出顺序排列
  coveredConflicts: number[]; // 实际覆盖的冲突对下标
}

export interface ReproPackage {
  selectedRuleIds: string[];
  conflicts: ReproConflict[];
  candidates: ReproPath[]; // 去重后的全部候选路径
  paths: ReproPath[]; // 入选的最少路径集合（字典序排列）
  conflictPairCount: number;
  candidateCount: number;
  pathCount: number;
  totalSegments: number; // 入选路径总段数
}

/** 最小集合覆盖求解器的候选项：覆盖位掩码 + 决胜信息。 */
export interface CoverItem {
  cover: bigint; // 覆盖的冲突对位掩码（第 i 位对应第 i 个冲突对）
  segments: number; // 路径段数
  pathSegments: string[]; // 路径段序列（字典序决胜用）
}

export interface MinimumCoverResult {
  indices: number[] | null; // 入选候选项下标；exact=false 时为已找到的最优上界
  exact: boolean; // 是否在搜索预算内完成了完整分支限界
  nodes: number; // 实际展开的搜索节点数
}

/** 分支限界的最大节点展开预算：路由派生的候选覆盖都是边团，正常输入远低于此。 */
const MAX_SEARCH_NODES = 300_000;

const PARAM_PLACEHOLDER = 'x'; // 见证路径中为参数段生成的具体值
const MAX_SAMPLE_COUNT = 1_000_000_000; // 单条样本允许的最大请求次数

/** 把模式字符串解析为段序列；非法时抛出带说明的错误。 */
export function parsePattern(raw: string): Segment[] {
  const pattern = raw.trim();
  if (!pattern) throw new Error('模式为空');
  const parts = pattern.split('/').filter((p) => p.length > 0);
  return parts.map((part) => {
    if (part === '*') return { kind: 'star' };
    if (part.includes('*')) {
      throw new Error(`段 "${part}" 非法：* 必须单独成段`);
    }
    if (part.startsWith(':')) {
      const name = part.slice(1);
      if (!name) throw new Error('参数段 ":" 缺少名称');
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
        throw new Error(`参数名 "${name}" 非法`);
      }
      return { kind: 'param', name };
    }
    return { kind: 'static', value: part };
  });
}

/** 规范化模式：保证以 / 开头，去掉多余斜杠。 */
export function normalizePattern(raw: string): string {
  const parts = raw.trim().split('/').filter((p) => p.length > 0);
  return '/' + parts.join('/');
}

/** 把具体路径切分为段。 */
export function splitPath(path: string): string[] {
  return path.trim().split('/').filter((p) => p.length > 0);
}

/** 判断规则段序列是否匹配给定具体路径段（* 匹配零或多段）。 */
export function matchSegments(segments: Segment[], pathSegs: string[]): boolean {
  const n = segments.length;
  const m = pathSegs.length;
  // dp[i][j]：segments[i:] 是否匹配 pathSegs[j:]
  const dp: boolean[][] = Array.from({ length: n + 1 }, () =>
    new Array<boolean>(m + 1).fill(false),
  );
  dp[n][m] = true;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      const seg = segments[i];
      if (seg.kind === 'star') {
        // 匹配零段，或消费一段后仍在星号状态
        dp[i][j] = dp[i + 1][j] || (j < m && dp[i][j + 1]);
      } else if (j < m) {
        const one =
          seg.kind === 'static' ? pathSegs[j] === seg.value : true; // param 匹配任意单段
        dp[i][j] = one && dp[i + 1][j + 1];
      }
    }
  }
  return dp[0][0];
}

/**
 * 计算两条规则段序列的最短共同见证路径（段数组），不存在时返回 null。
 * 在积自动机 (i, j) 上做 0-1 BFS：星号跳过为 0 代价边，消费一段为 1 代价边。
 */
export function intersectionWitness(a: Segment[], b: Segment[]): string[] | null {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const idx = (i: number, j: number) => i * width + j;
  const start = idx(0, 0);
  const target = idx(n, m);

  const dist = new Array<number>((n + 1) * (m + 1)).fill(Infinity);
  const prev = new Array<number>(dist.length).fill(-1);
  const prevSeg = new Array<string>(dist.length).fill('');
  const deque: number[] = [];
  dist[start] = 0;
  deque.push(start);

  const relax = (from: number, to: number, cost: number, seg: string | null) => {
    if (dist[from] + cost < dist[to]) {
      dist[to] = dist[from] + cost;
      prev[to] = from;
      prevSeg[to] = seg ?? '';
      if (cost === 0) deque.unshift(to);
      else deque.push(to);
    }
  };

  while (deque.length > 0) {
    const cur = deque.shift()!;
    const i = Math.floor(cur / width);
    const j = cur % width;
    const sa = i < n ? a[i] : null;
    const sb = j < m ? b[j] : null;

    // 0 代价边：星号匹配零段
    if (sa && sa.kind === 'star') relax(cur, idx(i + 1, j), 0, null);
    if (sb && sb.kind === 'star') relax(cur, idx(i, j + 1), 0, null);

    // 1 代价边：双方同时消费同一个具体段（一方已结束时无法再共同消费）
    if (sa && sb) {
      if (sa.kind === 'static' && sb.kind === 'static') {
        if (sa.value === sb.value) relax(cur, idx(i + 1, j + 1), 1, sa.value);
      } else if (sa.kind === 'static') {
        // b 为 param 或 star，具体段取 a 的字面量
        relax(cur, idx(i + 1, sb.kind === 'star' ? j : j + 1), 1, sa.value);
      } else if (sb.kind === 'static') {
        relax(cur, idx(sa.kind === 'star' ? i : i + 1, j + 1), 1, sb.value);
      } else {
        // param/star 组合：用占位具体段
        const ni = sa.kind === 'star' ? i : i + 1;
        const nj = sb.kind === 'star' ? j : j + 1;
        relax(cur, idx(ni, nj), 1, PARAM_PLACEHOLDER);
      }
    }
  }

  if (!Number.isFinite(dist[target])) return null;

  const segs: string[] = [];
  let cur = target;
  while (cur !== start) {
    const p = prev[cur];
    if (p < 0) return null;
    if (dist[cur] - dist[p] === 1) segs.unshift(prevSeg[cur]);
    cur = p;
  }
  return segs;
}

/** 在启用且合法的规则中，为给定路径段找出最终命中的规则（优先级大者先，平手按输入顺序）。 */
export function findWinner(
  rules: AnalyzedRule[],
  pathSegs: string[],
): AnalyzedRule | null {
  let best: AnalyzedRule | null = null;
  for (const rule of rules) {
    if (!rule.enabled || rule.error) continue;
    if (!matchSegments(rule.segments, pathSegs)) continue;
    if (
      !best ||
      rule.priority > best.priority ||
      (rule.priority === best.priority && rule.index < best.index)
    ) {
      best = rule;
    }
  }
  return best;
}

/** 完整分析：解析规则、两两求交找冲突、为每个冲突模拟最终命中。 */
export function analyze(inputs: RuleInput[]): AnalysisResult {
  const rules: AnalyzedRule[] = inputs.map((input, index) => {
    const base = {
      id: `R${index + 1}`,
      index,
      priority: Number.isFinite(input.priority) ? Math.trunc(input.priority) : 0,
      enabled: input.enabled !== false,
      pattern: '',
      segments: [] as Segment[],
      error: null as string | null,
    };
    try {
      base.pattern = normalizePattern(String(input.pattern ?? ''));
      base.segments = parsePattern(String(input.pattern ?? ''));
    } catch (err) {
      base.pattern = String(input.pattern ?? '').trim() || '(空)';
      base.error = err instanceof Error ? err.message : String(err);
    }
    return base;
  });

  const usable = rules.filter((r) => r.enabled && !r.error);
  const conflicts: ConflictPair[] = [];
  for (let x = 0; x < usable.length; x++) {
    for (let y = x + 1; y < usable.length; y++) {
      const ra = usable[x];
      const rb = usable[y];
      const witnessSegs = intersectionWitness(ra.segments, rb.segments);
      if (!witnessSegs) continue;
      const winner = findWinner(rules, witnessSegs);
      conflicts.push({
        a: ra.id,
        b: rb.id,
        witness: '/' + witnessSegs.join('/'),
        winner: winner ? winner.id : null,
        winnerInPair: winner !== null && (winner.id === ra.id || winner.id === rb.id),
      });
    }
  }
  return { rules, conflicts };
}

/** 模拟单条具体路径的最终命中。 */
export function simulate(inputs: RuleInput[], path: string): MatchResult {
  const { rules } = analyze(inputs);
  const pathSegs = splitPath(path);
  const hits = rules
    .filter((r) => r.enabled && !r.error && matchSegments(r.segments, pathSegs))
    .sort((x, y) => y.priority - x.priority || x.index - y.index);
  return {
    path: '/' + pathSegs.join('/'),
    matches: hits.map((r) => r.id),
    winner: hits.length > 0 ? hits[0].id : null,
  };
}

/**
 * 解析一行请求样本：格式为 “次数 路径”，次数省略时为 1。
 * 空行与 # 注释返回 null（跳过）；非法行返回 { error }。
 */
export function parseSampleLine(
  line: string,
): { count: number; path: string } | { error: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const tokens = trimmed.split(/\s+/);
  let count = 1;
  let pathToken: string;
  if (/^-?\d+$/.test(tokens[0])) {
    // 首个 token 是整数 → 视为次数
    const n = Number(tokens[0]);
    if (!Number.isSafeInteger(n) || n < 1) {
      return { error: `次数 "${tokens[0]}" 必须为正整数` };
    }
    if (n > MAX_SAMPLE_COUNT) {
      return { error: `次数 "${tokens[0]}" 超出上限 ${MAX_SAMPLE_COUNT}` };
    }
    if (tokens.length < 2) return { error: '缺少请求路径' };
    if (tokens.length > 2) return { error: '路径中不能包含空白字符' };
    count = n;
    pathToken = tokens[1];
  } else {
    if (tokens.length > 1) return { error: '路径中不能包含空白字符' };
    pathToken = tokens[0];
  }
  if (!pathToken.startsWith('/')) {
    return { error: `路径 "${pathToken}" 必须以 / 开头` };
  }
  return { count, path: pathToken };
}

function winnerRef(rule: AnalyzedRule | null): WinnerRef | null {
  return rule ? { id: rule.id, pattern: rule.pattern, priority: rule.priority } : null;
}

/** 规范化模式与优先级均相同才视为同一规则。 */
function sameWinner(a: WinnerRef | null, b: WinnerRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.pattern === b.pattern && a.priority === b.priority;
}

/**
 * 变更影响分析：对每条合法样本，分别用基线与候选规则模拟最终命中，
 * 按“命中迁移、新增命中、变为未命中、无变化”分类并汇总请求次数。
 * 非法样本逐行记录错误，不参与统计。
 */
export function impact(
  baselineInputs: RuleInput[],
  candidateInputs: RuleInput[],
  sampleLines: string[],
): ImpactResult {
  const baseline = analyze(baselineInputs);
  const candidate = analyze(candidateInputs);
  const samples: SampleImpact[] = [];
  const invalidSamples: InvalidSample[] = [];
  const summary: ImpactResult['summary'] = {
    migrated: { samples: 0, requests: 0 },
    added: { samples: 0, requests: 0 },
    removed: { samples: 0, requests: 0 },
    unchanged: { samples: 0, requests: 0 },
    total: { samples: 0, requests: 0 },
  };

  sampleLines.forEach((line, i) => {
    const parsed = parseSampleLine(line);
    if (parsed === null) return; // 空行或注释
    if ('error' in parsed) {
      invalidSamples.push({ line: i + 1, raw: line.trim(), error: parsed.error });
      return;
    }
    const pathSegs = splitPath(parsed.path);
    const bw = winnerRef(findWinner(baseline.rules, pathSegs));
    const cw = winnerRef(findWinner(candidate.rules, pathSegs));
    let category: ImpactCategory;
    if (bw === null && cw === null) category = 'unchanged';
    else if (bw === null) category = 'added';
    else if (cw === null) category = 'removed';
    else category = sameWinner(bw, cw) ? 'unchanged' : 'migrated';
    samples.push({
      line: i + 1,
      count: parsed.count,
      path: '/' + pathSegs.join('/'),
      baseline: bw,
      candidate: cw,
      category,
    });
    summary[category].samples += 1;
    summary[category].requests += parsed.count;
    summary.total.samples += 1;
    summary.total.requests += parsed.count;
  });

  return {
    baselineRules: baseline.rules,
    candidateRules: candidate.rules,
    samples,
    invalidSamples,
    summary,
  };
}

// ---------- 最小复现包：确定性分支限界最小集合覆盖 ----------

function popcountBig(x: bigint): number {
  let n = 0;
  while (x > 0n) {
    x &= x - 1n;
    n++;
  }
  return n;
}

/** 按段序列比较路径字典序：先出现差异的段按字符串比较，短序列前缀更小。 */
function compareSegments(x: string[], y: string[]): number {
  const k = Math.min(x.length, y.length);
  for (let i = 0; i < k; i++) {
    if (x[i] < y[i]) return -1;
    if (x[i] > y[i]) return 1;
  }
  return x.length - y.length;
}

/** 比较两个同大小方案：总段数少者优；再按排序后的路径字典序逐项决胜。 */
function compareSolutions(
  xs: string[][],
  ys: string[][],
  segX: number,
  segY: number,
): number {
  if (segX !== segY) return segX - segY;
  const sx = xs.map((p) => p.slice()).sort(compareSegments);
  const sy = ys.map((p) => p.slice()).sort(compareSegments);
  for (let i = 0; i < sx.length; i++) {
    const c = compareSegments(sx[i], sy[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * 确定性分支限界求解最小集合覆盖。
 *  - 精确最优：候选至多覆盖 190 个冲突对（20 条规则两两求交），位掩码为 bigint。
 *  - 分支：取当前未覆盖冲突对中「可覆盖它的候选数最少」的一对，只在能覆盖它的候选上分支。
 *  - 下界：取 |剩余| / maxGain 的上取整，并与独立集打包下界取较大值。
 *  - 并列决胜：路径总段数、排序后的路径字典序（compareSolutions），全程确定。
 * 返回 { indices, exact, nodes }：indices 为入选候选项下标，不可行时为 null；
 * 搜索超出节点预算时 exact=false（indices 为已找到的最优上界，可能并非真正最优）。
 */
export function minimumCover(items: CoverItem[], universeMask: bigint): MinimumCoverResult {
  if (universeMask === 0n) return { indices: [], exact: true, nodes: 0 };
  // 空覆盖候选无意义；同覆盖候选项只保留段数最少、字典序最小者作为代表
  const reps = new Map<bigint, number>();
  items.forEach((it, idx) => {
    if (it.cover === 0n) return;
    const cur = reps.get(it.cover);
    if (
      cur === undefined ||
      it.segments < items[cur].segments ||
      (it.segments === items[cur].segments &&
        compareSegments(it.pathSegments, items[cur].pathSegments) < 0)
    ) {
      reps.set(it.cover, idx);
    }
  });
  const cand = [...reps.values()];

  // 可达性：每个冲突对至少要被某个候选覆盖
  let reach = 0n;
  for (const idx of cand) reach |= items[idx].cover;
  if ((reach & universeMask) !== universeMask) {
    return { indices: null, exact: true, nodes: 0 };
  }

  // 每个冲突对的可覆盖候选表（按下标顺序）；可达性已保证每个位至少有一个候选
  const covering: number[][] = [];
  for (const idx of cand) {
    let bits = items[idx].cover & universeMask;
    while (bits > 0n) {
      const bit = bits & -bits;
      const i = bit.toString(2).length - 1;
      if (!covering[i]) covering[i] = [];
      covering[i].push(idx);
      bits ^= bit;
    }
  }

  const maxGain = Math.max(...cand.map((idx) => popcountBig(items[idx].cover & universeMask)));

  /** 下界（对给定未覆盖掩码确定）：max(上取整比例下界, 独立集打包下界)。 */
  const lowerBound = (remaining: bigint): number => {
    const ratio = Math.ceil(popcountBig(remaining) / maxGain);
    // 打包：不断取一个冲突对，剔除与之能被同一路径同时覆盖的对，计数加一
    let rest = remaining;
    let packing = 0;
    while (rest > 0n) {
      // 选可覆盖候选最少的对，得到不弱于任取低位的打包
      let pick = -1;
      let bestCount = Infinity;
      let scan = rest;
      while (scan > 0n) {
        const bit = scan & -scan;
        const i = bit.toString(2).length - 1;
        const cnt = covering[i].filter((idx) => (items[idx].cover & rest) !== 0n).length;
        if (cnt < bestCount) {
          bestCount = cnt;
          pick = i;
        }
        scan ^= bit;
      }
      packing++;
      let co = 0n;
      for (const idx of covering[pick]) co |= items[idx].cover;
      rest &= ~co;
    }
    return Math.max(ratio, packing);
  };

  let best: number[] | null = null;
  let bestSeg = Infinity;
  const consider = (chosen: number[]) => {
    // 首要目标是路径数：更少路径的方案无条件胜出，段数/字典序只在同路径数时比较
    if (best === null || chosen.length < best.length) {
      best = chosen.slice();
      bestSeg = chosen.reduce((s, idx) => s + items[idx].segments, 0);
      return;
    }
    if (chosen.length === best.length) {
      const seg = chosen.reduce((s, idx) => s + items[idx].segments, 0);
      // compareSolutions 内部先比总段数，再比排序后的路径字典序
      const c = compareSolutions(
        chosen.map((idx) => items[idx].pathSegments),
        best.map((idx) => items[idx].pathSegments),
        seg,
        bestSeg,
      );
      if (c < 0) {
        best = chosen.slice();
        bestSeg = seg;
      }
    }
  };

  // 同一覆盖掩码到达过的最小路径数：更晚且步数严格更多的同状态必不更优；
  // 步数相同的到达不能剪——其路径组合可能在段数/字典序决胜中更优
  const bestCountForMask = new Map<bigint, number>();
  let nodes = 0;
  let truncated = false;

  const dfs = (covered: bigint, chosen: number[]) => {
    if (truncated) return;
    nodes++;
    if (nodes > MAX_SEARCH_NODES) {
      truncated = true;
      return;
    }
    const remaining = universeMask & ~covered;
    if (remaining === 0n) {
      consider(chosen);
      return;
    }
    if (best !== null && chosen.length + lowerBound(remaining) > best.length) return;
    const seen = bestCountForMask.get(covered);
    if (seen !== undefined && chosen.length > seen) return;
    if (seen === undefined || chosen.length < seen) bestCountForMask.set(covered, chosen.length);

    // MRV：选可扩展候选最少的未覆盖冲突对
    let target = -1;
    let targetCount = Infinity;
    let scan = remaining;
    while (scan > 0n) {
      const bit = scan & -scan;
      const i = bit.toString(2).length - 1;
      let cnt = 0;
      for (const idx of covering[i]) if ((items[idx].cover & remaining) !== 0n) cnt++;
      if (cnt < targetCount) {
        targetCount = cnt;
        target = i;
      }
      scan ^= bit;
    }

    // 分支顺序确定：新增覆盖多、段数少、字典序小者先（利于尽早得到紧的上界）
    const branches = covering[target]
      .filter((idx) => (items[idx].cover & remaining) !== 0n)
      .sort((x, y) => {
        const gx = popcountBig(items[x].cover & remaining);
        const gy = popcountBig(items[y].cover & remaining);
        if (gx !== gy) return gy - gx;
        if (items[x].segments !== items[y].segments)
          return items[x].segments - items[y].segments;
        return compareSegments(items[x].pathSegments, items[y].pathSegments) || x - y;
      });

    for (const idx of branches) {
      chosen.push(idx);
      dfs(covered | items[idx].cover, chosen);
      chosen.pop();
    }
  };

  dfs(0n, []);
  if (best === null) {
    // 预算耗尽前连一个可行覆盖都未找到（理论上可达性保证可行，仅极端预算下发生）
    return { indices: null, exact: false, nodes };
  }
  const result: number[] = best; // best 在递归闭包中赋值，显式标注避免被窄化为 never
  return {
    indices: result.slice().sort((x, y) => x - y),
    exact: !truncated,
    nodes,
  };
}

/**
 * 最小复现包：
 *  - 从启用且合法的规则中选择 2～20 条；
 *  - 以所选规则两两冲突对已有的最短见证路径（去重）为候选；
 *  - 重新计算每条候选路径实际命中的已选规则及覆盖的冲突对；
 *  - 用确定性分支限界选出覆盖全部冲突对的最少路径集合，
 *    并列时依次按路径总段数、排序后的路径字典序决胜。
 */
export function reproPackage(inputs: RuleInput[], selectedIds: string[]): ReproPackage {
  const { rules } = analyze(inputs);
  const byId = new Map(rules.map((r) => [r.id, r]));
  if (selectedIds.length < 2 || selectedIds.length > 20) {
    throw new Error('复现包需要选择 2～20 条规则');
  }
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error('选择的规则存在重复');
  }
  const selected: AnalyzedRule[] = [];
  for (const id of selectedIds) {
    const r = byId.get(id);
    if (!r) throw new Error(`规则 ${id} 不存在`);
    if (r.error) throw new Error(`规则 ${id} 非法，不能加入复现包`);
    if (!r.enabled) throw new Error(`规则 ${id} 已禁用，不能加入复现包`);
    selected.push(r);
  }
  selected.sort((x, y) => x.index - y.index);

  // 所选规则之间的冲突对（复用两两最短见证）
  const conflicts: ReproConflict[] = [];
  for (let x = 0; x < selected.length; x++) {
    for (let y = x + 1; y < selected.length; y++) {
      const witnessSegs = intersectionWitness(selected[x].segments, selected[y].segments);
      if (!witnessSegs) continue;
      conflicts.push({
        index: conflicts.length,
        a: selected[x].id,
        b: selected[y].id,
        witness: '/' + witnessSegs.join('/'),
      });
    }
  }

  // 候选路径：冲突对已有见证路径去重（首次出现顺序保留）
  const candidateSegs: string[][] = [];
  const seenPaths = new Set<string>();
  for (const c of conflicts) {
    if (!seenPaths.has(c.witness)) {
      seenPaths.add(c.witness);
      candidateSegs.push(splitPath(c.witness));
    }
  }

  // 重新计算每条候选实际命中的已选规则与覆盖的冲突对
  const toReproPath = (segs: string[]): Omit<ReproPath, 'coveredConflicts'> & {
    covered: Set<number>;
  } => {
    const hits = selected
      .filter((r) => matchSegments(r.segments, segs))
      .sort((x, y) => y.priority - x.priority || x.index - y.index);
    const hitIds = new Set(hits.map((r) => r.id));
    const covered = new Set<number>();
    conflicts.forEach((c, i) => {
      if (hitIds.has(c.a) && hitIds.has(c.b)) covered.add(i);
    });
    return {
      path: '/' + segs.join('/'),
      segments: segs.length,
      matchedRules: hits.map((r) => r.id),
      covered,
    };
  };

  const computed = candidateSegs.map(toReproPath);

  if (conflicts.length === 0) {
    return {
      selectedRuleIds: selected.map((r) => r.id),
      conflicts,
      candidates: computed.map(({ covered, ...rest }) => ({
        ...rest,
        coveredConflicts: [],
      })),
      paths: [],
      conflictPairCount: 0,
      candidateCount: computed.length,
      pathCount: 0,
      totalSegments: 0,
    };
  }

  const universe = (1n << BigInt(conflicts.length)) - 1n;
  const items: CoverItem[] = computed.map((p) => {
    let cover = 0n;
    for (const i of p.covered) cover |= 1n << BigInt(i);
    return { cover, segments: p.segments, pathSegments: splitPath(p.path) };
  });

  const search = minimumCover(items, universe);
  if (search.indices === null) throw new Error('候选见证路径无法覆盖全部冲突对（不应发生）');
  if (!search.exact) {
    throw new Error('冲突结构过于复杂，分支限界在预算内无法确认最优解；请减少选择的规则数量');
  }
  const chosen = search.indices;

  // 入选路径按段序列字典序排列，保证展示与决胜口径一致
  const chosenSorted = chosen.slice().sort((x, y) => {
    const c = compareSegments(items[x].pathSegments, items[y].pathSegments);
    return c !== 0 ? c : x - y;
  });

  return {
    selectedRuleIds: selected.map((r) => r.id),
    conflicts,
    candidates: computed.map(({ covered, ...rest }) => ({
      ...rest,
      coveredConflicts: [...covered].sort((x, y) => x - y),
    })),
    paths: chosenSorted.map((idx) => ({
      path: computed[idx].path,
      segments: computed[idx].segments,
      matchedRules: computed[idx].matchedRules,
      coveredConflicts: [...computed[idx].covered].sort((x, y) => x - y),
    })),
    conflictPairCount: conflicts.length,
    candidateCount: computed.length,
    pathCount: chosenSorted.length,
    totalSegments: chosenSorted.reduce((s, idx) => s + computed[idx].segments, 0),
  };
}
