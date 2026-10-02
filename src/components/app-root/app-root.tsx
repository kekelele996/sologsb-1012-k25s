import { Component, Host, State, h, Fragment, Listen } from '@stencil/core';
import {
  cloneProject,
  createDemoProject,
  selectedModule,
  selectedStep,
  STORAGE_KEY,
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
  applyReconcile,
  confirmReview,
  contentHash,
  createReviewDraft,
  loadReviewDraft,
  reconcile,
  saveReviewDraft,
  upsertReview,
  type MergeItem,
  type ReconcileOutcome,
  type ReviewDraft,
  type ReviewVerdict,
} from '../../review-store';

type PreviewSize = 'phone' | 'tablet';
type WorkMode = 'orchestration' | 'review';
type MergeFaultSide = 'orchestration' | 'review';

@Component({
  tag: 'app-root',
  styleUrl: 'app-root.css',
  scoped: true,
})
export class AppRoot {
  @State() project: CourseProject = createDemoProject();
  @State() review: ReviewDraft = createReviewDraft('sign-course-project');
  @State() mode: WorkMode = 'orchestration';
  @State() previewSize: PreviewSize = 'phone';
  @State() activePanel: 'editor' | 'checks' = 'editor';
  @State() playing = false;
  @State() playProgress = 0;
  @State() offline = typeof navigator !== 'undefined' ? !navigator.onLine : false;
  @State() toast?: { color: string; message: string };
  @State() showReconcile = false;
  @State() reconcileItems: MergeItem[] = [];
  @State() reconcileFailedSide?: MergeFaultSide;
  @State() reconcileSyncedAt?: string;
  @State() mergeFaults: Record<MergeFaultSide, boolean> = { orchestration: false, review: false };
  private past: CourseProject[] = [];
  private future: CourseProject[] = [];
  private playTimer?: number;

