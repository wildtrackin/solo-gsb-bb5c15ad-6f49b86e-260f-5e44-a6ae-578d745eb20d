import { useEffect, useMemo, useRef, useState } from 'react';
import { analyzeRules, matchPath, computeRepro } from './api';
import type { AnalysisResult, MatchResult, ReproResult, RuleInput } from './types';
import ImpactView from './ImpactView';

const MAX_REPRO_RULES = 20; // 与后端一致：复现包最多选择的规则数

const EXAMPLE = `# 每行一条规则：<优先级> <路由模式>
# :param 匹配单个段，* 匹配零个或多个段
# 优先级数字越大越先命中，平手按输入顺序
100 /api/users/:id
10  /api/users/new
90  /api/users/new
1   /api/*
0   /health
`;

const CANDIDATE_EXAMPLE = `# 候选规则：与基线对比评估变更影响
100 /api/users/:id
200 /api/users/new
1   /api/*
2   /internal/*
`;

const SAMPLES_EXAMPLE = `# 每行一条：[次数] 路径，次数省略时为 1
5 /api/users/new
3 /api/users/42
2 /health
7 /internal/ops
/api/other
`;

/** 解析一行输入为 { priority, pattern }；空行与 # 注释返回 null。 */
function parseLine(line: string): { priority: number; pattern: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const tokens = trimmed.split(/\s+/);
  const isInt = (s: string) => /^-?\d+$/.test(s);
  if (tokens.length >= 2 && isInt(tokens[0])) {
    return { priority: parseInt(tokens[0], 10), pattern: tokens.slice(1).join(' ') };
  }
  const last = tokens[tokens.length - 1];
  if (tokens.length >= 2 && isInt(last)) {
    return { priority: parseInt(last, 10), pattern: tokens.slice(0, -1).join(' ') };
  }
  return { priority: 0, pattern: trimmed };
}

/** 把规则文本解析为 RuleInput 列表；disabled 为基线规则中被勾掉的下标。 */
function toRuleInputs(text: string, disabled?: Set<number>): RuleInput[] {
  const out: RuleInput[] = [];
  text.split('\n').forEach((line) => {
    const parsed = parseLine(line);
    if (parsed) out.push({ ...parsed, enabled: !(disabled?.has(out.length) ?? false) });
  });
  return out;
}

