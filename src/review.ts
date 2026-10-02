import {
  STORAGE_KEY,
  type CameraAngle,
  type CourseProject,
  type LessonStep,
} from './models';

/**
 * 复核端数据与对账合并逻辑。
 *
 * 持有方拆分：
 * - 编排端（教师）：CourseProject —— 课程模块、学习步骤、字幕等全部课程内容，
 *   只保存在编排端自己的草稿键里，复核端永远不写入。
 * - 复核端（复核员）：ReviewStore —— 每个学习步骤的复核结论、退回意见、
 *   离线待同步操作、两版冲突对账区，只保存在复核端自己的键里。
 *
 * 「远端」用两份独立的 localStorage 键模拟网络两端：
 * 编排端远端只收课程内容，复核端远端只收结论与意见，互不覆盖。
 */

export type ReviewVerdict = 'approved' | 'returned';
export type ReviewSyncStatus = 'idle' | 'synced' | 'failed';
export type FaultSide = 'none' | 'author' | 'reviewer';
export type Role = 'author' | 'reviewer';

/** 复核端对单个学习步骤持有的结论 */
export interface StepReview {
  stepId: string;
  /** 步骤编号（模块序号-步骤序号），对账与展示用 */
  stepNo: string;
  moduleId: string;
  moduleTitle: string;
  stepTitle: string;
  verdict: ReviewVerdict;
  /** 退回意见 */
  comment: string;
  /** 结论是否已经确认；编排端改动同一步骤后回到 false（退回未确认，但记录保留） */
  confirmed: boolean;
  reviewer: string;
  /** 编排端改过内容、结论待重新确认 */
  stale: boolean;
  /** 编排端已删除该步骤，记录仍留在复核列表中 */
  orphan?: boolean;
  /** 该结论所依据的编排端内容指纹 */
  contentVersion: string;
  reviewVersion: number;
  updatedAt: string;
}

/** 冲突对账区里保留的编排端版本（内容认编排端） */
export interface AuthorContentSnapshot {
  stepId: string;
  stepNo: string;
  title: string;
  kind: LessonStep['kind'];
  duration: number;
  difficulty: LessonStep['difficulty'];
  caption: string;
  captionPosition: LessonStep['captionPosition'];
  handshape: string;
  camera: CameraAngle;
  altText: string;
  prerequisiteId: string;
}

/** 冲突对账区里保留的复核端版本（结论认复核端） */
export interface ReviewSideSnapshot {
  verdict: ReviewVerdict;
  comment: string;
  reviewer: string;
  confirmed: boolean;
  updatedAt: string;
}

/** 同一步骤两边都动过时留下的两版并排记录，等人逐条认 */
export interface ReviewConflict {
  stepId: string;
  stepNo: string;
  author: AuthorContentSnapshot;
  review: ReviewSideSnapshot;
  detectedAt: string;
}

export interface CourseReturn {
  reason: string;
  at: string;
}

/** 复核端离线时本地先记下、联网后补推的操作 */
export type ReviewOp =
  | { type: 'upsert'; stepId: string; stepNo: string; moduleId: string; moduleTitle: string; stepTitle: string; verdict: ReviewVerdict; comment: string; contentVersion: string; at: string }
  | { type: 'confirm'; stepId: string; stepNo: string; moduleId: string; moduleTitle: string; stepTitle: string; contentVersion: string; at: string }
  | { type: 'ack'; stepId: string; contentVersion: string; at: string }
  | { type: 'remove'; stepId: string; at: string }
  | { type: 'course-return'; reason: string; at: string };

export interface SyncReport {
  status: 'synced' | 'failed' | 'offline';
  failSide?: 'author' | 'reviewer';
  message: string;
  pushedOps: number;
  conflicts: number;
  resetToUnconfirmed: number;
  orphans: number;
  protectedConfirmed: number;
  at: string;
}

export interface ReviewStore {
  reviewerName: string;
  records: StepReview[];
  pendingOps: ReviewOp[];
  conflicts: ReviewConflict[];
  courseReturn?: CourseReturn;
  syncStatus: ReviewSyncStatus;
  lastSyncAt?: string;
  lastError?: string;
  failSide?: 'author' | 'reviewer';
  lastReport?: SyncReport;
}

