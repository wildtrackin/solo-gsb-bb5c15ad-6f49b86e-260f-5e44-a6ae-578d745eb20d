import { useEffect, useMemo, useRef, useState } from 'react';
import { computeImpact } from './api';
import type { ImpactCategory, ImpactResult, RuleInput, WinnerRef } from './types';

const CATEGORY_LABEL: Record<ImpactCategory, string> = {
  migrated: '命中迁移',
  added: '新增命中',
  removed: '变为未命中',
  unchanged: '无变化',
};

const CATEGORY_ORDER: ImpactCategory[] = ['migrated', 'added', 'removed', 'unchanged'];

const MAX_RENDERED = 200; // 明细最多直接渲染的条数，超出提示截断

interface ImpactViewProps {
  baselineText: string;
  onBaselineTextChange: (v: string) => void;
  candidateText: string;
  onCandidateTextChange: (v: string) => void;
  samplesText: string;
  onSamplesTextChange: (v: string) => void;
  baselineInputs: RuleInput[];
  candidateInputs: RuleInput[];
}

function WinnerView({ winner }: { winner: WinnerRef | null }) {
  if (!winner) return <span className="muted">未命中</span>;
  return (
    <>
      <span className="badge">{winner.id}</span>
      <span className="mono"> {winner.pattern}</span>
      <span className="muted">（优先级 {winner.priority}）</span>
    </>
  );
}

export default function ImpactView(props: ImpactViewProps) {
  const {
    baselineText,
    onBaselineTextChange,
    candidateText,
    onCandidateTextChange,
    samplesText,
    onSamplesTextChange,
    baselineInputs,
    candidateInputs,
  } = props;

  const [result, setResult] = useState<ImpactResult | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ImpactCategory | 'all'>('all');

  // 规则或样本变化后防抖重算；序号守卫丢弃过期响应
  const seq = useRef(0);
  useEffect(() => {
    const s = ++seq.current;
    const timer = setTimeout(() => {
      computeImpact(baselineInputs, candidateInputs, samplesText.split('\n'))
        .then((r) => {
          if (s !== seq.current) return;
          setResult(r);
          setImpactError(null);
        })
        .catch((err: Error) => {
          if (s !== seq.current) return;
          setImpactError(err.message);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [baselineInputs, candidateInputs, samplesText]);

  const filtered = useMemo(
    () => (result ? result.samples.filter((s) => filter === 'all' || s.category === filter) : []),
    [result, filter],
  );

  const exportJson = () => {
    if (!result) return;
    const mapRules = (rules: ImpactResult['baselineRules']) =>
      rules.map((r) => ({
        id: r.id,
        pattern: r.pattern,
        priority: r.priority,
        enabled: r.enabled,
        ...(r.error ? { error: r.error } : {}),
      }));
    const payload = {
      tool: 'api-gateway-route-ambiguity-analyzer',
      mode: 'change-impact',
      exportedAt: new Date().toISOString(),
      baselineRules: mapRules(result.baselineRules),
      candidateRules: mapRules(result.candidateRules),
      samples: result.samples.map((s) => ({
        line: s.line,
        count: s.count,
        path: s.path,
        category: s.category,
        categoryLabel: CATEGORY_LABEL[s.category],
        baselineWinner: s.baseline,
        candidateWinner: s.candidate,
      })),
      invalidSamples: result.invalidSamples,
      summary: result.summary,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `route-impact-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const summary = result?.summary;
  const affectedRequests = summary
    ? summary.migrated.requests + summary.added.requests + summary.removed.requests
    : 0;

  return (
    <main className="layout">
      <section className="panel">
        <h2>基线规则（当前规则）</h2>
        <textarea
          className="rule-input"
          value={baselineText}
          onChange={(e) => onBaselineTextChange(e.target.value)}
          spellCheck={false}
          rows={7}
          placeholder={'每行一条：<优先级> <路由模式>'}
        />
        <h2>候选规则</h2>
        <textarea
          className="rule-input"
          value={candidateText}
          onChange={(e) => onCandidateTextChange(e.target.value)}
          spellCheck={false}
          rows={7}
          placeholder={'每行一条：<优先级> <路由模式>'}
        />
        <h2>请求样本</h2>
        <textarea
          className="rule-input"
          value={samplesText}
          onChange={(e) => onSamplesTextChange(e.target.value)}
          spellCheck={false}
          rows={7}
          placeholder={'每行一条：[次数] 路径，次数省略时为 1\n例如：10 /api/users/42'}
        />
        <div className="status-line">
          {impactError ? (
            <span className="error-text">计算失败：{impactError}</span>
          ) : summary ? (
            <span>
              受影响请求 <strong>{affectedRequests}</strong> 次 / 共 {summary.total.requests} 次
              {result && result.invalidSamples.length > 0 && (
                <span className="warn-text">
                  {' '}
                  · {result.invalidSamples.length} 行非法样本已跳过
                </span>
              )}
            </span>
          ) : (
            <span>计算中…</span>
          )}
          <button className="btn" onClick={exportJson} disabled={!result}>
            导出影响明细 JSON
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>影响汇总</h2>
        {summary && (
          <div className="summary-cards">
            {CATEGORY_ORDER.map((cat) => (
              <div className="summary-card" key={cat}>
                <div className={`cat-label cat-${cat}`}>{CATEGORY_LABEL[cat]}</div>
                <div className="summary-num">{summary[cat].requests}</div>
                <div className="muted">{summary[cat].samples} 条样本</div>
              </div>
            ))}
          </div>
        )}

        <div className="filter-row">
          <button
            className={filter === 'all' ? 'chip chip-active' : 'chip'}
            onClick={() => setFilter('all')}
          >
            全部（{summary?.total.samples ?? 0}）
          </button>
          {CATEGORY_ORDER.map((cat) => (
            <button
              key={cat}
              className={filter === cat ? `chip chip-active chip-${cat}` : 'chip'}
              onClick={() => setFilter(cat)}
            >
              {CATEGORY_LABEL[cat]}（{summary?.[cat].samples ?? 0}）
            </button>
          ))}
        </div>

        <div className="conflict-list">
          {filtered.slice(0, MAX_RENDERED).map((s) => (
            <div className="conflict-card" key={s.line}>
              <div className="conflict-head">
                <code className="witness">{s.path}</code>
                <span className="muted">× {s.count}</span>
                <span className={`badge cat-${s.category}`}>{CATEGORY_LABEL[s.category]}</span>
              </div>
              <div className="conflict-body">
                <div>
                  基线：<WinnerView winner={s.baseline} />
                </div>
                <div>
                  候选：<WinnerView winner={s.candidate} />
                </div>
              </div>
            </div>
          ))}
          {result && filtered.length === 0 && (
            <p className="muted">该分类下没有样本。</p>
          )}
          {filtered.length > MAX_RENDERED && (
            <p className="muted">仅显示前 {MAX_RENDERED} 条，共 {filtered.length} 条；完整明细请导出 JSON。</p>
          )}
        </div>

        {result && result.invalidSamples.length > 0 && (
          <>
            <h2>非法样本（{result.invalidSamples.length}）</h2>
            <div className="invalid-list">
              {result.invalidSamples.map((v) => (
                <div className="error-text" key={v.line}>
                  第 {v.line} 行：<code>{v.raw}</code> — {v.error}
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
