// 与后端 analyzer.ts 对应的类型定义
export interface RuleInput {
  pattern: string;
  priority: number;
  enabled: boolean;
}

export type Segment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'star' };

export interface AnalyzedRule {
  id: string;
  index: number;
  pattern: string;
  priority: number;
  enabled: boolean;
  segments: Segment[];
  error: string | null;
}

export interface ConflictPair {
  a: string;
  b: string;
  witness: string;
  winner: string | null;
  winnerInPair: boolean;
}

export interface AnalysisResult {
  rules: AnalyzedRule[];
  conflicts: ConflictPair[];
}

export interface MatchResult {
  path: string;
  matches: string[];
  winner: string | null;
}

// ---------- 变更影响 ----------
export type ImpactCategory = 'migrated' | 'added' | 'removed' | 'unchanged';

export interface WinnerRef {
  id: string;
  pattern: string;
  priority: number;
}

export interface SampleImpact {
  line: number;
  count: number;
  path: string;
  baseline: WinnerRef | null;
  candidate: WinnerRef | null;
  category: ImpactCategory;
}

export interface InvalidSample {
  line: number;
  raw: string;
  error: string;
}

export interface CategorySummary {
  samples: number;
  requests: number;
}

export interface ImpactResult {
  baselineRules: AnalyzedRule[];
  candidateRules: AnalyzedRule[];
  samples: SampleImpact[];
  invalidSamples: InvalidSample[];
  summary: Record<ImpactCategory, CategorySummary> & { total: CategorySummary };
}

// ---------- 最小复现包 ----------
export interface ReproConflict {
  a: string;
  b: string;
}

export interface ReproPath {
  path: string;
  hits: string[];
  covers: ReproConflict[];
}

export interface ReproResult {
  rules: AnalyzedRule[];
  conflicts: ConflictPair[];
  candidatePaths: number;
  totalConflicts: number;
  paths: ReproPath[];
}
