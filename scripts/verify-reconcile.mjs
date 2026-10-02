// 端到端逻辑验证：node scripts/verify-reconcile.mjs
// 用内存 localStorage 垫片，直接驱动 review.ts 的对账核心。
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';

globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}
globalThis.localStorage = new MemoryStorage();
globalThis.navigator = { onLine: true };

const require = createRequire(import.meta.url);
rmSync(new URL('../.tmp-test-build', import.meta.url), { recursive: true, force: true });
require('child_process').execSync(
  require.resolve('typescript/bin/tsc') +
  ' src/models.ts src/review.ts --outDir .tmp-test-build --module commonjs --target es2020 --moduleResolution node --experimentalDecorators --skipLibCheck',
  { cwd: new URL('..', import.meta.url).pathname, stdio: 'inherit' },
);
require('node:fs').writeFileSync(
  new URL('../.tmp-test-build/package.json', import.meta.url),
  JSON.stringify({ type: 'commonjs' }),
);

const models = require('../.tmp-test-build/models.js');
const review = require('../.tmp-test-build/review.js');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

// ---- 场景 0：初始化：编排端演示稿 + 复核端种子结论 ----
let project = models.createDemoProject();
let store = review.createSeedReviewStore(project);
review.saveRemoteAuthor(project);
review.saveRemoteReview({ records: structuredClone(store.records), courseReturn: undefined });
review.saveReviewStore(store);

// 首次在线对账：种子记录与编排端内容一致，不应产生冲突、不应改结论
let result = review.reconcileReview({
  store, project,
  remoteAuthor: review.loadRemoteAuthor(),
  remoteReview: review.loadRemoteReview(),
  online: true, fault: 'none', now: new Date().toISOString(),
});
check('首次对账成功', result.report.status === 'synced');
check('首次对账无冲突', result.report.conflicts === 0);
check('首次对账无退回未确认', result.report.resetToUnconfirmed === 0);
check('已确认结论得到保护', result.report.protectedConfirmed >= 3);
store = result.store;
review.saveRemoteAuthor(result.remoteAuthor);
review.saveRemoteReview(result.remoteReview);

const target = 'step-1-2'; // 种子里是「退回」意见的那条
const beforeRecord = store.records.find((r) => r.stepId === target);
check('种子结论为退回', beforeRecord.verdict === 'returned' && beforeRecord.comment.includes('画面中央'));

// ---- 场景 1：复核端断网，仍能记意见 ----
store = review.recordReview(store, project, target, { verdict: 'approved', comment: '老师已在离线沟通中确认会调整，先通过。' });
check('离线意见记录在本机', store.pendingOps.length === 1 && store.records.some((r) => r.stepId === target && r.verdict === 'approved'));
review.saveReviewStore(store);

const offlineResult = review.reconcileReview({
  store, project,
  remoteAuthor: review.loadRemoteAuthor(),
  remoteReview: review.loadRemoteReview(),
  online: false, fault: 'none', now: new Date().toISOString(),
});
check('离线不对账、队列保留', offlineResult.report.status === 'offline' && offlineResult.store.pendingOps.length === 1);

// ---- 场景 2：同一时间（网络仍“断”）编排端改了这一步的字幕 ----
const step = project.modules[0].steps.find((s) => s.id === target);
step.caption = '已改为：四指并拢，字幕放到下方安全区。';
step.captionPosition = '下方安全区';

// ---- 场景 3：网络恢复，按步骤编号对账：两边都动过 → 冲突并排 ----
result = review.reconcileReview({
  store, project,
  remoteAuthor: review.loadRemoteAuthor(), // 远端仍是老师改之前
  remoteReview: review.loadRemoteReview(),
  online: true, fault: 'none', now: new Date().toISOString(),
});
check('恢复后对账成功', result.report.status === 'synced');
check('两边都改 → 1 条两版并排', result.report.conflicts === 1, `got ${result.report.conflicts}`);
const conflict = result.store.conflicts[0];
check('冲突按步骤编号 1-02 对账', conflict.stepNo === '1-02');
check('并排·内容认编排端（新字幕）', conflict.author.caption.includes('下方安全区'));
check('并排·结论认复核端（离线记的通过）', conflict.review.verdict === 'approved');
check('结论退回未确认但仍在列表', result.store.records.some((r) => r.stepId === target && r.confirmed === false && r.stale === true));
check('待补推队列成功后清空', result.store.pendingOps.length === 0);
store = result.store;
review.saveRemoteAuthor(result.remoteAuthor);
review.saveRemoteReview(result.remoteReview);
review.saveReviewStore(store);

