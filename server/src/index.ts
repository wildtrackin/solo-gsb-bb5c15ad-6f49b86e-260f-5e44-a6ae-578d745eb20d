import express, { Request, Response } from 'express';
import path from 'path';
import { analyze, simulate, impact, RuleInput } from './analyzer';

const app = express();
app.use(express.json({ limit: '1mb' }));

const MAX_RULES = 500;
const MAX_PATTERN_LEN = 500;
const MAX_SAMPLE_LINES = 5000;
const MAX_SAMPLE_LINE_LEN = 500;

/** 清洗客户端提交的单条规则，返回安全的 RuleInput。 */
function sanitizeRule(raw: unknown): RuleInput | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.pattern !== 'string') return null;
  const pattern = obj.pattern.slice(0, MAX_PATTERN_LEN);
  const priority =
    typeof obj.priority === 'number' && Number.isFinite(obj.priority) ? obj.priority : 0;
  const enabled = obj.enabled !== false;
  return { pattern, priority, enabled };
}

/** 清洗规则数组（至多 MAX_RULES 条）。 */
function sanitizeRuleList(raw: unknown): RuleInput[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_RULES) return null;
  const out: RuleInput[] = [];
  for (const item of raw) {
    const rule = sanitizeRule(item);
    if (!rule) return null;
    out.push(rule);
  }
  return out;
}

function sanitizeRules(body: unknown): RuleInput[] | null {
  if (body === null || typeof body !== 'object') return null;
  return sanitizeRuleList((body as Record<string, unknown>).rules);
}

app.post('/api/analyze', (req: Request, res: Response) => {
  const rules = sanitizeRules(req.body);
  if (!rules) {
    res.status(400).json({ error: `请求非法：需要 rules 数组（至多 ${MAX_RULES} 条）` });
    return;
  }
  res.json(analyze(rules));
});

app.post('/api/match', (req: Request, res: Response) => {
  const rules = sanitizeRules(req.body);
  const pathInput = (req.body as Record<string, unknown>)?.path;
  if (!rules || typeof pathInput !== 'string' || pathInput.length > 2000) {
    res.status(400).json({ error: '请求非法：需要 rules 数组和 path 字符串' });
    return;
  }
  res.json(simulate(rules, pathInput));
});

app.post('/api/impact', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown> | null;
  if (body === null || typeof body !== 'object') {
    res.status(400).json({ error: '请求非法：需要 JSON 对象' });
    return;
  }
  const baseline = sanitizeRuleList(body.baseline);
  const candidate = sanitizeRuleList(body.candidate);
  const samplesRaw = body.samples;
  if (
    !baseline ||
    !candidate ||
    !Array.isArray(samplesRaw) ||
    samplesRaw.length > MAX_SAMPLE_LINES ||
    !samplesRaw.every((s) => typeof s === 'string')
  ) {
    res.status(400).json({
      error: `请求非法：需要 baseline、candidate 规则数组（各至多 ${MAX_RULES} 条）和 samples 字符串数组（至多 ${MAX_SAMPLE_LINES} 行）`,
    });
    return;
  }
  const samples = (samplesRaw as string[]).map((s) => s.slice(0, MAX_SAMPLE_LINE_LEN));
  res.json(impact(baseline, candidate, samples));
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// 生产模式下由 Express 直接托管前端构建产物
const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`route-ambiguity-analyzer listening on http://0.0.0.0:${port}`);
});
