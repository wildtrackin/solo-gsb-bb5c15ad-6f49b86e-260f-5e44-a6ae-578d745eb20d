import { useEffect, useMemo, useRef, useState } from 'react';
import { computeRepro } from './api';
import type { AnalysisResult, ReproPackage, RuleInput } from './types';

const MIN_SELECT = 2;
const MAX_SELECT = 20;

interface ReproViewProps {
  analysis: AnalysisResult;
  ruleInputs: RuleInput[];
}

/** 把冲突对下标格式化为 “R3×R7” 形式。 */
function conflictLabel(pkg: ReproPackage, index: number): string {
  const c = pkg.conflicts[index];
  return c ? `${c.a}×${c.b}` : `#${index}`;
}

export default function ReproView({ analysis, ruleInputs }: ReproViewProps) {
  const usable = useMemo(
    () => analysis.rules.filter((r) => r.enabled && !r.error),
    [analysis],
  );
  const usableIds = useMemo(() => new Set(usable.map((r) => r.id)), [usable]);

  const [selected, setSelected] = useState<Set<string>>(() => {
    // 默认勾选前 20 条启用且合法的规则
    return new Set(usable.slice(0, MAX_SELECT).map((r) => r.id));
  });
  const [touched, setTouched] = useState(false);
  const [pkg, setPkg] = useState<ReproPackage | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 规则变化后：丢弃已失效（禁用/非法/消失）的勾选；用户未操作过时自动补足默认选择
  const usableKey = useMemo(() => usable.map((r) => r.id).join(','), [usable]);
  useEffect(() => {
    setSelected((prev) => {
      const alive = new Set([...prev].filter((id) => usableIds.has(id)));
      if (!touched) {
        for (const r of usable) {
          if (alive.size >= MAX_SELECT) break;
          alive.add(r.id);
        }
      }
      return alive;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usableKey, usableIds, touched]);

  const orderedSelected = useMemo(
    () => [...selected].filter((id) => usableIds.has(id)),
    [selected, usableIds],
  );
  const validCount = orderedSelected.length;
  const canCompute = validCount >= MIN_SELECT && validCount <= MAX_SELECT;

  // 勾选变化后防抖重算；序号守卫丢弃过期响应
  const seq = useRef(0);
  useEffect(() => {
    if (!canCompute) {
      setPkg(null);
      setError(null);
      return;
    }
    const s = ++seq.current;
    const timer = setTimeout(() => {
      computeRepro(ruleInputs, orderedSelected)
        .then((result) => {
          if (s !== seq.current) return;
          setPkg(result);
          setError(null);
        })
        .catch((err: Error) => {
          if (s !== seq.current) return;
          setPkg(null);
          setError(err.message.replace(/^请求失败 \d+: /, ''));
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [ruleInputs, orderedSelected, canCompute]);

  const toggle = (id: string) => {
    setTouched(true);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        if (next.size >= MAX_SELECT) return prev; // 至多 20 条
        next.add(id);
      }
      return next;
    });
  };

  const selectAll = () => {
    setTouched(true);
    setSelected(new Set(usable.slice(0, MAX_SELECT).map((r) => r.id)));
  };

  const clearAll = () => {
    setTouched(true);
    setSelected(new Set());
  };

  const downloadJson = () => {
    if (!pkg) return;
    const ruleMap = new Map(analysis.rules.map((r) => [r.id, r]));
    const payload = {
      tool: 'api-gateway-route-ambiguity-analyzer',
      mode: 'minimum-reproduction-package',
      exportedAt: new Date().toISOString(),
      selectedRules: pkg.selectedRuleIds
        .map((id) => ruleMap.get(id))
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .map((r) => ({ id: r.id, pattern: r.pattern, priority: r.priority })),
      summary: {
        conflictPairs: pkg.conflictPairCount,
        candidatePaths: pkg.candidateCount,
        chosenPaths: pkg.pathCount,
        totalSegments: pkg.totalSegments,
      },
      conflicts: pkg.conflicts.map((c) => ({
        index: c.index,
        ruleA: c.a,
        ruleB: c.b,
        witness: c.witness,
      })),
      requestPaths: pkg.paths.map((p) => ({
        path: p.path,
        segments: p.segments,
        matchedRules: p.matchedRules,
        coveredConflicts: p.coveredConflicts.map((i) => conflictLabel(pkg, i)),
      })),
      candidates: pkg.candidates.map((p) => ({
        path: p.path,
        segments: p.segments,
        matchedRules: p.matchedRules,
        coveredConflicts: p.coveredConflicts,
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

  return (
    <section className="panel repro-panel">
      <h2>最小复现包</h2>
      <p className="muted repro-intro">
        从启用且合法的规则中选择 {MIN_SELECT}～{MAX_SELECT} 条，后端以这些规则已有的去重冲突见证路径为候选，
        重新计算每条路径实际覆盖的冲突对，并用确定性分支限界选出覆盖全部冲突对的
        <strong> 最少路径集合</strong>（并列时依次按路径总段数、排序后的路径字典序决胜，非贪心近似）。
        发送这些具体路径即可稳定复现全部冲突。
      </p>

      <div className="repro-rule-list">
        {usable.map((r) => (
          <label
            key={r.id}
            className={`repro-rule${selected.has(r.id) ? ' repro-rule-on' : ''}`}
            title={r.pattern}
          >
            <input
              type="checkbox"
              checked={selected.has(r.id)}
              onChange={() => toggle(r.id)}
            />
            <span className="badge">{r.id}</span>
            <span className="mono repro-rule-pattern">{r.pattern}</span>
          </label>
        ))}
        {usable.length === 0 && <span className="muted">暂无启用且合法的规则。</span>}
      </div>

      <div className="status-line">
        <span>
          已选 <strong>{validCount}</strong> / {usable.length} 条
          {validCount > MAX_SELECT && <span className="error-text">（最多 {MAX_SELECT} 条）</span>}
          {validCount < MIN_SELECT && validCount > 0 && (
            <span className="muted">（至少选择 {MIN_SELECT} 条）</span>
          )}
          {pkg && (
            <span className="muted">
              {' '}
              · {pkg.conflictPairCount} 个冲突对 · {pkg.candidateCount} 条候选路径 ·
              入选 <strong>{pkg.pathCount}</strong> 条（共 {pkg.totalSegments} 段）
            </span>
          )}
        </span>
        <span className="repro-actions">
          <button className="btn btn-secondary" onClick={selectAll} disabled={usable.length === 0}>
            全选（前 {MAX_SELECT}）
          </button>
          <button className="btn btn-secondary" onClick={clearAll} disabled={validCount === 0}>
            清空
          </button>
          <button className="btn" onClick={downloadJson} disabled={!pkg}>
            下载复现包 JSON
          </button>
        </span>
      </div>
      {error && <div className="error-text repro-error">计算失败：{error}</div>}

      {pkg && pkg.conflictPairCount === 0 && (
        <p className="muted">所选规则之间没有冲突，复现包不需要请求路径。</p>
      )}

      {pkg && pkg.paths.length > 0 && (
        <div className="conflict-list">
          {pkg.paths.map((p) => (
            <div className="conflict-card" key={p.path}>
              <div className="conflict-head">
                <code className="witness">{p.path}</code>
                <span className="muted">{p.segments} 段</span>
              </div>
              <div className="conflict-body">
                <div>
                  实际命中规则（按胜出顺序）：
                  {p.matchedRules.map((id) => (
                    <span className="badge badge-winner" key={id}>
                      {id}
                    </span>
                  ))}
                </div>
                <div>
                  覆盖冲突对（{p.coveredConflicts.length}）：
                  {p.coveredConflicts.map((i) => (
                    <span className="badge" key={i}>
                      {conflictLabel(pkg, i)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