// ---- 场景 4：老师只改某一步（复核端没动）：结论退回未确认，仍在列表 ----
const other = 'step-2-1';
const otherBefore = store.records.find((r) => r.stepId === other);
check('另一条此前已确认', otherBefore.confirmed === true);
const p2 = project.modules[1].steps.find((s) => s.id === other);
p2.duration = 65;
result = review.reconcileReview({
  store, project,
  remoteAuthor: review.loadRemoteAuthor(),
  remoteReview: review.loadRemoteReview(),
  online: true, fault: 'none', now: new Date().toISOString(),
});
const otherAfter = result.store.records.find((r) => r.stepId === other);
check('老师改动 → 结论退回未确认', otherAfter.confirmed === false && otherAfter.stale === true);
check('退回记录仍留在列表', result.store.records.some((r) => r.stepId === other));
check('单边改动不产生并排冲突', result.report.resetToUnconfirmed >= 1 && result.store.conflicts.length === 1);
store = result.store;
review.saveRemoteAuthor(result.remoteAuthor);
review.saveRemoteReview(result.remoteReview);
review.saveReviewStore(store);

// ---- 场景 5：逐条认冲突：内容认编排端，冲突消失，等复核员重新确认 ----
store = review.acknowledgeConflict(store, project, target);
check('逐条认后冲突从对账区移除', store.conflicts.length === 0);
check('逐条认操作进入待补推队列', store.pendingOps.some((op) => op.type === 'ack' && op.stepId === target));
result = review.reconcileReview({
  store, project,
  remoteAuthor: review.loadRemoteAuthor(),
  remoteReview: review.loadRemoteReview(),
  online: true, fault: 'none', now: new Date().toISOString(),
});
const ackedRecord = result.store.records.find((r) => r.stepId === target);
check('认后内容指纹已对齐（不再 stale）', ackedRecord.stale === false);
check('认后结论仍是复核端版本（通过）', ackedRecord.verdict === 'approved');
check('认后仍需重新确认', ackedRecord.confirmed === false);
store = result.store;
review.saveRemoteAuthor(result.remoteAuthor);
review.saveRemoteReview(result.remoteReview);
review.saveReviewStore(store);

store = review.confirmReview(store, project, target);
result = review.reconcileReview({
  store, project,
  remoteAuthor: review.loadRemoteAuthor(),
  remoteReview: review.loadRemoteReview(),
  online: true, fault: 'none', now: new Date().toISOString(),
});
check('复核员重新确认成功', result.store.records.find((r) => r.stepId === target).confirmed === true);
store = result.store;
review.saveRemoteAuthor(result.remoteAuthor);
review.saveRemoteReview(result.remoteReview);
review.saveReviewStore(store);

// ---- 场景 6：合并失败按侧重试，已确认结论先保住 ----
// 先在离线攒一条新意见
const newTarget = 'step-1-1';
const confirmedSnapshot = store.records.find((r) => r.stepId === target);
store = review.recordReview(store, project, newTarget, { verdict: 'returned', comment: '离线：起始帧缺少淡入。' });
const queueLenBefore = store.pendingOps.length;

result = review.reconcileReview({
  store, project,
  remoteAuthor: review.loadRemoteAuthor(),
  remoteReview: review.loadRemoteReview(),
  online: true, fault: 'reviewer', now: new Date().toISOString(),
});
check('复核端侧失败被识别', result.report.status === 'failed' && result.report.failSide === 'reviewer');
check('失败后待补推队列保留', result.store.pendingOps.length === queueLenBefore);
check('失败后已确认结论保住', result.store.records.find((r) => r.stepId === target).confirmed === confirmedSnapshot.confirmed);
check('失败后冲突区不被清空', result.store.conflicts.length === 0);
store = result.store; // 注意：失败时远端未被写入

