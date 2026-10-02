import { Component, Host, State, h, Listen } from '@stencil/core';
import {
  cloneProject,
  createDemoProject,
  selectedModule,
  selectedStep,
  validateProject,
  type CameraAngle,
  type CaptionPosition,
  type CourseModule,
  type CourseProject,
  type Difficulty,
  type GestureZone,
  type LessonStep,
  type ValidationCheck,
} from '../../models';
import {
  acknowledgeConflict,
  buildStepIndex,
  confirmReview,
  createSeedReviewStore,
  loadRemoteAuthor,
  loadRemoteReview,
  loadReviewStore,
  loadRole,
  recordReview,
  reconcileReview,
  removeReview,
  saveRemoteAuthor,
  saveRemoteReview,
  saveReviewStore,
  saveRole,
  setCourseReturn,
  verdictLabel,
  AUTHOR_DRAFT_KEY,
  type FaultSide,
  type Role,
  type ReviewConflict,
  type ReviewStore,
  type ReviewVerdict,
  type StepLocation,
  type StepReview,
  type SyncReport,
} from '../../review';

type PreviewSize = 'phone' | 'tablet';

interface ReviewDraft {
  verdict: ReviewVerdict;
  comment: string;
}

@Component({
  tag: 'app-root',
  styleUrl: 'app-root.css',
  scoped: true,
})
export class AppRoot {
  @State() role: Role = 'author';
  @State() project: CourseProject = createDemoProject();
  @State() review: ReviewStore = createSeedReviewStore(this.project);
  @State() previewSize: PreviewSize = 'phone';
  @State() activePanel: 'editor' | 'checks' = 'editor';
  @State() reviewerPanel: 'worklist' | 'merge' = 'worklist';
  @State() selectedReviewStepId = '';
  @State() reviewDrafts: Record<string, ReviewDraft> = {};
  @State() courseReturnDraft = '';
  @State() playing = false;
  @State() playProgress = 0;
  @State() offline = typeof navigator !== 'undefined' ? !navigator.onLine : false;
  @State() fault: FaultSide = 'none';
  @State() toast?: { color: string; message: string };
  private past: CourseProject[] = [];
  private future: CourseProject[] = [];
  private playTimer?: number;

  componentWillLoad(): void {
    // 编排端草稿：只装课程模块、学习步骤、字幕
    try {
      const saved = localStorage.getItem(AUTHOR_DRAFT_KEY);
      if (saved) this.project = JSON.parse(saved) as CourseProject;
    } catch {
      this.project = createDemoProject();
    }
    // 复核端底稿：只装每步骤的复核结论与退回意见
    this.review = loadReviewStore(this.project);
    this.selectedReviewStepId = this.review.records[0]?.stepId ?? this.firstReviewableStepId();
    this.courseReturnDraft = this.review.courseReturn?.reason ?? '';
    this.role = loadRole();
  }

  disconnectedCallback(): void {
    if (this.playTimer) window.clearInterval(this.playTimer);
  }

  @Listen('online', { target: 'window' })
  handleOnline(): void {
    this.offline = false;
    if (this.role === 'reviewer') {
      this.runReconcile('网络已恢复，正在按步骤编号对账…');
    } else {
      this.pushAuthorContent();
      this.showToast('success', '网络已恢复，编排端课程内容已同步；复核结论在复核端那边不受影响。');
    }
  }

  @Listen('offline', { target: 'window' })
  handleOffline(): void {
    this.offline = true;
    this.showToast('warning', '当前处于离线状态：复核意见仍会记在本机，联网后补推对账。');
  }

