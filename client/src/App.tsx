import { useEffect, useMemo, useRef, useState } from 'react';
import { analyzeRules, matchPath } from './api';
import type { AnalysisResult, MatchResult, RuleInput } from './types';
import ImpactView from './ImpactView';

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
                  <th>ID</th>
                  <th>模式</th>
                  <th>优先级</th>
                </tr>
              </thead>
              <tbody>
                {analysis.rules.map((rule) => (
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
                    <td className="mono">{rule.id}</td>
                    <td className="mono">
                      {rule.pattern}
                      {rule.error && <div className="error-text">{rule.error}</div>}
                    </td>
                    <td className="mono">{rule.priority}</td>
                  </tr>
                ))}
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
        </section>
      </main>
      )}
    </div>
  );
}
