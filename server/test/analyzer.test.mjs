// 针对编译产物 dist/analyzer.js 的断言测试：node test/analyzer.test.mjs
import assert from 'node:assert/strict';
import {
  parsePattern,
  matchSegments,
  intersectionWitness,
  analyze,
  simulate,
  splitPath,
  parseSampleLine,
  impact,
} from '../dist/analyzer.js';

const P = (s) => parsePattern(s);

// ---------- 模式解析 ----------
assert.deepEqual(P('/'), []);
assert.deepEqual(P('/users/:id'), [
  { kind: 'static', value: 'users' },
  { kind: 'param', name: 'id' },
]);
assert.deepEqual(P('/a/*'), [
  { kind: 'static', value: 'a' },
  { kind: 'star' },
]);
assert.throws(() => P('/a/b*c'), /\* 必须单独成段/);
assert.throws(() => P('/a/:'), /缺少名称/);

// ---------- 单规则匹配 ----------
assert.equal(matchSegments(P('/users/:id'), splitPath('/users/42')), true);
assert.equal(matchSegments(P('/users/:id'), splitPath('/users')), false);
assert.equal(matchSegments(P('/users/:id'), splitPath('/users/42/posts')), false);
assert.equal(matchSegments(P('/a/*'), splitPath('/a')), true); // * 匹配零段
assert.equal(matchSegments(P('/a/*'), splitPath('/a/b/c/d')), true);
assert.equal(matchSegments(P('/*'), splitPath('/')), true);
assert.equal(matchSegments(P('/a/*/c'), splitPath('/a/c')), true);
assert.equal(matchSegments(P('/a/*/c'), splitPath('/a/x/y/c')), true);
assert.equal(matchSegments(P('/a/*/c'), splitPath('/a/x/y/d')), false);

// ---------- 求交见证 ----------
const W = (a, b) => {
  const w = intersectionWitness(P(a), P(b));
  return w === null ? null : '/' + w.join('/');
};
assert.equal(W('/users/new', '/users/:id'), '/users/new');
assert.equal(W('/users/:id', '/users/:name'), '/users/x');
assert.equal(W('/a/*', '/*'), '/a'); // 最短：星号都取零段
assert.equal(W('/*', '/a/b'), '/a/b');
assert.equal(W('/:x/b', '/a/:y'), '/a/b');
assert.equal(W('/:x/:y', '/a/*'), '/a/x');
assert.equal(W('/a', '/b'), null); // 无交集
assert.equal(W('/a/:x', '/a/b/c'), null); // 段数对不上且无星号
assert.equal(W('/a/*/d', '/a/b/*'), '/a/b/d'); // 双星号求交
assert.equal(W('/', '/*'), '/'); // 根路径与通配

// 见证必须真的同时命中两条规则
for (const [a, b] of [
  ['/api/:version/users', '/api/v1/*'],
  ['/*/health', '/internal/*'],
  ['/:a/:b/:c', '/x/*/:z'],
]) {
  const w = intersectionWitness(P(a), P(b));
  assert.ok(w !== null, `${a} 与 ${b} 应有交集`);
  assert.ok(matchSegments(P(a), w) && matchSegments(P(b), w), `见证须同时命中 ${a}、${b}`);
}

// ---------- 整体分析：优先级与禁用 ----------
const rules = [
  { pattern: '/api/users/new', priority: 5, enabled: true },
  { pattern: '/api/users/:id', priority: 10, enabled: true },
  { pattern: '/api/*', priority: 1, enabled: true },
  { pattern: '/health', priority: 0, enabled: true },
];
const result = analyze(rules);
assert.equal(result.rules.length, 4);
assert.deepEqual(result.rules.map((r) => r.id), ['R1', 'R2', 'R3', 'R4']);
// R1∩R2 见证 /api/users/new，R2 优先级 10 > 5，胜出 R2
const c12 = result.conflicts.find((c) => c.a === 'R1' && c.b === 'R2');
assert.equal(c12.witness, '/api/users/new');
assert.equal(c12.winner, 'R2');
assert.equal(c12.winnerInPair, true);
// R1∩R3 见证 /api/users/new 也被 R2 命中，R2 优先级最高故胜出；R2∩R3 的胜出者是 R2
assert.equal(result.conflicts.find((c) => c.a === 'R1' && c.b === 'R3').winner, 'R2');
assert.equal(result.conflicts.find((c) => c.a === 'R2' && c.b === 'R3').winner, 'R2');
assert.equal(result.conflicts.length, 3);

// 禁用 R2 后重算：/api/users/new 的胜出者变为 R1
const disabled = analyze(rules.map((r, i) => (i === 1 ? { ...r, enabled: false } : r)));
assert.ok(!disabled.conflicts.some((c) => c.a === 'R2' || c.b === 'R2'));
assert.equal(disabled.conflicts.find((c) => c.a === 'R1' && c.b === 'R3').winner, 'R1');

// 平手按输入顺序：先出现者胜
const tie = analyze([
  { pattern: '/a/:x', priority: 3, enabled: true },
  { pattern: '/a/:y', priority: 3, enabled: true },
]);
assert.equal(tie.conflicts[0].winner, 'R1');

