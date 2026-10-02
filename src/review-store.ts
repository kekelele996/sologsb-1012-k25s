import type { CourseProject, LessonStep } from './models';

/** 复核端独立保存键：与编排端草稿分开存储，各自改动只落在自己这边。 */
export const REVIEW_STORAGE_KEY = 'sologsb-1012-sign-course-review-v1';

export type ReviewVerdict = 'pass' | 'return';

/** 单个步骤的复核结论与退回意见，由复核端持有。 */
export interface StepReview {
  stepId: string;
  /** 结论：通过 / 退回 */
  verdict: ReviewVerdict;
  /** 退回意见或复核说明 */
  opinion: string;
  reviewer: string;
  updatedAt: string;
  /** 是否已经逐条确认 */
  confirmed: boolean;
  confirmedAt?: string;
  /** 作出结论时编排端的修订号与内容哈希，用于对账 */
  baseRevision: number;
  baseHash: string;
  baseAt: string;
  /** 冗余保存步骤标题，步骤被删除后仍能在列表里显示 */
  stepTitle: string;
  moduleTitle: string;
}

/** 复核端草稿：与编排端草稿分离。 */
export interface ReviewDraft {
  projectId: string;
  reviewer: string;
  reviews: Record<string, StepReview>;
  lastSavedAt: string;
  lastSyncedAt?: string;
  reviewRevision: number;
}

export type MergeStatus = 'ok' | 'pending' | 'stale' | 'conflict' | 'orphaned';

export interface MergeItem {
  stepId: string;
  stepTitle: string;
  moduleTitle: string;
  status: MergeStatus;
  /** 编排端内容相对结论基准发生了变化 */
  contentChanged: boolean;
  /** 两边都动过：编排端内容变了，复核端结论也在基准之后改过 */
  bothModified: boolean;
  orchestrationHash: string;
  currentStep?: LessonStep;
  review?: StepReview;
  /** 合并结果：内容认编排端、结论认复核端 */
  mergedVerdict?: ReviewVerdict;
  mergedOpinion?: string;
}

export interface ReconcileOutcome {
  ok: boolean;
  failedSide?: 'orchestration' | 'review';
  items: MergeItem[];
  syncedAt: string;
}

export function createReviewDraft(projectId: string, reviewer = ''): ReviewDraft {
  return {
    projectId,
    reviewer,
    reviews: {},
    lastSavedAt: new Date().toISOString(),
    reviewRevision: 1,
  };
}

export function loadReviewDraft(projectId: string): ReviewDraft {
  try {
    const raw = localStorage.getItem(REVIEW_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ReviewDraft;
      if (parsed.projectId === projectId) return parsed;
    }
  } catch {
    /* 解析失败则重建，不影响编排端草稿 */
  }
  return createReviewDraft(projectId);
}

export function saveReviewDraft(draft: ReviewDraft): void {
  draft.lastSavedAt = new Date().toISOString();
  localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(draft));
}

/** 编排端持有字段的内容哈希：标题、类型、时长、素材、手形、字幕、镜头、练习等。 */
export function contentHash(step: LessonStep): string {
  const payload = JSON.stringify([
    step.title,
    step.kind,
    step.duration,
    step.demoTitle,
    step.demoUrl,
    step.handshape,
    step.gestureZone,
    step.caption,
    step.captionPosition,
    step.camera,
    step.commonMistakes,
    step.exercise,
    step.exerciseFeedback,
    step.altText,
    step.prerequisiteId,
    step.difficulty,
    step.cuePoints,
  ]);
  let h = 0;
  for (let i = 0; i < payload.length; i++) {
    h = (Math.imul(h, 31) + payload.charCodeAt(i)) | 0;
  }
  return `h${(h >>> 0).toString(36)}`;
}