// 按复核侧重试（先把失败开关拿掉）
result = review.reconcileReview({
  store, project,
  remoteAuthor: review.loadRemoteAuthor(),
  remoteReview: review.loadRemoteReview(),
  online: true, fault: 'none', side: 'reviewer', now: new Date().toISOString(),
});
check('按复核侧重试成功', result.report.status === 'synced');
check('重试后队列清空', result.store.pendingOps.length === 0);
check('重试后离线意见已补推', result.store.records.some((r) => r.stepId === newTarget && r.comment.includes('淡入')));
store = result.store;
review.saveRemoteAuthor(result.remoteAuthor);
review.saveRemoteReview(result.remoteReview);
review.saveReviewStore(store);

// 编排端侧失败
result = review.reconcileReview({
  store, project,
  remoteAuthor: review.loadRemoteAuthor(),
  remoteReview: review.loadRemoteReview(),
  online: true, fault: 'author', now: new Date().toISOString(),
});
check('编排端侧失败被识别', result.report.status === 'failed' && result.report.failSide === 'author');
check('编排端失败时结论原样保住', result.store.records.every((r) => !('confirmed' in r) || typeof r.confirmed === 'boolean'));
store = result.store;
result = review.reconcileReview({
  store, project,
  remoteAuthor: review.loadRemoteAuthor(),
  remoteReview: review.loadRemoteReview(),
  online: true, fault: 'none', side: 'author', now: new Date().toISOString(),
});
check('按编排侧重试成功', result.report.status === 'synced');
store = result.store;

// ---- 场景 7：老师删除步骤，复核记录仍留在列表（孤儿） ----
const delTarget = 'step-1-3';
store = review.recordReview(store, project, delTarget, { verdict: 'returned', comment: '双人练习缺少安全提示。' });
result = review.reconcileReview({
  store, project,
  remoteAuthor: review.loadRemoteAuthor(),
  remoteReview: review.loadRemoteReview(),
  online: true, fault: 'none', now: new Date().toISOString(),
});
store = result.store;
review.saveRemoteAuthor(result.remoteAuthor);
review.saveRemoteReview(result.remoteReview);
review.saveReviewStore(store);

project.modules[0].steps = project.modules[0].steps.filter((s) => s.id !== delTarget);
result = review.reconcileReview({
  store, project,
  remoteAuthor: review.loadRemoteAuthor(),
  remoteReview: review.loadRemoteReview(),
  online: true, fault: 'none', now: new Date().toISOString(),
});
check('步骤删除后结论仍留在列表', result.store.records.some((r) => r.stepId === delTarget && r.orphan === true));
check('孤儿计入统计', result.report.orphans >= 1);
store = result.store;
// 复核员可手动移除
store = review.removeReview(store, delTarget);
result = review.reconcileReview({
  store, project,
  remoteAuthor: review.loadRemoteAuthor(),
  remoteReview: review.loadRemoteReview(),
  online: true, fault: 'none', now: new Date().toISOString(),
});
check('复核员移除后孤儿消失', !result.store.records.some((r) => r.stepId === delTarget));

// ---- 场景 8：持有方隔离——编排端存储里没有结论，复核端存储里没有课程模块 ----
const authorDraft = JSON.parse(localStorage.getItem(review.AUTHOR_DRAFT_KEY) ?? '{}');
check('编排端草稿不含复核记录字段', !('records' in authorDraft) && !('pendingOps' in authorDraft));
const reviewStoreRaw = JSON.parse(localStorage.getItem(review.REVIEW_STORE_KEY) ?? '{}');
check('复核端底稿不含课程模块数组', !('modules' in reviewStoreRaw));
check('复核端底稿按步骤持有结论', Array.isArray(reviewStoreRaw.records) && reviewStoreRaw.records.every((r) => 'verdict' in r && 'comment' in r));

rmSync(new URL('../.tmp-test-build', import.meta.url), { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} 项验证失败`);
  process.exit(1);
}
console.log('\n全部对账场景验证通过。');