// 见证路径的胜出者可能是冲突对之外的第三方高优先级规则
const third = analyze([
  { pattern: '/:x/b', priority: 1, enabled: true },
  { pattern: '/a/:y', priority: 1, enabled: true },
  { pattern: '/a/b', priority: 10, enabled: true },
]);
const c12t = third.conflicts.find((c) => c.a === 'R1' && c.b === 'R2');
assert.equal(c12t.witness, '/a/b');
assert.equal(c12t.winner, 'R3'); // 第三方精确规则以更高优先级截胡
assert.equal(c12t.winnerInPair, false);

// ---------- 路径模拟 ----------
const sim = simulate(rules, '/api/users/new');
assert.equal(sim.winner, 'R2');
assert.deepEqual(sim.matches, ['R2', 'R1', 'R3']);
assert.equal(simulate(rules, '/nope').winner, null);
assert.equal(simulate(rules, '/health').winner, 'R4');

// ---------- 样本行解析 ----------
assert.deepEqual(parseSampleLine('10 /api/users/1'), { count: 10, path: '/api/users/1' });
assert.deepEqual(parseSampleLine('/api/users/1'), { count: 1, path: '/api/users/1' }); // 次数省略为 1
assert.equal(parseSampleLine(''), null); // 空行跳过
assert.equal(parseSampleLine('   '), null);
assert.equal(parseSampleLine('# 注释'), null); // 注释跳过
assert.ok('error' in parseSampleLine('10')); // 缺少路径
assert.ok('error' in parseSampleLine('0 /a')); // 次数必须为正整数
assert.ok('error' in parseSampleLine('-3 /a'));
assert.ok('error' in parseSampleLine('abc')); // 路径必须以 / 开头
assert.ok('error' in parseSampleLine('/a /b')); // 路径含空白
assert.ok('error' in parseSampleLine('2 /a /b'));

// ---------- 变更影响分析 ----------
const baselineRules = [
  { pattern: '/api/users/:id', priority: 100, enabled: true },
  { pattern: '/api/users/new', priority: 10, enabled: true },
  { pattern: '/api/*', priority: 1, enabled: true },
  { pattern: '/health', priority: 0, enabled: true },
];
// 候选：/api/users/new 优先级提到 200；删除 /health；新增 /internal/*
const candidateRules = [
  { pattern: '/api/users/:id', priority: 100, enabled: true },
  { pattern: '/api/users/new', priority: 200, enabled: true },
  { pattern: '/api/*', priority: 1, enabled: true },
  { pattern: '/internal/*', priority: 2, enabled: true },
];
const imp = impact(
  baselineRules,
  candidateRules,
  [
    '5 /api/users/new', // 命中迁移：:id(100) → new(200)
    '3 /api/users/42', // 无变化：同为 /api/users/:id(100)
    '2 /health', // 变为未命中
    '7 /internal/ops', // 新增命中
    '/nope', // 两边都未命中 → 无变化
    'not-a-path', // 非法
    '4', // 非法：缺少路径
  ],
);
assert.equal(imp.samples.length, 5);
assert.equal(imp.invalidSamples.length, 2);
assert.deepEqual(
  imp.invalidSamples.map((v) => v.line),
  [6, 7],
); // 逐行提示，行号从 1 起
const byPath = Object.fromEntries(imp.samples.map((s) => [s.path, s]));
assert.equal(byPath['/api/users/new'].category, 'migrated');
assert.deepEqual(byPath['/api/users/new'].baseline, {
  id: 'R1',
  pattern: '/api/users/:id',
  priority: 100,
});
assert.deepEqual(byPath['/api/users/new'].candidate, {
  id: 'R2',
  pattern: '/api/users/new',
  priority: 200,
});
assert.equal(byPath['/api/users/42'].category, 'unchanged');
assert.equal(byPath['/health'].category, 'removed');
assert.equal(byPath['/health'].candidate, null);
assert.equal(byPath['/internal/ops'].category, 'added');
assert.equal(byPath['/internal/ops'].baseline, null);
assert.equal(byPath['/nope'].category, 'unchanged');
// 汇总：非法样本不参与统计
assert.deepEqual(imp.summary.migrated, { samples: 1, requests: 5 });
assert.deepEqual(imp.summary.removed, { samples: 1, requests: 2 });
assert.deepEqual(imp.summary.added, { samples: 1, requests: 7 });
assert.deepEqual(imp.summary.unchanged, { samples: 2, requests: 4 });
assert.deepEqual(imp.summary.total, { samples: 5, requests: 18 });

// 同一规则判定：规范化模式与优先级均相同 → 无变化（即使书写形式不同）
const written = impact(
  [{ pattern: '/api//users/', priority: 5, enabled: true }],
  [{ pattern: '/api/users', priority: 5, enabled: true }],
  ['/api/users'],
);
assert.equal(written.samples[0].category, 'unchanged');
// 模式相同但优先级不同 → 命中迁移
const prioChanged = impact(
  [{ pattern: '/api/users', priority: 5, enabled: true }],
  [{ pattern: '/api/users', priority: 6, enabled: true }],
  ['/api/users'],
);
assert.equal(prioChanged.samples[0].category, 'migrated');
// 禁用与非法规则不参与胜出
const withDisabled = impact(
  [
    { pattern: '/a', priority: 10, enabled: false },
    { pattern: '/a', priority: 1, enabled: true },
  ],
  [{ pattern: '/a', priority: 1, enabled: true }],
  ['/a'],
);
assert.equal(withDisabled.samples[0].category, 'unchanged');
assert.equal(withDisabled.samples[0].baseline.priority, 1);

console.log('✔ analyzer 全部测试通过');