export function currentHash(project: CourseProject, stepId: string): string | null {
  for (const module of project.modules) {
    const step = module.steps.find((item) => item.id === stepId);
    if (step) return contentHash(step);
  }
  return null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function stepMeta(project: CourseProject, stepId: string): { stepTitle: string; moduleTitle: string } {
  for (const module of project.modules) {
    const step = module.steps.find((item) => item.id === stepId);
    if (step) return { stepTitle: step.title, moduleTitle: module.title };
  }
  return { stepTitle: '已删除的步骤', moduleTitle: '' };
}

/** 复核端录入/修改结论：只写复核端草稿，并把基准对齐到当前编排端内容。 */
export function upsertReview(
  draft: ReviewDraft,
  project: CourseProject,
  stepId: string,
  patch: Partial<Pick<StepReview, 'verdict' | 'opinion' | 'reviewer'>>,
): ReviewDraft {
  const existing = draft.reviews[stepId];
  const meta = stepMeta(project, stepId);
  const baseHash = currentHash(project, stepId) ?? existing?.baseHash ?? '';
  const next: StepReview = {
    stepId,
    verdict: patch.verdict ?? existing?.verdict ?? 'pass',
    opinion: patch.opinion ?? existing?.opinion ?? '',
    reviewer: patch.reviewer ?? draft.reviewer ?? existing?.reviewer ?? '',
    updatedAt: nowIso(),
    // 结论一旦改过，已确认状态作废，需要重新逐条认
    confirmed: false,
    baseRevision: project.revision,
    baseHash,
    baseAt: existing?.baseAt ?? nowIso(),
    stepTitle: existing?.stepTitle || meta.stepTitle,
    moduleTitle: existing?.moduleTitle || meta.moduleTitle,
  };
  return {
    ...draft,
    reviewer: next.reviewer || draft.reviewer,
    reviews: { ...draft.reviews, [stepId]: next },
    reviewRevision: draft.reviewRevision + 1,
  };
}

/** 逐条确认：确认后基准对齐当前编排端内容。 */
export function confirmReview(draft: ReviewDraft, project: CourseProject, stepId: string): ReviewDraft {
  const existing = draft.reviews[stepId];
  if (!existing) return draft;
  const baseHash = currentHash(project, stepId) ?? existing.baseHash;
  return {
    ...draft,
    reviews: {
      ...draft.reviews,
      [stepId]: {
        ...existing,
        confirmed: true,
        confirmedAt: nowIso(),
        baseRevision: project.revision,
        baseHash,
      },
    },
  };
}

/** 对账：按步骤编号合并编排端与复核端。faults 用于模拟某一侧合并失败。 */
export function reconcile(
  project: CourseProject,
  draft: ReviewDraft,
  faults: { orchestration?: boolean; review?: boolean } = {},
): ReconcileOutcome {
  const syncedAt = nowIso();
  if (faults.orchestration) {
    return { ok: false, failedSide: 'orchestration', items: [], syncedAt };
  }
  if (faults.review) {
    return { ok: false, failedSide: 'review', items: [], syncedAt };
  }

  const stepMap = new Map<string, { step: LessonStep; moduleTitle: string }>();
  project.modules.forEach((module) => {
    module.steps.forEach((step) => stepMap.set(step.id, { step, moduleTitle: module.title }));
  });

  const items: MergeItem[] = [];

  // 已有结论的步骤：按编号对账
  for (const review of Object.values(draft.reviews)) {
    const found = stepMap.get(review.stepId);
    if (!found) {
      items.push({
        stepId: review.stepId,
        stepTitle: review.stepTitle || '已删除的步骤',
        moduleTitle: review.moduleTitle,
        status: 'orphaned',
        contentChanged: true,
        bothModified: false,
        orchestrationHash: '',
        review,
      });
      continue;
    }
    const hash = contentHash(found.step);
    const contentChanged = hash !== review.baseHash;
    const bothModified = contentChanged && review.updatedAt > review.baseAt;
    const status: MergeStatus = bothModified
      ? 'conflict'
      : contentChanged
        ? 'stale'
        : review.confirmed
          ? 'ok'
          : 'pending';
    items.push({
      stepId: review.stepId,
      stepTitle: found.step.title,
      moduleTitle: found.moduleTitle,
      status,
      contentChanged,
      bothModified,
      orchestrationHash: hash,
      currentStep: found.step,
      review,
      // 合并铁律：内容认编排端，结论认复核端
      mergedVerdict: review.verdict,
      mergedOpinion: review.opinion,
    });
  }

  // 还没有结论的步骤
  stepMap.forEach(({ step, moduleTitle }, stepId) => {
    if (draft.reviews[stepId]) return;
    items.push({
      stepId,
      stepTitle: step.title,
      moduleTitle,
      status: 'pending',
      contentChanged: false,
      bothModified: false,
      orchestrationHash: contentHash(step),
      currentStep: step,
    });
  });

  items.sort((a, b) => a.stepId.localeCompare(b.stepId));
  return { ok: true, items, syncedAt };
}

/** 把对账结果写回复核端草稿：已经确认的结论一律保住，不删除、不回滚。 */
export function applyReconcile(draft: ReviewDraft, outcome: ReconcileOutcome): ReviewDraft {
  if (!outcome.ok) return draft;
  const reviews = { ...draft.reviews };
  for (const item of outcome.items) {
    const review = reviews[item.stepId];
    if (!review) continue;
    if (item.status === 'stale' || item.status === 'conflict') {
      // 编排端改过内容：结论退回未确认，但仍留在列表里
      reviews[item.stepId] = { ...review, confirmed: false };
    }
    // ok / pending / orphaned：已确认的结论原样保留
  }
  return { ...draft, reviews, lastSyncedAt: outcome.syncedAt };
}
