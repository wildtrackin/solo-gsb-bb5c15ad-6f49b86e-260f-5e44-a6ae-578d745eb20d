import type { AnalysisResult, ImpactResult, MatchResult, ReproResult, RuleInput } from './types';

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`请求失败 ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export function analyzeRules(rules: RuleInput[]): Promise<AnalysisResult> {
  return post<AnalysisResult>('/api/analyze', { rules });
}

export function matchPath(rules: RuleInput[], path: string): Promise<MatchResult> {
  return post<MatchResult>('/api/match', { rules, path });
}

export function computeImpact(
  baseline: RuleInput[],
  candidate: RuleInput[],
  samples: string[],
): Promise<ImpactResult> {
  return post<ImpactResult>('/api/impact', { baseline, candidate, samples });
}

export function computeRepro(rules: RuleInput[], ruleIds: string[]): Promise<ReproResult> {
  return post<ReproResult>('/api/repro', { rules, ruleIds });
}