  componentWillLoad(): void {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) this.project = JSON.parse(saved) as CourseProject;
    } catch {
      this.project = createDemoProject();
    }
    // 复核端草稿独立加载，与编排端草稿互不影响
    this.review = loadReviewDraft(this.project.id);
  }

  disconnectedCallback(): void {
    if (this.playTimer) window.clearInterval(this.playTimer);
  }

  @Listen('online', { target: 'window' })
  handleOnline(): void {
    this.offline = false;
    this.showToast('success', '网络已恢复，正在按步骤编号与复核端对账合并。');
    this.runReconcile();
  }

  @Listen('offline', { target: 'window' })
  handleOffline(): void {
    this.offline = true;
    this.showToast('warning', '当前处于离线状态：编排草稿与复核意见仍各自保存在本机，恢复后自动对账。');
  }

  @Listen('keydown', { target: 'window' })
  handleKeyboard(event: KeyboardEvent): void {
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName);
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.saveDraft(true);
      return;
    }
    if (!editing && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      this.moveStep(event.key === 'ArrowUp' ? -1 : 1);
    }
  }

  private get currentModule(): CourseModule {
    return selectedModule(this.project);
  }

  private get currentStep(): LessonStep | undefined {
    return selectedStep(this.project);
  }

  private get checks(): ValidationCheck[] {
    return validateProject(this.project);
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.project));
  }

  private persistReview(): void {
    saveReviewDraft(this.review);
  }

  private get currentReview() {
    const stepId = this.currentStep?.id;
    return stepId ? this.review.reviews[stepId] : undefined;
  }

  /** 某步骤在复核端的实时状态：已确认 / 待确认 / 待重新确认 / 未复核。 */
  private reviewStateFor(stepId: string): 'confirmed' | 'pending' | 'stale' | 'none' {
    const review = this.review.reviews[stepId];
    if (!review) return 'none';
    const hash = contentHashFor(this.project, stepId);
    if (hash !== null && hash !== review.baseHash) return 'stale';
    return review.confirmed ? 'confirmed' : 'pending';
  }

  private get pendingReviewCount(): number {
    return Object.values(this.review.reviews).filter((review) => {
      const hash = contentHashFor(this.project, review.stepId);
      return !review.confirmed || (hash !== null && hash !== review.baseHash);
    }).length;
  }

  private setReviewVerdict(verdict: ReviewVerdict): void {
    const stepId = this.currentStep?.id;
    if (!stepId) return;
    this.review = upsertReview(this.review, this.project, stepId, { verdict });
    this.persistReview();
  }

  private setReviewOpinion(opinion: string): void {
    const stepId = this.currentStep?.id;
    if (!stepId) return;
    this.review = upsertReview(this.review, this.project, stepId, { opinion });
    this.persistReview();
  }

  private setReviewer(reviewer: string): void {
    this.review = { ...this.review, reviewer };
    this.persistReview();
  }

  private confirmCurrentReview(): void {
    const stepId = this.currentStep?.id;
    if (!stepId || !this.review.reviews[stepId]) {
      this.showToast('medium', '请先为该步骤选择复核结论。');
      return;
    }
    this.review = confirmReview(this.review, this.project, stepId);
    this.persistReview();
    this.showToast('success', '复核结论已确认，基准对齐当前编排内容。');
  }

  private openReconcile(): void {
    this.runReconcile();
    this.showReconcile = true;
  }

  private runReconcile(): void {
    const outcome: ReconcileOutcome = reconcile(this.project, this.review, this.mergeFaults);
    if (outcome.ok) {
      this.review = applyReconcile(this.review, outcome);
      this.reconcileItems = outcome.items;
      this.reconcileFailedSide = undefined;
      this.reconcileSyncedAt = outcome.syncedAt;
      this.persistReview();
      const stale = outcome.items.filter((item) => item.status === 'stale').length;
      const conflicts = outcome.items.filter((item) => item.status === 'conflict').length;
      if (conflicts > 0) {
        this.showToast('warning', `对账完成：${conflicts} 条步骤两边都动过，已并排放置，请逐条确认。`);
      } else if (stale > 0) {
        this.showToast('warning', `对账完成：${stale} 条步骤被编排端改动，结论已退回未确认并保留在列表中。`);
      } else {
        this.showToast('success', '对账完成，编排端与复核端已按步骤编号合并。');
      }
    } else {
      this.reconcileItems = [];
      this.reconcileFailedSide = outcome.failedSide;
      this.showToast('danger', `${outcome.failedSide === 'orchestration' ? '编排端' : '复核端'}合并失败，已确认的结论已保留，可按侧重试。`);
    }
  }

  private retryMerge(side: MergeFaultSide): void {
    this.mergeFaults = { ...this.mergeFaults, [side]: false };
    this.showToast('medium', `正在重试${side === 'orchestration' ? '编排端' : '复核端'}合并，已确认结论不会回滚。`);
    window.setTimeout(() => this.runReconcile(), 350);
  }

  private toggleMergeFault(side: MergeFaultSide): void {
    this.mergeFaults = { ...this.mergeFaults, [side]: !this.mergeFaults[side] };
  }

  private confirmMergeItem(stepId: string): void {
    if (!this.review.reviews[stepId]) return;
    this.review = confirmReview(this.review, this.project, stepId);
    this.persistReview();
    this.reconcileItems = this.reconcileItems.map((item) =>
      item.stepId === stepId
        ? { ...item, status: 'ok', contentChanged: false, bothModified: false }
        : item,
    );
    this.showToast('success', '已确认合并：内容认编排端，结论认复核端。');
  }

  private confirmAllMergeItems(): void {
    let draft = this.review;
    for (const item of this.reconcileItems) {
      if (item.review && item.status !== 'ok' && item.status !== 'orphaned') {
        draft = confirmReview(draft, this.project, item.stepId);
      }
    }
    this.review = draft;
    this.persistReview();
    this.reconcileItems = this.reconcileItems.map((item) =>
      item.status === 'orphaned' ? item : { ...item, status: 'ok', contentChanged: false, bothModified: false },
    );
    this.showToast('success', '可合并的结论已全部逐条确认。');
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
    this.persist();
    if (toast) this.showToast('success', toast);
  }

  private undo(): void {
    const previous = this.past.pop();
    if (!previous) return this.showToast('medium', '没有可撤销的修改。');
    this.future = [cloneProject(this.project), ...this.future].slice(0, 80);
    this.project = previous;
    this.persist();
  }

  private redo(): void {
    const next = this.future.shift();
    if (!next) return;
    this.past = [...this.past, cloneProject(this.project)].slice(-80);
    this.project = next;
    this.persist();
  }

  private showToast(color: string, message: string): void {
    this.toast = { color, message };
    window.setTimeout(() => {
      if (this.toast?.message === message) this.toast = undefined;
    }, 3_200);
  }

  private selectModule(moduleId: string): void {
    const module = this.project.modules.find((item) => item.id === moduleId);
    this.project = { ...this.project, selectedModuleId: moduleId, selectedStepId: module?.steps[0]?.id ?? '' };
    this.persist();
  }

  private selectStep(stepId: string): void {
    this.project = { ...this.project, selectedStepId: stepId };
    this.persist();
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
    }), '已删除学习步骤。');
  }

  private moveStep(direction: number): void {
    const stepId = this.currentStep?.id;
    if (!stepId) return;
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => {
        if (module.id !== draft.selectedModuleId) return module;
        const index = module.steps.findIndex((step) => step.id === stepId);
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
    this.persist();
    if (showMessage) this.showToast('success', '草稿已保存在浏览器本地。');
  }

  private submitForReview(): void {
    const blocking = this.checks.filter((check) => check.severity === 'error');
    if (blocking.length) {
      this.activePanel = 'checks';
      this.showToast('danger', `仍有 ${blocking.length} 个阻断问题，修复后才能提交复核。`);
      return;
    }
    this.commit((draft) => ({ ...draft, status: 'review' }), '课程已提交复核。');
  }

  private returnForChanges(): void {
    this.commit((draft) => ({ ...draft, status: 'changes' }), '课程已退回修改。');
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

  private togglePlay(): void {
    if (this.playTimer) {
      window.clearInterval(this.playTimer);
      this.playTimer = undefined;
      this.playing = false;
      return;
    }
    const duration = Math.max(10, this.currentStep?.duration ?? 40);
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

  private renderStatusBadge() {
    if (this.project.status === 'review') return <ion-badge color="warning">待复核</ion-badge>;
    if (this.project.status === 'changes') return <ion-badge color="danger">已退回</ion-badge>;
    if (this.project.status === 'frozen') return <ion-badge color="success">已冻结</ion-badge>;
    return <ion-badge color="medium">草稿</ion-badge>;
  }

  private reviewedCount(module: CourseModule): number {
    return module.steps.filter((step) => this.review.reviews[step.id]).length;
  }

  private renderStepListItem(step: LessonStep, index: number) {
    const active = step.id === this.currentStep?.id;
    const issueCount = this.checks.filter((check) => check.stepId === step.id && check.severity !== 'info').length;
    const reviewState = this.mode === 'review' ? this.reviewStateFor(step.id) : 'none';
    const review = this.mode === 'review' ? this.review.reviews[step.id] : undefined;
    return (
      <button class={`step-list-item ${active ? 'active' : ''}`} onClick={() => this.selectStep(step.id)}>
        <span class="step-index">{String(index + 1).padStart(2, '0')}</span>
        <span class="step-copy">
          <strong>{step.title}</strong>
          <small>{step.kind} · {step.duration}s · {step.difficulty}</small>
        </span>
        {this.mode === 'review' ? (
          <span class={`step-review-state ${reviewState}`}>
            {reviewState === 'confirmed' ? (review?.verdict === 'pass' ? '✓ 通过' : '↩ 退回') : reviewState === 'stale' ? '待重新确认' : reviewState === 'pending' ? '待确认' : '未复核'}
          </span>
        ) : issueCount > 0 ? <span class="step-issue-count">{issueCount}</span> : null}
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

  private renderPreview() {
    const step = this.currentStep;
    const progress = Math.round(this.playProgress * 100);
    return (
      <section class="preview-panel">
        <div class="preview-head">
          <div><span class="eyebrow">学习者预览</span><h2>设备与安全区检查</h2></div>
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

  /** 复核端：每个步骤的结论与退回意见，独立于编排端内容。 */
  private renderReviewPanel() {
    const step = this.currentStep;
    const review = this.currentReview;
    const index = this.currentModule?.steps.findIndex((item) => item.id === step?.id) ?? -1;
    const contentChanged = step ? contentHashFor(this.project, step.id) !== (review?.baseHash ?? '') : false;
    return (
      <section class="review-panel">
        <div class="review-head">
          <div>
            <span class="eyebrow">复核端</span>
            <h2>步骤复核结论</h2>
            <p>结论与退回意见独立保存在复核端草稿，与编排端课程内容分开存储；断网也能记录。</p>
          </div>
          <ion-button class="studio-button reconcile-trigger" onClick={() => this.openReconcile()}>
            对账中心
            {this.pendingReviewCount > 0 && <span class="reconcile-badge">{this.pendingReviewCount}</span>}
          </ion-button>
        </div>

        {step ? (
          <div class="review-form">
            <div class="review-step-info">
              <strong>{step.title}</strong>
              <span>{this.currentModule?.title} · 步骤 {index + 1} · 编号 {step.id}</span>
            </div>

            {contentChanged && review?.confirmed && (
              <div class="review-stale-callout">
                <strong>编排端已修改此步骤内容</strong>
                <span>结论已退回未确认，但仍保留在列表中，重新核对后可再次确认。</span>
              </div>
            )}
            {contentChanged && review && !review.confirmed && (
              <div class="review-stale-callout info">
                <strong>此步骤内容已更新</strong>
                <span>结论仍保留，请核对编排端内容后确认。</span>
              </div>
            )}

            <div class="review-field">
              <span class="field-label">复核结论</span>
              <div class="verdict-group">
                <button class={`verdict-btn pass ${review?.verdict === 'pass' ? 'active' : ''}`} onClick={() => this.setReviewVerdict('pass')}>✓ 通过</button>
                <button class={`verdict-btn return ${review?.verdict === 'return' ? 'active' : ''}`} onClick={() => this.setReviewVerdict('return')}>↩ 退回</button>
              </div>
            </div>

            <div class="review-field">
              <span class="field-label">复核意见 / 退回意见</span>
              <ion-textarea
                autoGrow
                class="studio-input"
                placeholder={review?.verdict === 'return' ? '填写需要退回修改的具体问题……' : '填写复核说明（可空）……'}
                value={review?.opinion ?? ''}
                onIonInput={(event) => this.setReviewOpinion(event.detail.value ?? '')}
              />
            </div>

            <div class="review-field">
              <span class="field-label">复核人</span>
              <ion-input class="studio-input" placeholder="复核人姓名" value={this.review.reviewer} onIonInput={(event) => this.setReviewer(event.detail.value ?? '')} />
            </div>

            <div class="review-confirm-row">
              <div class="review-status">
                {review?.confirmed
                  ? <span class="status-pill confirmed">已确认{review.confirmedAt ? ` · ${this.formatDate(review.confirmedAt)}` : ''}</span>
                  : <span class="status-pill pending">{contentChanged ? '待重新确认' : '未确认'}</span>}
                {review && <span class="review-meta">结论基准 修订号 r{review.baseRevision}</span>}
              </div>
              <ion-button class="studio-button" onClick={() => this.confirmCurrentReview()} disabled={!review}>确认本条结论</ion-button>
            </div>

            <div class="review-merge-hint">
              <strong>对账规则</strong>
              <p>网络恢复后按步骤编号对账：同一步骤两边都动过时，内容认编排端、结论认复核端，两版并排放置逐条确认；合并失败可按侧重试，已确认的结论先保住。</p>
            </div>
          </div>
        ) : (
          <div class="empty-editor">
            <div class="empty-glyph">核</div>
            <h2>选择步骤开始复核</h2>
            <p>在左侧步骤列表中选择一个学习步骤，记录通过或退回结论。</p>
          </div>
        )}
      </section>
    );
  }

  private renderMergeItem(item: MergeItem) {
    const statusMeta: Record<MergeItem['status'], { label: string; cls: string }> = {
      ok: { label: '已确认', cls: 'ok' },
      pending: { label: '待复核', cls: 'pending' },
      stale: { label: '内容已更新 · 待重新确认', cls: 'stale' },
      conflict: { label: '两边都动过 · 待逐条确认', cls: 'conflict' },
      orphaned: { label: '步骤已删除 · 结论保留', cls: 'orphaned' },
    };
    const meta = statusMeta[item.status];
    return (
      <div class={`merge-item status-${meta.cls}`} key={item.stepId}>
        <div class="merge-item-head">
          <div class="merge-item-title">
            <strong>{item.stepTitle}</strong>
            <span>{item.moduleTitle ? `${item.moduleTitle} · ` : ''}编号 {item.stepId}</span>
          </div>
          <span class={`merge-status ${meta.cls}`}>{meta.label}</span>
        </div>

        {item.status === 'conflict' && item.currentStep && item.review && (
          <div class="merge-diff">
            <div class="diff-side orchestration">
              <h4>编排端版本 · 内容</h4>
              <dl>
                <div><dt>标题</dt><dd>{item.currentStep.title}</dd></div>
                <div><dt>类型 / 时长</dt><dd>{item.currentStep.kind} · {item.currentStep.duration}s</dd></div>
                <div><dt>字幕</dt><dd>{item.currentStep.caption || '（未填写）'}</dd></div>
                <div><dt>手形</dt><dd>{item.currentStep.handshape}</dd></div>
                <div><dt>镜头 / 区域</dt><dd>{item.currentStep.camera} · {item.currentStep.gestureZone}</dd></div>
              </dl>
            </div>
            <div class="diff-side review">
              <h4>复核端版本 · 结论</h4>
              <dl>
                <div><dt>结论</dt><dd>{item.review.verdict === 'pass' ? '✓ 通过' : '↩ 退回'}</dd></div>
                <div><dt>意见</dt><dd>{item.review.opinion || '（无）'}</dd></div>
                <div><dt>复核人</dt><dd>{item.review.reviewer || '（未填写）'}</dd></div>
                <div><dt>结论时间</dt><dd>{this.formatDate(item.review.updatedAt)}</dd></div>
              </dl>
            </div>
          </div>
        )}

        {item.status !== 'conflict' && item.review && (
          <div class="merge-summary">
            <span class={`verdict-pill ${item.review.verdict}`}>{item.review.verdict === 'pass' ? '✓ 通过' : '↩ 退回'}</span>
            <span class="merge-opinion">{item.review.opinion || '（无退回意见）'}</span>
            <span class="merge-reviewer">{item.review.reviewer || '未署名'} · {this.formatDate(item.review.updatedAt)}</span>
          </div>
        )}

        {item.status === 'orphaned' && (
          <div class="merge-orphan-note">编排端已删除该步骤，复核结论仍保留在列表中，不会被合并清除。</div>
        )}

        <div class="merge-actions">
          {item.status === 'conflict' && (
            <ion-button size="small" class="studio-button" onClick={() => this.confirmMergeItem(item.stepId)}>确认合并（内容认编排端 · 结论认复核端）</ion-button>
          )}
          {item.status === 'stale' && (
            <ion-button size="small" class="studio-button" onClick={() => this.confirmMergeItem(item.stepId)}>重新确认结论</ion-button>
          )}
          {item.status === 'pending' && item.review && (
            <ion-button size="small" class="studio-button" onClick={() => this.confirmMergeItem(item.stepId)}>确认本条结论</ion-button>
          )}
          {item.status === 'ok' && <span class="merge-done">✓ 已确认</span>}
        </div>
      </div>
    );
  }

  private renderReconcileModal() {
    if (!this.showReconcile) return null;
    return (
      <div class="reconcile-overlay" onClick={() => { this.showReconcile = false; }}>
        <div class="reconcile-modal" onClick={(event) => event.stopPropagation()}>
          <div class="reconcile-head">
            <div>
              <span class="eyebrow">对账中心</span>
              <h2>按步骤编号对账合并</h2>
              <p>网络恢复后自动合并；同一步骤两边都动过时，内容认编排端、结论认复核端，两版并排逐条确认。</p>
            </div>
            <button class="reconcile-close" onClick={() => { this.showReconcile = false; }}>×</button>
          </div>

          <div class="reconcile-toolbar">
            <div class="fault-toggles">
              <span>模拟合并失败：</span>
              <button class={`fault-btn ${this.mergeFaults.orchestration ? 'active' : ''}`} onClick={() => this.toggleMergeFault('orchestration')}>编排端</button>
              <button class={`fault-btn ${this.mergeFaults.review ? 'active' : ''}`} onClick={() => this.toggleMergeFault('review')}>复核端</button>
            </div>
            <ion-button size="small" fill="outline" class="studio-button" onClick={() => this.runReconcile()}>重新对账</ion-button>
          </div>

          {this.reconcileFailedSide ? (
            <div class="reconcile-failed">
              <div class="failed-glyph">!</div>
              <h3>{this.reconcileFailedSide === 'orchestration' ? '编排端' : '复核端'}合并失败</h3>
              <p>已确认的结论已保留，不会回滚或删除。可按侧重试。</p>
              <div class="failed-actions">
                <ion-button class="studio-button" onClick={() => this.retryMerge(this.reconcileFailedSide!)}>
                  重试{this.reconcileFailedSide === 'orchestration' ? '编排端' : '复核端'}合并
                </ion-button>
                <ion-button fill="clear" class="studio-button" onClick={() => { this.showReconcile = false; }}>稍后处理</ion-button>
              </div>
            </div>
          ) : (
            <div class="reconcile-items">
              {this.reconcileItems.length === 0 && <div class="reconcile-empty">暂无可合并的步骤。</div>}
              {this.reconcileItems.map((item) => this.renderMergeItem(item))}
            </div>
          )}

          <div class="reconcile-footer">
            <span>上次对账：{this.reconcileSyncedAt ? this.formatDate(this.reconcileSyncedAt) : '尚未对账'}</span>
            <ion-button size="small" class="studio-button" disabled={this.reconcileItems.every((item) => item.status === 'ok' || item.status === 'orphaned')} onClick={() => this.confirmAllMergeItems()}>全部逐条确认</ion-button>
          </div>
        </div>
      </div>
    );
  }

  render() {
    const module = this.currentModule;
    const errors = this.checks.filter((check) => check.severity === 'error').length;
    return (
      <Host>
        <ion-app>
          <ion-header class="studio-header">
            <ion-toolbar>
              <ion-buttons slot="start"><div class="logo-mark">手</div><div class="app-title"><strong>SignCourse Studio</strong><span>手语课程编排工具</span></div></ion-buttons>
              <ion-buttons slot="end" class="header-actions">
                <button class={`connection-status ${this.offline ? 'offline' : ''}`} onClick={() => { this.offline = !this.offline; this.showToast(this.offline ? 'warning' : 'success', this.offline ? '已进入离线模拟，编辑继续保存在本机。' : '已恢复在线模拟，本地草稿保持同步。'); }}><span />{this.offline ? '离线编辑中（点击恢复）' : '本地自动保存（点击模拟离线）'}</button>
                <ion-button fill="clear" class="studio-button" disabled={this.past.length === 0} onClick={() => this.undo()}>撤销</ion-button>
                <ion-button fill="clear" class="studio-button" disabled={this.future.length === 0} onClick={() => this.redo()}>重做</ion-button>
                <ion-button fill="outline" class="studio-button" onClick={() => this.saveDraft()}>保存草稿</ion-button>
                {this.project.status === 'review'
                  ? <ion-button color="success" class="studio-button" onClick={() => this.freezeVersion()}>冻结版本</ion-button>
                  : this.project.status === 'changes'
                    ? <ion-button color="warning" class="studio-button" onClick={() => this.submitForReview()}>重新提交</ion-button>
                    : this.project.status === 'frozen'
                      ? <ion-button class="studio-button" onClick={() => this.reviseFrozen()}>创建修订版</ion-button>
                      : <ion-button color="primary" class="studio-button" onClick={() => this.submitForReview()}>提交复核</ion-button>}
              </ion-buttons>
            </ion-toolbar>
          </ion-header>

          <ion-content fullscreen>
            <div class="project-ribbon">
              <div class="project-heading">
                {this.renderStatusBadge()}
                <ion-input value={this.project.title} class="project-title-input" onIonInput={(event) => { this.project = { ...this.project, title: event.detail.value ?? '' }; this.persist(); }} />
                <span>{this.project.teacher} · {this.project.audience}</span>
              </div>
              <div class="project-metrics">
                <div><strong>{this.project.modules.length}</strong><span>模块</span></div>
                <div><strong>{this.project.modules.reduce((sum, item) => sum + item.steps.length, 0)}</strong><span>步骤</span></div>
                <div><strong>{Math.ceil(this.project.modules.reduce((sum, item) => sum + item.steps.reduce((total, lesson) => total + lesson.duration, 0), 0) / 60)}</strong><span>分钟</span></div>
                <div class={errors ? 'has-errors' : ''}><strong>{errors}</strong><span>阻断问题</span></div>
              </div>
              <div class="workflow-actions">
                <div class="mode-switcher">
                  <button class={this.mode === 'orchestration' ? 'active' : ''} onClick={() => { this.mode = 'orchestration'; }}>编排端</button>
                  <button class={this.mode === 'review' ? 'active' : ''} onClick={() => { this.mode = 'review'; }}>
                    复核端
                    {this.pendingReviewCount > 0 && <span class="mode-dot">{this.pendingReviewCount}</span>}
                  </button>
                </div>
                {this.mode === 'orchestration' ? (
                  <Fragment>
                    {this.project.status === 'review' && <ion-button fill="clear" color="danger" class="studio-button" onClick={() => this.returnForChanges()}>退回修改</ion-button>}
                    {this.project.status === 'draft' && <ion-button fill="clear" class="studio-button" onClick={() => this.addModule()}>＋ 新建模块</ion-button>}
                    <ion-button fill="clear" class="studio-button" onClick={() => this.addStep('练习')}>＋ 练习步骤</ion-button>
                  </Fragment>
                ) : (
                  <ion-button fill="clear" class="studio-button" onClick={() => this.openReconcile()}>对账中心</ion-button>
                )}
              </div>
            </div>

            <main class="studio-workspace">
              <aside class="course-panel">
                <div class="panel-heading"><div><span class="eyebrow">{this.mode === 'review' ? '复核结构' : '课程结构'}</span><h2>{this.mode === 'review' ? '步骤与结论' : '模块与步骤'}</h2></div>{this.mode === 'orchestration' && <button class="add-step-button" onClick={() => this.addStep('示范')}>＋</button>}</div>
                <div class="module-list">
                  {this.project.modules.map((item) => (
                    <section class={`module-card ${item.id === module?.id ? 'active' : ''}`} key={item.id}>
                      <button class="module-head" onClick={() => this.selectModule(item.id)}>
                        <span class="module-color" style={{ background: item.color }} />
                        <span><strong>{item.title}</strong><small>{item.steps.length} 个学习步骤{this.mode === 'review' ? ` · ${this.reviewedCount(item)} 条结论` : ''}</small></span>
                      </button>
                      {item.id === module?.id && <div class="step-list">{item.steps.map((lesson, index) => this.renderStepListItem(lesson, index))}</div>}
                    </section>
                  ))}
                </div>
                {this.mode === 'orchestration' && (
                  <div class="module-editor">
                    <ion-input disabled={this.project.status === 'frozen'} label="当前模块标题" labelPlacement="stacked" class="studio-input" value={module?.title ?? ''} onIonInput={(event) => this.updateCurrentModule({ title: event.detail.value ?? '' })} />
                    <ion-textarea disabled={this.project.status === 'frozen'} autoGrow label="模块目标" labelPlacement="stacked" class="studio-input" value={module?.summary ?? ''} onIonInput={(event) => this.updateCurrentModule({ summary: event.detail.value ?? '' })} />
                  </div>
                )}
              </aside>

              <section class="editor-panel">
                {this.mode === 'orchestration' ? (
                  <>
                    <div class="panel-switcher">
                      <button class={this.activePanel === 'editor' ? 'active' : ''} onClick={() => { this.activePanel = 'editor'; }}>步骤编排</button>
                      <button class={this.activePanel === 'checks' ? 'active' : ''} onClick={() => { this.activePanel = 'checks'; }}>发布前检查 <span>{this.checks.length}</span></button>
                    </div>
                    <div class="editor-scroll">{this.activePanel === 'editor' ? this.renderStepEditor() : this.renderChecks()}</div>
                  </>
                ) : (
                  <div class="editor-scroll review-scroll">{this.renderReviewPanel()}</div>
                )}
              </section>

              {this.renderPreview()}
            </main>
          </ion-content>
          {this.renderReconcileModal()}
          <ion-toast isOpen={Boolean(this.toast)} message={this.toast?.message} color={this.toast?.color} duration={3200} onDidDismiss={() => { this.toast = undefined; }} />
        </ion-app>
      </Host>
    );
  }
}

/** 取某步骤当前编排端内容的哈希；步骤不存在时返回 null。 */
function contentHashFor(project: CourseProject, stepId: string): string | null {
  for (const module of project.modules) {
    const step = module.steps.find((item) => item.id === stepId);
    if (step) return contentHash(step);
  }
  return null;
}