/** 模拟的复核端远端状态 */
export interface RemoteReviewState {
  records: StepReview[];
  courseReturn?: CourseReturn;
}

export interface ReconcileInput {
  store: ReviewStore;
  project: CourseProject;
  remoteAuthor: CourseProject | null;
  remoteReview: RemoteReviewState | null;
  online: boolean;
  fault: FaultSide;
  /** 失败后按侧重试：只重试指定侧 */
  side?: 'author' | 'reviewer';
  now: string;
}

export interface ReconcileResult {
  store: ReviewStore;
  remoteAuthor: CourseProject | null;
  remoteReview: RemoteReviewState | null;
  report: SyncReport;
}

export const AUTHOR_DRAFT_KEY = STORAGE_KEY;
export const REVIEW_STORE_KEY = 'sologsb-1012-review-store-v1';
export const AUTHOR_REMOTE_KEY = 'sologsb-1012-remote-author-v1';
export const REVIEW_REMOTE_KEY = 'sologsb-1012-remote-review-v1';
export const ROLE_KEY = 'sologsb-1012-workspace-role-v1';

/** 归编排端持有的步骤内容字段；指纹只覆盖这些字段 */
const CONTENT_KEYS: (keyof LessonStep)[] = [
  'title', 'kind', 'duration', 'demoTitle', 'demoUrl', 'handshape', 'gestureZone',
  'caption', 'captionPosition', 'camera', 'commonMistakes', 'exercise',
  'exerciseFeedback', 'altText', 'prerequisiteId', 'difficulty', 'cuePoints',
];

export interface StepLocation {
  moduleId: string;
  moduleTitle: string;
  moduleIndex: number;
  stepIndex: number;
  stepNo: string;
  step: LessonStep;
}

export function buildStepIndex(project: CourseProject): Map<string, StepLocation> {
  const index = new Map<string, StepLocation>();
  project.modules.forEach((module, moduleIndex) => {
    module.steps.forEach((step, stepIndex) => {
      index.set(step.id, {
        moduleId: module.id,
        moduleTitle: module.title,
        moduleIndex,
        stepIndex,
        stepNo: `${moduleIndex + 1}-${String(stepIndex + 1).padStart(2, '0')}`,
        step,
      });
    });
  });
  return index;
}