export default function App() {
  const [mode, setMode] = useState<'analyze' | 'impact'>('analyze');
  const [text, setText] = useState(EXAMPLE);
  const [candidateText, setCandidateText] = useState(CANDIDATE_EXAMPLE);
  const [samplesText, setSamplesText] = useState(SAMPLES_EXAMPLE);
  const [disabled, setDisabled] = useState<Set<number>>(new Set());
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [testPath, setTestPath] = useState('/api/users/new');
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [reproSelected, setReproSelected] = useState<Set<number>>(new Set());
  const [repro, setRepro] = useState<ReproResult | null>(null);
  const [reproError, setReproError] = useState<string | null>(null);

  // 文本 → 规则输入（含启用状态）
  const ruleInputs: RuleInput[] = useMemo(() => toRuleInputs(text, disabled), [text, disabled]);
  // 候选规则：全部启用
  const candidateInputs: RuleInput[] = useMemo(() => toRuleInputs(candidateText), [candidateText]);

  // 即时重算：输入或禁用状态变化后防抖调用后端
  const analyzeSeq = useRef(0);
  useEffect(() => {
    const seq = ++analyzeSeq.current;
    const timer = setTimeout(() => {
      analyzeRules(ruleInputs)
        .then((result) => {
          if (seq !== analyzeSeq.current) return;
          setAnalysis(result);
          setAnalyzeError(null);
        })
        .catch((err: Error) => {
          if (seq !== analyzeSeq.current) return;
          setAnalyzeError(err.message);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [ruleInputs]);

  // 路径模拟
  const matchSeq = useRef(0);
  useEffect(() => {
    const seq = ++matchSeq.current;
    if (!testPath.trim()) {
      setMatchResult(null);
      return;
    }
    const timer = setTimeout(() => {
      matchPath(ruleInputs, testPath)
        .then((result) => {
          if (seq !== matchSeq.current) return;
          setMatchResult(result);
        })
        .catch(() => {
          if (seq !== matchSeq.current) return;
          setMatchResult(null);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [ruleInputs, testPath]);

  const toggleRule = (index: number) => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleReproRule = (index: number) => {
    setReproSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  // 实际纳入复现包的规则 id：仅启用且合法的被勾选规则
  const reproIds: string[] = useMemo(() => {
    if (!analysis) return [];
    return analysis.rules
      .filter((r) => reproSelected.has(r.index) && r.enabled && !r.error)
      .map((r) => r.id);
  }, [analysis, reproSelected]);

  // 复现包：选择或规则变化后防抖重算；序号守卫丢弃过期响应
  const reproSeq = useRef(0);
  useEffect(() => {
    const seq = ++reproSeq.current;
    if (reproIds.length < 2 || reproIds.length > MAX_REPRO_RULES) {
      setRepro(null);
      setReproError(null);
      return;
    }
    const timer = setTimeout(() => {
      computeRepro(ruleInputs, reproIds)
        .then((result) => {
          if (seq !== reproSeq.current) return;
          setRepro(result);
          setReproError(null);
        })
        .catch((err: Error) => {
          if (seq !== reproSeq.current) return;
          setRepro(null);
          setReproError(err.message);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [ruleInputs, reproIds]);

  const ruleById = useMemo(() => {
    const map = new Map<string, AnalysisResult['rules'][number]>();
    analysis?.rules.forEach((r) => map.set(r.id, r));
    return map;
  }, [analysis]);

  const exportJson = () => {
    if (!analysis) return;
    const payload = {
      tool: 'api-gateway-route-ambiguity-analyzer',
      exportedAt: new Date().toISOString(),
      rules: analysis.rules.map((r) => ({
        id: r.id,
        pattern: r.pattern,
        priority: r.priority,
        enabled: r.enabled,
        ...(r.error ? { error: r.error } : {}),
      })),
      conflicts: analysis.conflicts.map((c) => ({
        ruleA: c.a,
        ruleB: c.b,
        witness: c.witness,
        winner: c.winner,
        winnerInPair: c.winnerInPair,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `route-conflicts-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadRepro = () => {
    if (!repro) return;
    const payload = {
      tool: 'api-gateway-route-ambiguity-analyzer',
      mode: 'minimal-repro',
      exportedAt: new Date().toISOString(),
      rules: repro.rules.map((r) => ({
        id: r.id,
        pattern: r.pattern,
        priority: r.priority,
        enabled: r.enabled,
      })),
      conflicts: repro.conflicts.map((c) => ({
        ruleA: c.a,
        ruleB: c.b,
        witness: c.witness,
        winner: c.winner,
        winnerInPair: c.winnerInPair,
      })),
      totalConflicts: repro.totalConflicts,
      candidatePaths: repro.candidatePaths,
      paths: repro.paths.map((p) => ({
        path: p.path,
        hits: p.hits,
        covers: p.covers.map((c) => ({ ruleA: c.a, ruleB: c.b })),
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `route-repro-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const conflictCount = analysis?.conflicts.length ?? 0;
  const enabledCount = analysis?.rules.filter((r) => r.enabled && !r.error).length ?? 0;

  return (
    <div className="page">
      <header className="header">
        <h1>API 网关路由歧义排查</h1>
        <p>
          粘贴路由规则，找出可能同时命中的规则对，生成最短冲突见证路径，并按优先级模拟最终命中。
        </p>
        <div className="mode-tabs">
          <button
            className={mode === 'analyze' ? 'tab tab-active' : 'tab'}
            onClick={() => setMode('analyze')}
          >
            冲突分析
          </button>
          <button
            className={mode === 'impact' ? 'tab tab-active' : 'tab'}
            onClick={() => setMode('impact')}
          >
            变更影响
          </button>
        </div>
      </header>

      {mode === 'impact' ? (
        <ImpactView
          baselineText={text}
          onBaselineTextChange={setText}
          candidateText={candidateText}
          onCandidateTextChange={setCandidateText}
          samplesText={samplesText}
          onSamplesTextChange={setSamplesText}
          baselineInputs={ruleInputs}
          candidateInputs={candidateInputs}
        />
      ) : (
      <main className="layout">
        <section className="panel">
          <h2>路由规则</h2>
          <textarea
            className="rule-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            rows={12}
            placeholder={'每行一条：<优先级> <路由模式>\n例如：100 /api/users/:id'}
          />
          <div className="status-line">
            {analyzeError ? (
              <span className="error-text">分析失败：{analyzeError}</span>
            ) : (
              <span>
                {enabledCount} 条启用规则 · <strong>{conflictCount}</strong> 组冲突
              </span>
            )}
            <button className="btn" onClick={exportJson} disabled={!analysis}>
              导出 JSON
            </button>
          </div>

          {analysis && analysis.rules.length > 0 && (
            <table className="rule-table">
              <thead>
                <tr>
                  <th>启用</th>
                  <th title="勾选 2～20 条启用且合法的规则生成最小复现包">复现</th>
                  <th>ID</th>
                  <th>模式</th>
                  <th>优先级</th>
                </tr>
              </thead>
              <tbody>
                {analysis.rules.map((rule) => {
                  const usable = rule.enabled && !rule.error;
                  return (
                  <tr
                    key={rule.id}
                    className={rule.enabled ? '' : 'row-disabled'}
                    title={rule.error ?? undefined}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={() => toggleRule(rule.index)}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={usable && reproSelected.has(rule.index)}
                        disabled={!usable}
                        onChange={() => toggleReproRule(rule.index)}
                      />
                    </td>
                    <td className="mono">{rule.id}</td>
                    <td className="mono">
                      {rule.pattern}
                      {rule.error && <div className="error-text">{rule.error}</div>}
                    </td>
                    <td className="mono">{rule.priority}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>冲突对（{conflictCount}）</h2>
          {analysis && conflictCount === 0 && (
            <p className="muted">当前启用规则之间没有发现歧义。</p>
          )}
          <div className="conflict-list">
            {analysis?.conflicts.map((c) => {
              const ra = ruleById.get(c.a);
              const rb = ruleById.get(c.b);
              const winner = c.winner ? ruleById.get(c.winner) : null;
              return (
                <div className="conflict-card" key={`${c.a}-${c.b}`}>
                  <div className="conflict-head">
                    <span className="badge">{c.a}</span>
                    <span className="mono">{ra?.pattern}</span>
                    <span className="vs">×</span>
                    <span className="badge">{c.b}</span>
                    <span className="mono">{rb?.pattern}</span>
                  </div>
                  <div className="conflict-body">
                    <div>
                      见证路径：<code className="witness">{c.witness}</code>
                    </div>
                    <div>
                      最终命中：
                      {winner ? (
                        <>
                          <span className="badge badge-winner">{winner.id}</span>
                          <span className="mono"> {winner.pattern}</span>
                          <span className="muted">（优先级 {winner.priority}）</span>
                          {!c.winnerInPair && (
                            <span className="warn-text"> ← 被冲突对之外的规则截胡</span>
                          )}
                        </>
                      ) : (
                        <span className="muted">无</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <h2>路径模拟</h2>
          <input
            className="path-input mono"
            value={testPath}
            onChange={(e) => setTestPath(e.target.value)}
            placeholder="/some/request/path"
            spellCheck={false}
          />
          {matchResult && (
            <div className="match-result">
              {matchResult.winner ? (
                <>
                  <div>
                    <code className="witness">{matchResult.path}</code> 最终命中：
                    <span className="badge badge-winner">{matchResult.winner}</span>
                    <span className="mono">
                      {' '}
                      {ruleById.get(matchResult.winner)?.pattern}
                    </span>
                  </div>
                  {matchResult.matches.length > 1 && (
                    <div className="muted">
                      全部命中（按胜出顺序）：{matchResult.matches.join(' → ')}
                    </div>
                  )}
                </>
              ) : (
                <div className="muted">没有规则命中 {matchResult.path}</div>
              )}
            </div>
          )}

          <h2>最小复现包</h2>
          {reproIds.length < 2 ? (
            <p className="muted">
              在左侧规则表「复现」列勾选 2～{MAX_REPRO_RULES}{' '}
              条启用且合法的规则，后端将从已有的去重冲突见证路径中精确选出覆盖全部冲突对的最少路径集合。
            </p>
          ) : reproIds.length > MAX_REPRO_RULES ? (
            <p className="warn-text">
              最多选择 {MAX_REPRO_RULES} 条规则（当前 {reproIds.length} 条），请减少勾选。
            </p>
          ) : reproError ? (
            <p className="error-text">计算失败：{reproError}</p>
          ) : !repro ? (
            <p className="muted">计算中…</p>
          ) : repro.totalConflicts === 0 ? (
            <p className="muted">所选的 {reproIds.length} 条规则之间没有冲突，无需复现。</p>
          ) : (
            <>
              <div className="status-line">
                <span>
                  <strong>{repro.paths.length}</strong> 条路径覆盖全部 {repro.totalConflicts}{' '}
                  组冲突（候选见证 {repro.candidatePaths} 条）
                </span>
                <button className="btn" onClick={downloadRepro}>
                  下载复现包 JSON
                </button>
              </div>
              <div className="conflict-list">
                {repro.paths.map((p) => (
                  <div className="conflict-card" key={p.path}>
                    <div className="conflict-head">
                      <code className="witness">{p.path}</code>
                    </div>
                    <div className="conflict-body">
                      <div>
                        实际命中：
                        {p.hits.map((id) => {
                          const rule = ruleById.get(id);
                          return (
                            <span className="hit-item" key={id}>
                              <span className="badge">{id}</span>
                              <span className="mono muted">{rule?.pattern}</span>
                            </span>
                          );
                        })}
                      </div>
                      <div>
                        覆盖冲突对：
                        <span className="cover-list">
                          {p.covers.map((c) => (
                            <span className="badge badge-cover" key={`${c.a}-${c.b}`}>
                              {c.a} × {c.b}
                            </span>
                          ))}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </main>
      )}
    </div>
  );
}