  @Listen('keydown', { target: 'window' })
  handleKeyboard(event: KeyboardEvent): void {
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName);
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      if (this.role !== 'author') return;
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      if (this.role !== 'author') return;
      event.preventDefault();
      this.redo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 's') {
      if (this.role !== 'author') return;
      event.preventDefault();
      this.saveDraft(true);
      return;
    }
    if (!editing && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      if (this.role !== 'author') return;
      event.preventDefault();
      this.moveStep(event.key === 'ArrowUp' ? -1 : 1);
    }
  }

  // ---------- 选择与派生 ----------

  private get currentModule(): CourseModule {
    return selectedModule(this.project);
  }

  private get currentStep(): LessonStep | undefined {
    return selectedStep(this.project);
  }

  private get currentReviewStep(): LessonStep | undefined {
    const id = this.selectedReviewStepId;
    if (!id) return undefined;
    return buildStepIndex(this.project).get(id)?.step;
  }

  private get currentReviewRecord(): StepReview | undefined {
    return this.review.records.find((item) => item.stepId === this.selectedReviewStepId);
  }

  private get checks(): ValidationCheck[] {
    return validateProject(this.project);
  }

  private firstReviewableStepId(): string {
    const first = this.project.modules[0]?.steps[0];
    return first?.id ?? '';
  }

  private findStep(stepId: string): { module: CourseModule; step: LessonStep } | undefined {
    for (const module of this.project.modules) {
      const step = module.steps.find((item) => item.id === stepId);
      if (step) return { module, step };
    }
    return undefined;
  }

  private reviewRecordFor(stepId: string): StepReview | undefined {
    return this.review.records.find((item) => item.stepId === stepId);
  }

  /** 复核列表行：现存步骤 + 仍保留的孤儿结论（老师删掉的步骤） */
  private get reviewRows(): Array<{ loc?: StepLocation; record?: StepReview }> {
    const index = buildStepIndex(this.project);
    const rows: Array<{ loc?: StepLocation; record?: StepReview }> = [];
    index.forEach((loc) => {
      rows.push({ loc, record: this.review.records.find((item) => item.stepId === loc.step.id) });
    });
    this.review.records.forEach((record) => {
      if (!index.has(record.stepId)) rows.push({ loc: undefined, record });
    });
    return rows;
  }

  // ---------- 编排端：课程内容（只写编排端自己的存储） ----------

  private persistAuthor(push = true): void {
    localStorage.setItem(AUTHOR_DRAFT_KEY, JSON.stringify(this.project));
    if (push) this.pushAuthorContent();
  }

  /** 在线时课程内容直推编排端远端；离线时留在草稿，下次对账带走 */
  private pushAuthorContent(): void {
    if (!this.offline) saveRemoteAuthor(this.project);
  }

  private commit(update: (draft: CourseProject) => CourseProject, toast?: string): void {
    if (this.project.status === 'frozen') {
      this.showToast('warning', '当前版本已冻结，请先创建修订版。');
      return;
    }
    const before = cloneProject(this.project);
    const next = update(cloneProject(this.project));
    next.revision = before.revision + 1;
    next.lastSavedAt = new Date().toISOString();
    this.past = [...this.past, before].slice(-80);
    this.future = [];
    this.project = next;
    this.persistAuthor();
    if (toast) this.showToast('success', toast);
  }

  private undo(): void {
    const previous = this.past.pop();
    if (!previous) return this.showToast('medium', '没有可撤销的修改。');
    this.future = [cloneProject(this.project), ...this.future].slice(0, 80);
    this.project = previous;
    this.persistAuthor();
  }

  private redo(): void {
    const next = this.future.shift();
    if (!next) return;
    this.past = [...this.past, cloneProject(this.project)].slice(-80);
    this.project = next;
    this.persistAuthor();
  }

  private showToast(color: string, message: string): void {
    this.toast = { color, message };
    window.setTimeout(() => {
      if (this.toast?.message === message) this.toast = undefined;
    }, 3_600);
  }

  private selectModule(moduleId: string): void {
    const module = this.project.modules.find((item) => item.id === moduleId);
    this.project = { ...this.project, selectedModuleId: moduleId, selectedStepId: module?.steps[0]?.id ?? '' };
    this.persistAuthor(false);
  }

  private selectStep(stepId: string): void {
    this.project = { ...this.project, selectedStepId: stepId };
    this.persistAuthor(false);
  }

  private selectReviewStep(stepId: string): void {
    this.selectedReviewStepId = stepId;
  }

  private updateStep(patch: Partial<LessonStep>, toast?: string): void {
    const stepId = this.currentStep?.id;
    if (!stepId) return;
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? {
        ...module,
        steps: module.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step),
      } : module),
    }), toast);
  }

  private updateCurrentModule(patch: Partial<CourseModule>): void {
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? { ...module, ...patch } : module),
    }));
  }

  private addModule(): void {
    const index = this.project.modules.length + 1;
    const module: CourseModule = {
      id: `module-${Date.now().toString(36)}`,
      title: `模块 ${index} · 未命名`,
      summary: '说明该模块的学习目标与适用场景。',
      color: ['#15827a', '#8a3ffc', '#b34331', '#376ea8'][index % 4],
      steps: [],
    };
    this.commit((draft) => ({ ...draft, modules: [...draft.modules, module], selectedModuleId: module.id, selectedStepId: '' }), '已创建课程模块。');
  }

  private addStep(kind: LessonStep['kind'] = '示范'): void {
    const module = this.currentModule;
    if (!module) return this.addModule();
    const prior = module.steps.at(-1);
    const step: LessonStep = {
      id: `step-${Date.now().toString(36)}`,
      title: `新${kind}步骤 ${module.steps.length + 1}`,
      kind,
      duration: 45,
      demoTitle: '等待上传或录制示范片段',
      demoUrl: '',
      handshape: '描述起始手形、掌心方向和运动路径。',
      gestureZone: '中央',
      caption: '填写送给学习者的字幕说明。',
      captionPosition: '下方安全区',
      camera: '正面',
      commonMistakes: [],
      exercise: kind === '练习' ? '填写练习任务。' : '',
      exerciseFeedback: kind === '练习' ? '填写反馈方式。' : '',
      altText: '',
      prerequisiteId: prior?.id ?? '',
      difficulty: '入门',
      cuePoints: [8, 20, 32],
    };
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((item) => item.id === module.id ? { ...item, steps: [...item.steps, step] } : item),
      selectedStepId: step.id,
    }), '已新增学习步骤。');
  }

  private duplicateStep(): void {
    const step = this.currentStep;
    if (!step) return;
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => {
        if (module.id !== draft.selectedModuleId) return module;
        const index = module.steps.findIndex((item) => item.id === step.id);
        const duplicate = { ...structuredClone(step), id: `step-${Date.now().toString(36)}`, title: `${step.title}（副本）` };
        return { ...module, steps: [...module.steps.slice(0, index + 1), duplicate, ...module.steps.slice(index + 1)] };
      }),
    }), '已复制当前步骤。');
  }

  private deleteStep(stepId: string): void {
    if (this.currentModule.steps.length <= 1) {
      this.showToast('warning', '模块至少保留一个学习步骤。');
      return;
    }
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? {
        ...module,
        steps: module.steps.filter((step) => step.id !== stepId),
      } : module),
      selectedStepId: this.currentModule.steps.find((step) => step.id !== stepId)?.id ?? '',
    }), '已删除学习步骤；该步骤的复核结论仍留在复核端列表。');
  }

  private moveStep(direction: number): void {
    const stepId = this.currentStep?.id;
    if (!stepId) return;
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => {
        if (module.id !== draft.selectedModuleId) return module;
        const index = module.steps.findIndex((step) => step.id === step.id);
        const nextIndex = Math.max(0, Math.min(module.steps.length - 1, index + direction));
        if (index === nextIndex) return module;
        const steps = [...module.steps];
        const [item] = steps.splice(index, 1);
        steps.splice(nextIndex, 0, item);
        return { ...module, steps };
      }),
    }), '已调整步骤顺序。');
  }

  private saveDraft(showMessage = true): void {
    if (this.project.status === 'frozen') {
      this.showToast('warning', '冻结版本不可覆盖，请先创建修订版。');
      return;
    }
    this.project = { ...this.project, status: 'draft', lastSavedAt: new Date().toISOString() };
    this.persistAuthor();
    if (showMessage) this.showToast('success', '草稿已保存在编排端本地，复核结论不受影响。');
  }

  private submitForReview(): void {
    const blocking = this.checks.filter((check) => check.severity === 'error');
    if (blocking.length) {
      this.activePanel = 'checks';
      this.showToast('danger', `仍有 ${blocking.length} 个阻断问题，修复后才能提交复核。`);
      return;
    }
    this.commit((draft) => ({ ...draft, status: 'review' }), '课程已提交复核；请到复核端逐步骤给出结论。');
  }

  private freezeVersion(): void {
    const blocking = this.checks.filter((check) => check.severity === 'error');
    if (blocking.length) {
      this.activePanel = 'checks';
      this.showToast('danger', `冻结前仍有 ${blocking.length} 个阻断问题。`);
      return;
    }
    this.commit((draft) => {
      const { frozenVersions, ...snapshot } = cloneProject(draft);
      const version = {
        id: `frozen-${Date.now().toString(36)}`,
        label: `冻结版本 v${frozenVersions.length + 1}`,
        createdAt: new Date().toISOString(),
        snapshot,
      };
      return { ...draft, status: 'frozen', frozenVersions: [version, ...frozenVersions] };
    }, '当前课程版本已冻结。');
    this.playing = false;
  }

  private reviseFrozen(): void {
    this.commit((draft) => ({ ...draft, status: 'draft' }), '已创建修订版，可继续编辑。');
  }

  // ---------- 复核端：结论与退回意见（只写复核端自己的存储） ----------

  private persistReview(next: ReviewStore): void {
    this.review = next;
    saveReviewStore(next);
    // 在线即补推对账；离线时操作已经排在 pendingOps 里
    if (!this.offline) this.runReconcile();
  }

  private reviewDraftFor(stepId: string): ReviewDraft {
    const cached = this.reviewDrafts[stepId];
    if (cached) return cached;
    const record = this.reviewRecordFor(stepId);
    return { verdict: record?.verdict ?? 'returned', comment: record?.comment ?? '' };
  }

  private patchReviewDraft(stepId: string, patch: Partial<ReviewDraft>): void {
    const base = this.reviewDraftFor(stepId);
    this.reviewDrafts = { ...this.reviewDrafts, [stepId]: { ...base, ...patch } };
  }

  private saveReviewOpinion(): void {
    const stepId = this.selectedReviewStepId;
    if (!stepId) return;
    const draft = this.reviewDraftFor(stepId);
    if (draft.verdict === 'returned' && !draft.comment.trim()) {
      this.showToast('danger', '退回该步骤前请先填写退回意见。');
      return;
    }
    const next = recordReview(this.review, this.project, stepId, draft);
    this.persistReview(next);
    this.showToast(this.offline ? 'warning' : 'success', this.offline
      ? '离线中：结论与退回意见已记在本机，联网后补推。'
      : '复核结论已保存，并按步骤编号完成对账。');
  }

  private confirmReviewOpinion(stepId: string): void {
    this.persistReview(confirmReview(this.review, this.project, stepId));
    this.showToast('success', '该步骤结论已确认。');
  }

  private removeReviewRecord(stepId: string): void {
    this.persistReview(removeReview(this.review, stepId));
    if (this.selectedReviewStepId === stepId) {
      const nextRow = this.reviewRows.find((row) => {
        const id: string = row.loc ? row.loc.step.id : (row.record?.stepId ?? '');
        return id !== stepId;
      });
      this.selectedReviewStepId = nextRow ? (nextRow.loc ? nextRow.loc.step.id : (nextRow.record?.stepId ?? '')) : '';
    }
    this.showToast('medium', '已从复核列表移除该记录。');
  }

  private saveCourseReturn(): void {
    this.persistReview(setCourseReturn(this.review, this.courseReturnDraft));
    this.showToast(this.offline ? 'warning' : 'success', this.offline ? '课程退回说明离线暂存，联网后补推。' : '课程退回说明已保存。');
  }

  private acknowledge(stepId: string): void {
    const next = acknowledgeConflict(this.review, this.project, stepId);
    this.persistReview(next);
    this.showToast('success', '已按步骤认下编排端内容；结论仍以复核端为准，请重新确认。');
  }

  private switchRole(role: Role): void {
    this.role = role;
    saveRole(role);
    this.playing = false;
    this.playProgress = 0;
    if (role === 'reviewer') {
      this.selectedReviewStepId = this.currentReviewStep?.id
        ?? this.review.records[0]?.stepId
        ?? this.firstReviewableStepId();
      if (!this.offline) this.runReconcile('已切换到复核端，正在拉取编排端内容对账…');
    } else {
      this.pushAuthorContent();
    }
  }

  private toggleOffline(): void {
    const next = !this.offline;
    this.offline = next;
    if (!next) {
      if (this.role === 'reviewer') this.runReconcile('网络已恢复，正在按步骤编号对账…');
      else {
        this.pushAuthorContent();
        this.showToast('success', '网络已恢复，编排端课程内容已同步。');
      }
    } else {
      this.showToast('warning', '已进入离线模拟：复核端意见仍可记录，暂存本机。');
    }
  }

  // ---------- 对账合并 ----------

  private runReconcile(toastMessage?: string, side?: 'author' | 'reviewer'): void {
    if (this.offline) {
      this.showToast('warning', `复核端离线，${this.review.pendingOps.length} 条意见暂存本机，联网后自动对账。`);
      return;
    }
    const result = reconcileReview({
      store: this.review,
      project: this.project,
      remoteAuthor: loadRemoteAuthor(),
      remoteReview: loadRemoteReview(),
      online: true,
      fault: this.fault,
      side,
      now: new Date().toISOString(),
    });
    this.review = result.store;
    saveReviewStore(result.store);
    if (result.report.status === 'synced') {
      if (result.remoteAuthor) saveRemoteAuthor(result.remoteAuthor);
      if (result.remoteReview) saveRemoteReview(result.remoteReview);
      // 成功一次后把演练用的失败开关复位，避免后续对账一直失败
      this.fault = 'none';
      this.showToast('success', toastMessage ? `${toastMessage} 对账已完成。` : result.report.message);
    } else {
      this.showToast('danger', result.report.message);
    }
  }

  private retrySync(side: 'author' | 'reviewer'): void {
    this.runReconcile(side === 'author' ? '按编排侧重试' : '按复核侧重试', side);
  }

  // ---------- 预览 ----------

  private togglePlay(): void {
    if (this.playTimer) {
      window.clearInterval(this.playTimer);
      this.playTimer = undefined;
      this.playing = false;
      return;
    }
    const duration = Math.max(10, (this.role === 'reviewer' ? this.currentReviewStep : this.currentStep)?.duration ?? 40);
    this.playing = true;
    this.playTimer = window.setInterval(() => {
      this.playProgress += 0.25 / duration;
      if (this.playProgress >= 1) {
        this.playProgress = 0;
        this.playing = false;
        if (this.playTimer) window.clearInterval(this.playTimer);
        this.playTimer = undefined;
      }
    }, 250);
  }

  private formatDate(value: string): string {
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  private renderStatusBadge(status: CourseProject['status'] = this.project.status) {
    if (status === 'review') return <ion-badge color="warning">待复核</ion-badge>;
    if (status === 'changes') return <ion-badge color="danger">已退回</ion-badge>;
    if (status === 'frozen') return <ion-badge color="success">已冻结</ion-badge>;
    return <ion-badge color="medium">草稿</ion-badge>;
  }

  private renderReviewBadge(stepId: string) {
    const record = this.reviewRecordFor(stepId);
    if (!record) return <span class="review-badge none">未复核</span>;
    const cls = record.orphan ? 'orphan' : record.stale || !record.confirmed ? 'stale' : record.verdict;
    const icon = record.verdict === 'approved' ? '✓' : '↩';
    return (
      <span class={`review-badge ${cls}`} title={record.comment}>
        {icon} {verdictLabel(record.verdict)}{record.confirmed ? '' : '·未确认'}
      </span>
    );
  }

  // ---------- 编排端视图 ----------

  private renderStepListItem(step: LessonStep, index: number) {
    const active = step.id === this.currentStep?.id;
    const issueCount = this.checks.filter((check) => check.stepId === step.id && check.severity !== 'info').length;
    return (
      <button class={`step-list-item ${active ? 'active' : ''}`} onClick={() => this.selectStep(step.id)}>
        <span class="step-index">{String(index + 1).padStart(2, '0')}</span>
        <span class="step-copy">
          <strong>{step.title}</strong>
          <small>{step.kind} · {step.duration}s · {step.difficulty}</small>
          {this.renderReviewBadge(step.id)}
        </span>
        {issueCount > 0 && <span class="step-issue-count">{issueCount}</span>}
      </button>
    );
  }

  private renderStepEditor() {
    const step = this.currentStep;
    if (!step) {
      return (
        <div class="empty-editor">
          <div class="empty-glyph">手</div>
          <h2>这个模块还没有学习步骤</h2>
          <p>添加示范、讲解或练习步骤，然后设置前置条件与难度。</p>
          <ion-button class="studio-button" onClick={() => this.addStep('示范')}>添加第一个步骤</ion-button>
        </div>
      );
    }
    const frozen = this.project.status === 'frozen';
    const module = this.currentModule;
    const prerequisites = module.steps.filter((candidate, index) => candidate.id !== step.id && index < module.steps.findIndex((item) => item.id === step.id));
    const reviewRecord = this.reviewRecordFor(step.id);
    return (
      <div class="step-editor">
        <div class="editor-title-row">
          <div>
            <span class="eyebrow">学习步骤 {module.steps.findIndex((item) => item.id === step.id) + 1}</span>
            <h1>{step.title}</h1>
            <p>最后修改 {this.formatDate(this.project.lastSavedAt)} · 修订号 {this.project.revision}</p>
          </div>
          <div class="title-actions">
            <ion-button fill="clear" class="studio-button" onClick={() => this.moveStep(-1)} title="Alt + ↑">上移</ion-button>
            <ion-button fill="clear" class="studio-button" onClick={() => this.moveStep(1)} title="Alt + ↓">下移</ion-button>
            <ion-button fill="outline" class="studio-button" onClick={() => this.duplicateStep()}>复制</ion-button>
            <ion-button fill="outline" color="danger" class="studio-button" onClick={() => this.deleteStep(step.id)}>删除</ion-button>
          </div>
        </div>

        {reviewRecord && (
          <div class={`review-feedback-callout ${reviewRecord.verdict} ${reviewRecord.stale || !reviewRecord.confirmed ? 'stale' : ''}`}>
            <div>
              <strong>复核端结论：{verdictLabel(reviewRecord.verdict)}{reviewRecord.confirmed ? '（已确认）' : '（退回未确认）'}</strong>
              <span>{reviewRecord.comment || '复核员暂未填写退回意见。'} · {reviewRecord.reviewer} · {this.formatDate(reviewRecord.updatedAt)}</span>
            </div>
          </div>
        )}

        {frozen && (
          <div class="frozen-callout">
            <div><strong>此版本已冻结</strong><span>字段已锁定，仍可预览和运行检查。</span></div>
            <ion-button size="small" class="studio-button" onClick={() => this.reviseFrozen()}>创建修订版</ion-button>
          </div>
        )}

        <section class="form-card">
          <div class="section-title"><span>01</span><div><h2>基础设计</h2><p>标题、类型、难度和预计时长</p></div></div>
          <div class="form-grid two">
            <ion-input disabled={frozen} label="步骤标题" labelPlacement="stacked" class="studio-input" value={step.title} onIonInput={(event) => this.updateStep({ title: event.detail.value ?? '' })} />
            <ion-select disabled={frozen} label="步骤类型" labelPlacement="stacked" class="studio-input" value={step.kind} onIonChange={(event) => this.updateStep({ kind: event.detail.value as LessonStep['kind'] })}>
              <ion-select-option value="示范">示范</ion-select-option>
              <ion-select-option value="讲解">讲解</ion-select-option>
              <ion-select-option value="练习">练习</ion-select-option>
            </ion-select>
            <ion-select disabled={frozen} label="难度标签" labelPlacement="stacked" class="studio-input" value={step.difficulty} onIonChange={(event) => this.updateStep({ difficulty: event.detail.value as Difficulty })}>
              {(['入门', '进阶', '挑战'] as Difficulty[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} type="number" min="10" max="600" label="预计时长（秒）" labelPlacement="stacked" class="studio-input" value={String(step.duration)} onIonInput={(event) => this.updateStep({ duration: Number(event.detail.value) || 0 })} />
          </div>
        </section>

        <section class="form-card">
          <div class="section-title"><span>02</span><div><h2>示范片段与镜头</h2><p>记录素材标识、手形、镜头角度和动作区域</p></div></div>
          <div class="demo-row">
            <div class={`video-thumbnail zone-${step.gestureZone}`}>
              <span class="play-mark">▶</span>
              <strong>{step.kind}片段</strong>
              <small>{step.camera}</small>
            </div>
            <div class="demo-fields">
              <ion-input disabled={frozen} label="示范片段名称" labelPlacement="stacked" class="studio-input" value={step.demoTitle} onIonInput={(event) => this.updateStep({ demoTitle: event.detail.value ?? '' })} />
              <ion-input disabled={frozen} label="本地素材地址（可空）" labelPlacement="stacked" class="studio-input" value={step.demoUrl} placeholder="例如 assets/hello.mp4" onIonInput={(event) => this.updateStep({ demoUrl: event.detail.value ?? '' })} />
            </div>
          </div>
          <div class="form-grid two">
            <ion-select disabled={frozen} label="镜头角度" labelPlacement="stacked" class="studio-input" value={step.camera} onIonChange={(event) => this.updateStep({ camera: event.detail.value as CameraAngle })}>
              {(['正面', '左侧 45°', '右侧 45°', '俯拍手部', '全身远景'] as CameraAngle[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-select disabled={frozen} label="主要手形区域" labelPlacement="stacked" class="studio-input" value={step.gestureZone} onIonChange={(event) => this.updateStep({ gestureZone: event.detail.value as GestureZone })}>
              {(['左侧', '中央', '右侧'] as GestureZone[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
          </div>
          <ion-textarea disabled={frozen} autoGrow label="手形说明" labelPlacement="stacked" class="studio-input" value={step.handshape} onIonInput={(event) => this.updateStep({ handshape: event.detail.value ?? '' })} />
        </section>

        <section class="form-card">
          <div class="section-title"><span>03</span><div><h2>字幕与无障碍</h2><p>检查字幕位置、动作遮挡与替代文本</p></div></div>
          <div class="form-grid two">
            <ion-select disabled={frozen} label="字幕位置" labelPlacement="stacked" class="studio-input" value={step.captionPosition} onIonChange={(event) => this.updateStep({ captionPosition: event.detail.value as CaptionPosition })}>
              {(['下方安全区', '上移 15%', '角标提示', '画面中央'] as CaptionPosition[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} label="替代文本状态" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText ? '已填写' : '缺失'} readonly />
          </div>
          <ion-textarea disabled={frozen} autoGrow label="步骤字幕" labelPlacement="stacked" class="studio-input" value={step.caption} onIonInput={(event) => this.updateStep({ caption: event.detail.value ?? '' })} />
          <ion-textarea disabled={frozen} autoGrow label="替代文本（必须描述动作与表情）" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText} onIonInput={(event) => this.updateStep({ altText: event.detail.value ?? '' })} />
        </section>

        <section class="form-card">
          <div class="section-title"><span>04</span><div><h2>学习依赖与练习</h2><p>前置步骤、常见错误、练习任务与反馈</p></div></div>
          <div class="form-grid two">
            <ion-select disabled={frozen} label="前置条件" labelPlacement="stacked" class="studio-input" value={step.prerequisiteId} onIonChange={(event) => this.updateStep({ prerequisiteId: event.detail.value ?? '' })}>
              <ion-select-option value="">无前置条件</ion-select-option>
              {prerequisites.map((item) => <ion-select-option value={item.id}>{item.title}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} label="检查点（秒，用逗号分隔）" labelPlacement="stacked" class="studio-input" value={step.cuePoints.join(', ')} onIonInput={(event) => this.updateStep({ cuePoints: (event.detail.value ?? '').split(/[,，\s]+/).map(Number).filter((value) => Number.isFinite(value)) })} />
          </div>
          <ion-textarea disabled={frozen} autoGrow label="常见错误（每行一条）" labelPlacement="stacked" class="studio-input" value={step.commonMistakes.join('\n')} onIonInput={(event) => this.updateStep({ commonMistakes: (event.detail.value ?? '').split('\n').filter(Boolean) })} />
          <div class="form-grid two">
            <ion-textarea disabled={frozen} autoGrow label="练习任务" labelPlacement="stacked" class="studio-input" value={step.exercise} onIonInput={(event) => this.updateStep({ exercise: event.detail.value ?? '' })} />
            <ion-textarea disabled={frozen} autoGrow label="练习反馈" labelPlacement="stacked" class="studio-input" value={step.exerciseFeedback} onIonInput={(event) => this.updateStep({ exerciseFeedback: event.detail.value ?? '' })} />
          </div>
        </section>
      </div>
    );
  }

  private renderChecks() {
    const errors = this.checks.filter((check) => check.severity === 'error');
    const warnings = this.checks.filter((check) => check.severity === 'warning');
    const info = this.checks.filter((check) => check.severity === 'info');
    return (
      <section class="checks-panel">
        <div class="checks-summary">
          <div class="check-stat danger"><strong>{errors.length}</strong><span>阻断问题</span></div>
          <div class="check-stat warning"><strong>{warnings.length}</strong><span>需注意</span></div>
          <div class="check-stat"><strong>{info.length}</strong><span>优化建议</span></div>
        </div>
        <div class="check-list">
          {this.checks.length === 0 && <div class="all-clear"><strong>✓ 未发现问题</strong><p>字幕遮挡、步骤跳级和替代文本检查均已通过。</p></div>}
          {this.checks.map((check) => (
            <button class={`check-item ${check.severity}`} onClick={() => {
              if (check.moduleId) this.selectModule(check.moduleId);
              if (check.stepId) this.selectStep(check.stepId);
              this.activePanel = 'editor';
            }}>
              <span class="check-severity">{check.severity === 'error' ? '!' : check.severity === 'warning' ? '△' : 'i'}</span>
              <span><strong>{check.title}</strong><small>{check.detail}</small></span>
              <span class="check-arrow">→</span>
            </button>
          ))}
        </div>
      </section>
    );
  }

  // ---------- 复核端视图 ----------

  private renderReviewerSidebar() {
    return (
      <aside class="course-panel">
        <div class="panel-heading"><div><span class="eyebrow">复核清单</span><h2>按步骤编号对账</h2></div></div>
        <div class="module-list">
          {this.project.modules.map((item, moduleIndex) => (
            <section class={`module-card ${this.findStep(this.selectedReviewStepId)?.module.id === item.id ? 'active' : ''}`} key={item.id}>
              <div class="module-head readonly">
                <span class="module-color" style={{ background: item.color }} />
                <span><strong>{item.title}</strong><small>{item.steps.length} 个学习步骤 · 只读</small></span>
              </div>
              <div class="step-list">
                {item.steps.map((lesson, stepIndex) => {
                  const record = this.reviewRecordFor(lesson.id);
                  const active = lesson.id === this.selectedReviewStepId;
                  return (
                    <button class={`step-list-item review-row ${active ? 'active' : ''}`} onClick={() => this.selectReviewStep(lesson.id)}>
                      <span class="step-index">{moduleIndex + 1}-{String(stepIndex + 1).padStart(2, '0')}</span>
                      <span class="step-copy">
                        <strong>{lesson.title}</strong>
                        <small>{lesson.kind} · {lesson.duration}s · {lesson.difficulty}</small>
                        {this.renderReviewBadge(lesson.id)}
                      </span>
                      {record?.stale && <span class="step-issue-count warn" title="编排端改过，结论待重新确认">改</span>}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {this.review.records.some((record) => record.orphan) && (
            <section class="module-card orphan-card">
              <div class="module-head readonly"><span class="module-color" style={{ background: '#9a6a3f' }} /><span><strong>编排端已删除的步骤</strong><small>结论仍保留，可移除</small></span></div>
              <div class="step-list">
                {this.review.records.filter((record) => record.orphan).map((record) => (
                  <button class={`step-list-item review-row ${record.stepId === this.selectedReviewStepId ? 'active' : ''}`} onClick={() => this.selectReviewStep(record.stepId)}>
                    <span class="step-index">{record.stepNo}</span>
                    <span class="step-copy"><strong>{record.stepTitle}</strong><small>{this.renderReviewBadge(record.stepId)}</small></span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </aside>
    );
  }

  private renderWorklist() {
    const step = this.currentReviewStep;
    const record = this.currentReviewRecord;
    const draft = this.reviewDraftFor(this.selectedReviewStepId);
    const total = this.review.records.length;
    const confirmedCount = this.review.records.filter((item) => item.confirmed && !item.stale).length;
    const pendingCount = this.review.records.filter((item) => !item.confirmed || item.stale).length;
    return (
      <div class="reviewer-work">
        <div class="review-summary-cards">
          <div class="review-stat"><strong>{total}</strong><span>已记结论</span></div>
          <div class="review-stat ok"><strong>{confirmedCount}</strong><span>已确认</span></div>
          <div class="review-stat warn"><strong>{pendingCount}</strong><span>退回/待确认</span></div>
          <div class="review-stat"><strong>{this.review.pendingOps.length}</strong><span>离线待补推</span></div>
        </div>

        <section class="form-card course-return-card">
          <div class="section-title"><span>退</span><div><h2>整门课程退回说明</h2><p>复核端持有，与编排端课程内容分开保存</p></div></div>
          <div class="course-return-row">
            <ion-textarea autoGrow label="退回意见（可空，空表示不整课退回）" labelPlacement="stacked" class="studio-input" value={this.courseReturnDraft} onIonInput={(event) => { this.courseReturnDraft = event.detail.value ?? ''; }} placeholder="例如：多个模块字幕遮挡动作，整体退回修改。" />
            <ion-button class="studio-button" color="danger" fill="outline" onClick={() => this.saveCourseReturn()}>保存退回说明</ion-button>
          </div>
          {this.review.courseReturn && <p class="course-return-meta">最近退回：{this.review.courseReturn.reason} · {this.formatDate(this.review.courseReturn.at)}</p>}
        </section>

        {!step && record?.orphan ? this.renderOrphanRecord(record) : step ? (
          <section class="form-card step-review-card">
            <div class="section-title">
              <span>{buildStepIndex(this.project).get(step.id)?.stepNo ?? ''}</span>
              <div class="step-review-head">
                <h2>{step.title}</h2>
                <p>{step.kind} · {step.duration}s · {step.difficulty} · 步骤编号 {buildStepIndex(this.project).get(step.id)?.stepNo}</p>
                {record && <div class={`record-state ${record.verdict} ${record.stale || !record.confirmed ? 'stale' : ''}`}>
                  现存结论：{verdictLabel(record.verdict)} · {record.confirmed ? (record.stale ? '编排端改过，待重新确认' : '已确认') : '退回未确认'}
                </div>}
              </div>
            </div>

            {record?.stale && (
              <div class="stale-callout">
                <strong>编排端改过这一步</strong>
                <span>原结论已退回为未确认并保留在列表中；请对照最新课程内容重新给出结论。</span>
              </div>
            )}

            <div class="verdict-switch">
              <button class={draft.verdict === 'approved' ? 'active approved' : ''} onClick={() => this.patchReviewDraft(step.id, { verdict: 'approved' })}>✓ 结论：通过</button>
              <button class={draft.verdict === 'returned' ? 'active returned' : ''} onClick={() => this.patchReviewDraft(step.id, { verdict: 'returned' })}>↩ 结论：退回</button>
            </div>
            <ion-textarea autoGrow label="退回意见（通过时可空）" labelPlacement="stacked" class="studio-input" value={draft.comment} onIonInput={(event) => this.patchReviewDraft(step.id, { comment: event.detail.value ?? '' })} placeholder="写明要老师改哪里，例如：字幕与俯拍手部镜头重叠。" />
            <div class="review-action-row">
              <ion-button class="studio-button" onClick={() => this.saveReviewOpinion()}>{this.offline ? '离线暂存意见' : '保存结论与意见'}</ion-button>
              <ion-button class="studio-button" fill="outline" color="success" disabled={!record} onClick={() => this.confirmReviewOpinion(step.id)}>确认该结论</ion-button>
              {record && <ion-button class="studio-button" fill="clear" color="medium" onClick={() => this.removeReviewRecord(step.id)}>移除记录</ion-button>}
            </div>
            {this.offline && <p class="offline-hint">当前离线：意见先记在复核端本机（{this.review.pendingOps.length} 条待补推），网络恢复后按步骤编号自动对账。</p>}
          </section>
        ) : (
          <div class="empty-editor"><div class="empty-glyph">复</div><h2>选择一个学习步骤开始复核</h2><p>在左侧按模块和步骤编号选择，结论与退回意见只保存在复核端。</p></div>
        )}
      </div>
    );
  }

  private renderOrphanRecord(record: StepReview) {
    return (
      <section class="form-card orphan-record-card">
        <div class="section-title"><span>{record.stepNo}</span><div><h2>{record.stepTitle}</h2><p>编排端已删除该步骤，复核记录仍留在列表中</p></div></div>
        <div class={`record-state ${record.verdict}`}>{verdictLabel(record.verdict)} · {record.confirmed ? '已确认' : '未确认'}</div>
        <p class="orphan-comment">{record.comment || '（无退回意见）'}</p>
        <div class="review-action-row">
          <ion-button class="studio-button" fill="outline" color="medium" onClick={() => this.removeReviewRecord(record.stepId)}>移除该记录</ion-button>
        </div>
      </section>
    );
  }

  private renderConflictDual(conflict: ReviewConflict) {
    return (
      <article class="conflict-card" key={conflict.stepId}>
        <header>
          <div><span class="conflict-no">{conflict.stepNo}</span><strong>{conflict.author.title}</strong></div>
          <span class="conflict-time">对账于 {this.formatDate(conflict.detectedAt)}</span>
        </header>
        <div class="conflict-columns">
          <div class="conflict-col author-col">
            <h3>编排端版本（内容认这边）</h3>
            <dl>
              <dt>类型 / 时长 / 难度</dt><dd>{conflict.author.kind} · {conflict.author.duration}s · {conflict.author.difficulty}</dd>
              <dt>字幕</dt><dd>{conflict.author.caption || '（空）'} <small>位置：{conflict.author.captionPosition}</small></dd>
              <dt>手形说明</dt><dd>{conflict.author.handshape}</dd>
              <dt>镜头</dt><dd>{conflict.author.camera}</dd>
              <dt>替代文本</dt><dd>{conflict.author.altText || '（空）'}</dd>
            </dl>
          </div>
          <div class="conflict-col review-col">
            <h3>复核端版本（结论认这边）</h3>
            <dl>
              <dt>结论</dt><dd><span class={`verdict-tag ${conflict.review.verdict}`}>{verdictLabel(conflict.review.verdict)}</span> {conflict.review.confirmed ? '' : '· 退回未确认'}</dd>
              <dt>退回意见</dt><dd>{conflict.review.comment || '（无）'}</dd>
              <dt>复核员</dt><dd>{conflict.review.reviewer}</dd>
              <dt>记录时间</dt><dd>{this.formatDate(conflict.review.updatedAt)}</dd>
            </dl>
          </div>
        </div>
        <footer>
          <span>两版并排保留：请逐条对照，认下编排端最新内容后再确认复核结论。</span>
          <ion-button size="small" class="studio-button" onClick={() => this.acknowledge(conflict.stepId)}>本条已逐条认</ion-button>
        </footer>
      </article>
    );
  }

  private renderMergePanel() {
    const report: SyncReport | undefined = this.review.lastReport;
    const failed = this.review.syncStatus === 'failed';
    return (
      <div class="merge-work">
        <section class={`form-card sync-card ${failed ? 'failed' : 'ok'}`}>
          <div class="sync-head">
            <div>
              <span class="eyebrow">网络恢复后对账</span>
              <h2>{this.offline ? '复核端离线中' : failed ? '上次合并失败，可按侧重试' : '复核端在线'}</h2>
              <p>
                {this.offline
                  ? `${this.review.pendingOps.length} 条意见已记在本机，联网后按步骤编号自动对账。`
                  : report?.message ?? '在线时保存意见会立即对账；也可手动触发。'}
              </p>
              {this.review.lastSyncAt && <small>上次成功对账：{this.formatDate(this.review.lastSyncAt)}</small>}
            </div>
            <div class="sync-actions">
              <ion-button class="studio-button" disabled={this.offline} onClick={() => this.runReconcile('手动对账')}>立即按步骤编号对账</ion-button>
              {failed && <ion-button class="studio-button" fill="outline" color="warning" disabled={this.offline} onClick={() => this.retrySync(this.review.failSide ?? 'reviewer')}>
                按{this.review.failSide === 'author' ? '编排端' : '复核端'}重试
              </ion-button>}
            </div>
          </div>
          {report && (
            <div class="sync-metrics">
              <span><strong>{report.pushedOps}</strong> 补推操作</span>
              <span><strong>{report.conflicts}</strong> 两版并排</span>
              <span><strong>{report.resetToUnconfirmed}</strong> 退回未确认</span>
              <span><strong>{report.protectedConfirmed}</strong> 已确认结论受保护</span>
              <span><strong>{report.orphans}</strong> 孤儿记录</span>
            </div>
          )}
          <div class="fault-box">
            <label>合并失败模拟（用于演练按侧重试）：</label>
            {([['none', '不失败'], ['author', '编排端侧失败'], ['reviewer', '复核端侧失败']] as Array<[FaultSide, string]>).map(([value, label]) => (
              <button class={this.fault === value ? 'active' : ''} onClick={() => { this.fault = value; }}>{label}</button>
            ))}
          </div>
        </section>

        <section class="form-card queue-card">
          <div class="section-title"><span>队</span><div><h2>待补推的复核操作（{this.review.pendingOps.length}）</h2><p>离线期间记在本机，对账成功后清空；失败时保留以便重试</p></div></div>
          {this.review.pendingOps.length === 0 ? <p class="queue-empty">没有待补推操作。</p> : (
            <ul class="op-queue">
              {this.review.pendingOps.map((op, index) => {
                const opLabel = op.type === 'upsert' ? '记结论' : op.type === 'confirm' ? '确认' : op.type === 'ack' ? '逐条认' : op.type === 'remove' ? '移除' : '整课退回';
                const target = op.type === 'course-return'
                  ? (op.reason || '清空退回')
                  : ('stepNo' in op && op.stepNo !== '—' ? `步骤 ${op.stepNo}` : `步骤 ${op.stepId}`);
                return (
                  <li key={index}><span class="op-type">{opLabel}</span>
                    <span>{target}</span>
                    <small>{this.formatDate(op.at)}</small></li>
                );
              })}
            </ul>
          )}
        </section>

        <section class="conflicts-section">
          <div class="section-title"><span>撞</span><div><h2>两版并排待逐条认（{this.review.conflicts.length}）</h2><p>同一步骤两边都动过：内容认编排端、结论认复核端</p></div></div>
          {this.review.conflicts.length === 0
            ? <div class="all-clear"><strong>✓ 没有待认的两版冲突</strong><p>同一步骤两边都改过的记录会并排留在这里。</p></div>
            : this.review.conflicts.map((conflict) => this.renderConflictDual(conflict))}
        </section>
      </div>
    );
  }

  // ---------- 预览（两端共用、复核端只读） ----------

  private renderPreview() {
    const step = this.role === 'reviewer' ? this.currentReviewStep : this.currentStep;
    const progress = Math.round(this.playProgress * 100);
    const readonly = this.role === 'reviewer';
    return (
      <section class="preview-panel">
        <div class="preview-head">
          <div><span class="eyebrow">{readonly ? '复核端只读预览' : '学习者预览'}</span><h2>设备与安全区检查</h2></div>
          <ion-segment value={this.previewSize} class="studio-segment" onIonChange={(event) => { this.previewSize = event.detail.value as PreviewSize; }}>
            <ion-segment-button value="phone">手机</ion-segment-button>
            <ion-segment-button value="tablet">平板</ion-segment-button>
          </ion-segment>
        </div>
        {step ? (
          <div class={`device-frame ${this.previewSize}`}>
            <div class="device-top"><span>{this.previewSize === 'phone' ? '9:16' : '4:3'}</span><span>{step.camera}</span></div>
            <div class={`preview-stage zone-${step.gestureZone} caption-${step.captionPosition.replace(/\s|%/g, '')} ${step.captionPosition === '画面中央' && step.gestureZone === '中央' ? 'overlap-warning' : ''}`}>
              <div class="stage-grid" />
              <div class="signer">
                <div class="head"><span class="face"><i /><i /></span></div>
                <div class="torso" />
                <div class="arm arm-left"><span class="hand" /></div>
                <div class="arm arm-right"><span class="hand" /></div>
              </div>
              <div class="gesture-marker" style={{ left: step.gestureZone === '左侧' ? '18%' : step.gestureZone === '右侧' ? '70%' : '43%' }} />
              <div class="caption-preview">{step.caption || '未填写字幕'}</div>
              {step.captionPosition === '角标提示' && <div class="corner-caption">{step.caption.slice(0, 18) || '角标提示'}</div>}
              <div class="safe-area"><span>字幕安全区</span></div>
            </div>
            <div class="player-controls">
              <button class="play-button" onClick={() => this.togglePlay()}>{this.playing ? 'Ⅱ' : '▶'}</button>
              <div class="player-timeline">
                <span style={{ width: `${progress}%` }} />
                {step.cuePoints.map((cue) => <i style={{ left: `${Math.min(100, (cue / Math.max(1, step.duration)) * 100)}%` }} title={`检查点 ${cue}s`} />)}
              </div>
              <span class="time-code">{String(Math.floor(this.playProgress * step.duration)).padStart(2, '0')} / {step.duration}s</span>
            </div>
            <div class="preview-meta">
              <div><strong>{step.kind}</strong><span>步骤类型</span></div>
              <div><strong>{step.difficulty}</strong><span>难度标签</span></div>
              <div><strong>{step.cuePoints.length}</strong><span>检查点</span></div>
            </div>
            <p class="preview-caption-text">{step.caption}</p>
          </div>
        ) : <div class="empty-preview">选择步骤后显示设备预览。</div>}
      </section>
    );
  }

  // ---------- 框架 ----------

  private renderRoleSwitch() {
    return (
      <div class="role-switch">
        <button class={this.role === 'author' ? 'active' : ''} onClick={() => this.switchRole('author')}>编排端 · 教师</button>
        <button class={this.role === 'reviewer' ? 'active' : ''} onClick={() => this.switchRole('reviewer')}>复核端 · 复核员</button>
      </div>
    );
  }

  private renderAuthorRibbon(moduleCount: number, stepCount: number, minutes: number, errors: number) {
    return (
      <div class="project-ribbon">
        <div class="project-heading">
          {this.renderStatusBadge()}
          <ion-input value={this.project.title} class="project-title-input" onIonInput={(event) => { this.project = { ...this.project, title: event.detail.value ?? '' }; this.persistAuthor(); }} />
          <span>{this.project.teacher} · {this.project.audience}</span>
        </div>
        <div class="project-metrics">
          <div><strong>{moduleCount}</strong><span>模块</span></div>
          <div><strong>{stepCount}</strong><span>步骤</span></div>
          <div><strong>{minutes}</strong><span>分钟</span></div>
          <div class={errors ? 'has-errors' : ''}><strong>{errors}</strong><span>阻断问题</span></div>
        </div>
        <div class="workflow-actions">
          {this.project.status === 'draft' && <ion-button fill="clear" class="studio-button" onClick={() => this.addModule()}>＋ 新建模块</ion-button>}
          <ion-button fill="clear" class="studio-button" onClick={() => this.addStep('练习')}>＋ 练习步骤</ion-button>
        </div>
      </div>
    );
  }

  private renderReviewerRibbon(moduleCount: number, stepCount: number, minutes: number) {
    const pending = this.review.pendingOps.length;
    const conflicts = this.review.conflicts.length;
    return (
      <div class="project-ribbon reviewer">
        <div class="project-heading">
          <ion-badge color={this.offline ? 'medium' : 'success'}>{this.offline ? '离线记录中' : '在线对账'}</ion-badge>
          <div class="reviewer-course-title">{this.project.title}</div>
          <span>复核员：{this.review.reviewerName} · 课程内容只读，结论与意见在复核端独立保存</span>
        </div>
        <div class="project-metrics">
          <div><strong>{moduleCount}</strong><span>模块</span></div>
          <div><strong>{stepCount}</strong><span>步骤</span></div>
          <div><strong>{minutes}</strong><span>分钟</span></div>
          <div><strong>{this.review.records.length}</strong><span>已记结论</span></div>
        </div>
        <div class="workflow-actions">
          {pending > 0 && <ion-badge color="warning" class="queue-badge">{pending} 条待补推</ion-badge>}
          {conflicts > 0 && <ion-badge color="danger" class="queue-badge" onClick={() => { this.reviewerPanel = 'merge'; }}>{conflicts} 处两版待认</ion-badge>}
        </div>
      </div>
    );
  }

  render() {
    const isReviewer = this.role === 'reviewer';
    const errors = this.checks.filter((check) => check.severity === 'error').length;
    const moduleCount = this.project.modules.length;
    const stepCount = this.project.modules.reduce((sum, item) => sum + item.steps.length, 0);
    const minutes = Math.ceil(this.project.modules.reduce((sum, item) => sum + item.steps.reduce((total, lesson) => total + lesson.duration, 0), 0) / 60);
    const module = this.currentModule;

    return (
      <Host>
        <ion-app>
          <ion-header class="studio-header">
            <ion-toolbar>
              <ion-buttons slot="start"><div class="logo-mark">手</div><div class="app-title"><strong>SignCourse Studio</strong><span>手语课程编排工具</span></div></ion-buttons>
              <ion-buttons slot="end" class="header-actions">
                {this.renderRoleSwitch()}
                <button class={`connection-status ${this.offline ? 'offline' : ''}`} onClick={() => this.toggleOffline()}><span />{this.offline ? '离线（点击恢复网络）' : '在线（点击模拟断网）'}</button>
                {!isReviewer && <ion-button fill="clear" class="studio-button" disabled={this.past.length === 0} onClick={() => this.undo()}>撤销</ion-button>}
                {!isReviewer && <ion-button fill="clear" class="studio-button" disabled={this.future.length === 0} onClick={() => this.redo()}>重做</ion-button>}
                {!isReviewer && <ion-button fill="outline" class="studio-button" onClick={() => this.saveDraft()}>保存草稿</ion-button>}
                {!isReviewer && (this.project.status === 'review'
                  ? <ion-button color="success" class="studio-button" onClick={() => this.freezeVersion()}>冻结版本</ion-button>
                  : this.project.status === 'changes'
                    ? <ion-button color="warning" class="studio-button" onClick={() => this.submitForReview()}>重新提交</ion-button>
                    : this.project.status === 'frozen'
                      ? <ion-button class="studio-button" onClick={() => this.reviseFrozen()}>创建修订版</ion-button>
                      : <ion-button color="primary" class="studio-button" onClick={() => this.submitForReview()}>提交复核</ion-button>)}
                {isReviewer && <ion-button fill="outline" class="studio-button" disabled={this.offline} onClick={() => this.runReconcile('手动对账')}>立即对账</ion-button>}
              </ion-buttons>
            </ion-toolbar>
          </ion-header>

          <ion-content fullscreen>
            {isReviewer
              ? this.renderReviewerRibbon(moduleCount, stepCount, minutes)
              : this.renderAuthorRibbon(moduleCount, stepCount, minutes, errors)}

            {!isReviewer && this.review.courseReturn && (
              <div class="course-return-banner">
                <strong>复核端整课退回：</strong>{this.review.courseReturn.reason}
                <span class="course-return-time">{this.formatDate(this.review.courseReturn.at)}</span>
              </div>
            )}

            <main class="studio-workspace">
              {isReviewer ? this.renderReviewerSidebar() : (
                <aside class="course-panel">
                  <div class="panel-heading"><div><span class="eyebrow">课程结构</span><h2>模块与步骤</h2></div><button class="add-step-button" onClick={() => this.addStep('示范')}>＋</button></div>
                  <div class="module-list">
                    {this.project.modules.map((item) => (
                      <section class={`module-card ${item.id === module?.id ? 'active' : ''}`} key={item.id}>
                        <button class="module-head" onClick={() => this.selectModule(item.id)}>
                          <span class="module-color" style={{ background: item.color }} />
                          <span><strong>{item.title}</strong><small>{item.steps.length} 个学习步骤</small></span>
                        </button>
                        {item.id === module?.id && <div class="step-list">{item.steps.map((lesson, index) => this.renderStepListItem(lesson, index))}</div>}
                      </section>
                    ))}
                  </div>
                  <div class="module-editor">
                    <ion-input disabled={this.project.status === 'frozen'} label="当前模块标题" labelPlacement="stacked" class="studio-input" value={module?.title ?? ''} onIonInput={(event) => this.updateCurrentModule({ title: event.detail.value ?? '' })} />
                    <ion-textarea disabled={this.project.status === 'frozen'} autoGrow label="模块目标" labelPlacement="stacked" class="studio-input" value={module?.summary ?? ''} onIonInput={(event) => this.updateCurrentModule({ summary: event.detail.value ?? '' })} />
                  </div>
                </aside>
              )}

              <section class="editor-panel">
                {isReviewer ? (
                  <div class="panel-switcher">
                    <button class={this.reviewerPanel === 'worklist' ? 'active' : ''} onClick={() => { this.reviewerPanel = 'worklist'; }}>逐条复核</button>
                    <button class={this.reviewerPanel === 'merge' ? 'active' : ''} onClick={() => { this.reviewerPanel = 'merge'; }}>对账合并 <span class={this.review.conflicts.length ? 'danger-dot' : ''}>{this.review.conflicts.length}</span></button>
                  </div>
                ) : (
                  <div class="panel-switcher">
                    <button class={this.activePanel === 'editor' ? 'active' : ''} onClick={() => { this.activePanel = 'editor'; }}>步骤编排</button>
                    <button class={this.activePanel === 'checks' ? 'active' : ''} onClick={() => { this.activePanel = 'checks'; }}>发布前检查 <span>{this.checks.length}</span></button>
                  </div>
                )}
                <div class="editor-scroll">
                  {isReviewer
                    ? (this.reviewerPanel === 'worklist' ? this.renderWorklist() : this.renderMergePanel())
                    : (this.activePanel === 'editor' ? this.renderStepEditor() : this.renderChecks())}
                </div>
              </section>

              {this.renderPreview()}
            </main>
          </ion-content>
          <ion-toast isOpen={Boolean(this.toast)} message={this.toast?.message} color={this.toast?.color} duration={3600} onDidDismiss={() => { this.toast = undefined; }} />
        </ion-app>
      </Host>
    );
  }
}