/** 步骤内容指纹：编排端持有字段的短哈希 */
export function fingerprintStep(step: LessonStep): string {
  const basis = CONTENT_KEYS.map((key) => JSON.stringify(step[key])).join('f');
  let hash = 5381;
  for (let i = 0; i < basis.length; i += 1) {
    hash = ((hash << 5) + hash + basis.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function verdictLabel(verdict: ReviewVerdict): string {
  return verdict === 'approved' ? '通过' : '退回';
}

// ---------- 本地 / 远端读写 ----------

function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export function loadReviewStore(project?: CourseProject): ReviewStore {
  const stored = readJSON<ReviewStore>(REVIEW_STORE_KEY);
  if (stored) return stored;
  return project ? createSeedReviewStore(project) : createEmptyReviewStore();
}

export function saveReviewStore(store: ReviewStore): void {
  writeJSON(REVIEW_STORE_KEY, store);
}

export function loadRemoteAuthor(): CourseProject | null {
  return readJSON<CourseProject>(AUTHOR_REMOTE_KEY);
}

export function saveRemoteAuthor(project: CourseProject): void {
  writeJSON(AUTHOR_REMOTE_KEY, project);
}

export function loadRemoteReview(): RemoteReviewState | null {
  return readJSON<RemoteReviewState>(REVIEW_REMOTE_KEY);
}

export function saveRemoteReview(state: RemoteReviewState): void {
  writeJSON(REVIEW_REMOTE_KEY, state);
}

export function loadRole(): Role {
  return localStorage.getItem(ROLE_KEY) === 'reviewer' ? 'reviewer' : 'author';
}

export function saveRole(role: Role): void {
  localStorage.setItem(ROLE_KEY, role);
}

export function createEmptyReviewStore(): ReviewStore {
  return {
    reviewerName: '林复核员',
    records: [],
    pendingOps: [],
    conflicts: [],
    syncStatus: 'idle',
  };
}

/** 首次打开时给出一份已经对过账的演示复核数据 */
export function createSeedReviewStore(project: CourseProject): ReviewStore {
  const index = buildStepIndex(project);
  const seed = (stepId: string, verdict: ReviewVerdict, comment: string, confirmed = true): StepReview | null => {
    const loc = index.get(stepId);
    if (!loc) return null;
    return {
      stepId,
      stepNo: loc.stepNo,
      moduleId: loc.moduleId,
      moduleTitle: loc.moduleTitle,
      stepTitle: loc.step.title,
      verdict,
      comment,
      confirmed,
      reviewer: '林复核员',
      stale: false,
      contentVersion: fingerprintStep(loc.step),
      reviewVersion: 1,
      updatedAt: new Date().toISOString(),
    };
  };
  const records = [
    seed('step-1-1', 'approved', '示范节奏与字幕位置合适，替代文本完整。'),
    seed('step-1-2', 'returned', '字幕位于画面中央，与俯拍手部镜头重叠，请挪到下方安全区后再提交。'),
    seed('step-2-1', 'approved', '数字手形拆解清楚，可以冻结。'),
  ].filter((item): item is StepReview => Boolean(item));
  return {
    reviewerName: '林复核员',
    records,
    pendingOps: [],
    conflicts: [],
    syncStatus: 'synced',
    lastSyncAt: new Date().toISOString(),
  };
}

// ---------- 复核端本地写操作（只动复核端这边） ----------

function enqueue(store: ReviewStore, op: ReviewOp): ReviewStore {
  return { ...store, pendingOps: [...store.pendingOps, op] };
}

/** 复核员保存某步骤的结论与退回意见（离线也先记在本机） */
export function recordReview(store: ReviewStore, project: CourseProject, stepId: string, patch: { verdict: ReviewVerdict; comment: string }): ReviewStore {
  const now = new Date().toISOString();
  const index = buildStepIndex(project);
  const loc = index.get(stepId);
  const existing = store.records.find((item) => item.stepId === stepId);
  const meta = loc
    ? { moduleId: loc.moduleId, moduleTitle: loc.moduleTitle, stepNo: loc.stepNo, stepTitle: loc.step.title }
    : { moduleId: existing?.moduleId ?? '', moduleTitle: existing?.moduleTitle ?? '已删除模块', stepNo: existing?.stepNo ?? '—', stepTitle: existing?.stepTitle ?? stepId };
  const contentVersion = loc ? fingerprintStep(loc.step) : existing?.contentVersion ?? '';
  const next: StepReview = {
    stepId,
    stepNo: meta.stepNo,
    moduleId: meta.moduleId,
    moduleTitle: meta.moduleTitle,
    stepTitle: meta.stepTitle,
    verdict: patch.verdict,
    comment: patch.comment,
    // 结论内容改过，需要重新确认
    confirmed: false,
    reviewer: store.reviewerName,
    stale: false,
    orphan: loc ? undefined : true,
    contentVersion,
    reviewVersion: (existing?.reviewVersion ?? 0) + 1,
    updatedAt: now,
  };
  const records = [...store.records.filter((item) => item.stepId !== stepId), next];
  return enqueue({ ...store, records }, {
    type: 'upsert',
    stepId,
    stepNo: meta.stepNo,
    moduleId: meta.moduleId,
    moduleTitle: meta.moduleTitle,
    stepTitle: meta.stepTitle,
    verdict: patch.verdict,
    comment: patch.comment,
    contentVersion,
    at: now,
  });
}

/** 复核员确认一条结论 */
export function confirmReview(store: ReviewStore, project: CourseProject, stepId: string): ReviewStore {
  const now = new Date().toISOString();
  const existing = store.records.find((item) => item.stepId === stepId);
  if (!existing) return store;
  const index = buildStepIndex(project);
  const loc = index.get(stepId);
  const contentVersion = loc ? fingerprintStep(loc.step) : existing.contentVersion;
  const records = store.records.map((item) => item.stepId === stepId
    ? { ...item, confirmed: true, stale: false, orphan: loc ? undefined : true, contentVersion, updatedAt: now }
    : item);
  return enqueue({ ...store, records }, {
    type: 'confirm',
    stepId,
    stepNo: loc?.stepNo ?? existing.stepNo,
    moduleId: loc?.moduleId ?? existing.moduleId,
    moduleTitle: loc?.moduleTitle ?? existing.moduleTitle,
    stepTitle: loc?.step.title ?? existing.stepTitle,
    contentVersion,
    at: now,
  });
}

/** 复核员移除自己列表里的一条记录（通常针对编排端已删除的孤儿记录） */
export function removeReview(store: ReviewStore, stepId: string): ReviewStore {
  const now = new Date().toISOString();
  const records = store.records.filter((item) => item.stepId !== stepId);
  const conflicts = store.conflicts.filter((item) => item.stepId !== stepId);
  return enqueue({ ...store, records, conflicts }, { type: 'remove', stepId, at: now });
}

/** 复核员对整门课程填写退回说明 */
export function setCourseReturn(store: ReviewStore, reason: string): ReviewStore {
  const now = new Date().toISOString();
  const trimmed = reason.trim();
  const next = enqueue({ ...store, courseReturn: trimmed ? { reason: trimmed, at: now } : undefined }, { type: 'course-return', reason: trimmed, at: now });
  return next;
}

/** 逐条认：两版并排的冲突按步骤认下编排端内容，结论仍保留复核端版本等待重新确认 */
export function acknowledgeConflict(store: ReviewStore, project: CourseProject, stepId: string): ReviewStore {
  const now = new Date().toISOString();
  const index = buildStepIndex(project);
  const loc = index.get(stepId);
  const conflict = store.conflicts.find((item) => item.stepId === stepId);
  if (!conflict || !loc) return store;
  const contentVersion = fingerprintStep(loc.step);
  const records = store.records.map((item) => item.stepId === stepId
    ? { ...item, stale: false, contentVersion, stepNo: loc.stepNo, moduleId: loc.moduleId, moduleTitle: loc.moduleTitle, stepTitle: loc.step.title, updatedAt: now }
    : item);
  const conflicts = store.conflicts.filter((item) => item.stepId !== stepId);
  return enqueue({ ...store, records, conflicts }, { type: 'ack', stepId, contentVersion, at: now });
}

// ---------- 网络恢复后的对账合并（按步骤编号） ----------

function toAuthorSnapshot(loc: StepLocation): AuthorContentSnapshot {
  const { step, stepNo } = loc;
  return {
    stepId: step.id,
    stepNo,
    title: step.title,
    kind: step.kind,
    duration: step.duration,
    difficulty: step.difficulty,
    caption: step.caption,
    captionPosition: step.captionPosition,
    handshape: step.handshape,
    camera: step.camera,
    altText: step.altText,
    prerequisiteId: step.prerequisiteId,
  };
}

function toReviewSnapshot(record: StepReview): ReviewSideSnapshot {
  return {
    verdict: record.verdict,
    comment: record.comment,
    reviewer: record.reviewer,
    confirmed: record.confirmed,
    updatedAt: record.updatedAt,
  };
}

/** 把离线期间攒下的复核操作按顺序补推到远端基线之上 */
function replayOps(records: StepReview[], ops: ReviewOp[]): { records: StepReview[]; courseReturn?: CourseReturn } {
  let next = records;
  let courseReturn: CourseReturn | undefined;
  for (const op of ops) {
    if (op.type === 'upsert') {
      const existing = next.find((item) => item.stepId === op.stepId);
      const merged: StepReview = {
        stepId: op.stepId,
        stepNo: op.stepNo,
        moduleId: op.moduleId,
        moduleTitle: op.moduleTitle,
        stepTitle: op.stepTitle,
        verdict: op.verdict,
        comment: op.comment,
        confirmed: false,
        reviewer: existing?.reviewer ?? '林复核员',
        stale: existing?.stale ?? false,
        contentVersion: op.contentVersion,
        reviewVersion: (existing?.reviewVersion ?? 0) + 1,
        updatedAt: op.at,
      };
      next = [...next.filter((item) => item.stepId !== op.stepId), merged];
    } else if (op.type === 'confirm') {
      next = next.map((item) => item.stepId === op.stepId
        ? { ...item, confirmed: true, stale: false, contentVersion: op.contentVersion, stepNo: op.stepNo, moduleId: op.moduleId, moduleTitle: op.moduleTitle, stepTitle: op.stepTitle, updatedAt: op.at }
        : item);
    } else if (op.type === 'ack') {
      next = next.map((item) => item.stepId === op.stepId
        ? { ...item, stale: false, contentVersion: op.contentVersion, updatedAt: op.at }
        : item);
    } else if (op.type === 'remove') {
      next = next.filter((item) => item.stepId !== op.stepId);
    } else if (op.type === 'course-return') {
      courseReturn = op.reason ? { reason: op.reason, at: op.at } : undefined;
    }
  }
  return { records: next, courseReturn };
}

class SimulatedMergeFailure extends Error {
  constructor(public side: 'author' | 'reviewer') {
    super(`模拟${side === 'author' ? '编排端' : '复核端'}合并失败`);
  }
}

export function reconcileReview(input: ReconcileInput): ReconcileResult {
  const { store, project, remoteReview, online, fault, side, now } = input;
  let remoteAuthor = input.remoteAuthor;
  const protectedConfirmed = store.records.filter((item) => item.confirmed).length;

  if (!online) {
    const report: SyncReport = {
      status: 'offline',
      message: `复核端离线，${store.pendingOps.length} 条意见已记在本机，联网后按步骤编号对账。`,
      pushedOps: 0,
      conflicts: store.conflicts.length,
      resetToUnconfirmed: 0,
      orphans: store.records.filter((item) => item.orphan).length,
      protectedConfirmed,
      at: now,
    };
    return { store, remoteAuthor, remoteReview, report };
  }

  try {
    // 阶段 A：编排端侧重推课程内容（内容认编排端）。复核侧重试时跳过。
    if (side !== 'reviewer') {
      if (fault === 'author') throw new SimulatedMergeFailure('author');
      remoteAuthor = structuredClone(project);
    }

    // 阶段 B：以复核端远端为基线，补推离线期间的复核操作（结论认复核端）。
    const baseRecords = remoteReview?.records ?? structuredClone(store.records);
    const replayed = replayOps(baseRecords, store.pendingOps);
    const mergedById = new Map(replayed.records.map((item) => [item.stepId, item]));

    const currentIndex = buildStepIndex(project);
    const touchedByReview = new Set(
      store.pendingOps.filter((op) => op.type !== 'course-return').map((op) => op.stepId),
    );

    const resultRecords: StepReview[] = [];
    const conflicts: ReviewConflict[] = [];
    let resetToUnconfirmed = 0;
    let orphans = 0;

    const orderedIds: string[] = [];
    currentIndex.forEach((_, id) => orderedIds.push(id));
    mergedById.forEach((_, id) => {
      if (!currentIndex.has(id)) orderedIds.push(id);
    });

    for (const stepId of orderedIds) {
      const loc = currentIndex.get(stepId);
      const record = mergedById.get(stepId);
      if (!loc) {
        // 编排端已删除该步骤：记录仍留在复核列表
        if (record) {
          resultRecords.push({ ...record, orphan: true, stale: false });
          orphans += 1;
        }
        continue;
      }
      if (!record) continue;

      const refreshed: StepReview = {
        ...record,
        orphan: undefined,
        stepNo: loc.stepNo,
        moduleId: loc.moduleId,
        moduleTitle: loc.moduleTitle,
        stepTitle: loc.step.title,
      };

      const currentFp = fingerprintStep(loc.step);
      // 编排端是否改过这一步：与结论上次所依据的内容指纹比
      const authorMoved = refreshed.contentVersion !== '' && refreshed.contentVersion !== currentFp;
      const reviewerMoved = touchedByReview.has(stepId);

      if (authorMoved && reviewerMoved) {
        // 两边都动过：内容认编排端、结论认复核端，两版并排等逐条认
        conflicts.push({
          stepId,
          stepNo: loc.stepNo,
          author: toAuthorSnapshot(loc),
          review: toReviewSnapshot(refreshed),
          detectedAt: now,
        });
        if (refreshed.confirmed) resetToUnconfirmed += 1;
        resultRecords.push({ ...refreshed, confirmed: false, stale: true });
      } else if (authorMoved) {
        // 老师改过这一步：结论退回未确认，但仍留在列表里
        if (refreshed.confirmed) resetToUnconfirmed += 1;
        resultRecords.push({ ...refreshed, confirmed: false, stale: true });
      } else {
        // 内容没变（或复核端只是重新表态）：结论按复核端补推结果走
        resultRecords.push({ ...refreshed, stale: false, contentVersion: currentFp });
      }
    }

    // 保留此前已经并排、尚未逐条认的冲突，并刷新编排端版本
    const resultById = new Map(resultRecords.map((item) => [item.stepId, item]));
    for (const prior of store.conflicts) {
      if (conflicts.some((item) => item.stepId === prior.stepId)) continue;
      const loc = currentIndex.get(prior.stepId);
      const record = resultById.get(prior.stepId);
      if (loc && record) {
        conflicts.push({ ...prior, stepNo: loc.stepNo, author: toAuthorSnapshot(loc), review: toReviewSnapshot(record) });
      }
    }

    // 阶段 C：推送复核端合并结果。编排侧重试时若问题只在内容侧，远端仍保持现状。
    if (fault === 'reviewer' && side !== 'author') throw new SimulatedMergeFailure('reviewer');

    const nextRemoteReview: RemoteReviewState = {
      records: resultRecords,
      courseReturn: replayed.courseReturn !== undefined ? replayed.courseReturn : (remoteReview?.courseReturn ?? store.courseReturn),
    };

    // 本地复核库与合并结果对齐（本地记录是远端基线的来源，不会丢已确认结论）
    const localById = new Map(store.records.map((item) => [item.stepId, item]));
    const syncedRecords = resultRecords.map((record) => ({ ...(localById.get(record.stepId) ?? {}), ...record }));

    const syncedStore: ReviewStore = {
      ...store,
      records: syncedRecords,
      pendingOps: [],
      conflicts,
      courseReturn: nextRemoteReview.courseReturn,
      syncStatus: 'synced',
      lastSyncAt: now,
      lastError: undefined,
      failSide: undefined,
      lastReport: undefined,
    };

    const report: SyncReport = {
      status: 'synced',
      message: `已按步骤编号完成对账：补推 ${store.pendingOps.length} 条复核操作，${conflicts.length} 处两版并排待认，${resetToUnconfirmed} 条结论因编排端改动退回未确认。`,
      pushedOps: store.pendingOps.length,
      conflicts: conflicts.length,
      resetToUnconfirmed,
      orphans,
      protectedConfirmed,
      at: now,
    };
    syncedStore.lastReport = report;
    return { store: syncedStore, remoteAuthor, remoteReview: nextRemoteReview, report };
  } catch (error) {
    const failSide = error instanceof SimulatedMergeFailure ? error.side : 'reviewer';
    // 合并失败：本地复核库保持原样（已确认结论先保住），只记录失败状态，待按侧重试
    const report: SyncReport = {
      status: 'failed',
      failSide,
      message: failSide === 'author'
        ? '编排端侧合并失败，课程内容未推送；复核结论保持原样，可按编排侧重试。'
        : '复核端侧合并失败，意见未补推；已确认结论已保住，可按复核侧重试。',
      pushedOps: 0,
      conflicts: store.conflicts.length,
      resetToUnconfirmed: 0,
      orphans: store.records.filter((item) => item.orphan).length,
      protectedConfirmed,
      at: now,
    };
    const failedStore: ReviewStore = {
      ...store,
      syncStatus: 'failed',
      lastError: report.message,
      failSide,
      lastReport: report,
    };
    return { store: failedStore, remoteAuthor, remoteReview, report };
  }
}
