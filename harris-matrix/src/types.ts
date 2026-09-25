/** 层位类型：堆积 / 切割 / 填充 / 界面 */
export type UnitType = 'deposit' | 'cut' | 'fill' | 'interface' | 'other'

/** 关系种类：earlier = 有向先后（from 早于 to）；contemporary = 同期关联（不进入有向图） */
export type RelationKind = 'earlier' | 'contemporary'

/** 关系来源：原始观察 / 推断 */
export type RelationSource = 'observation' | 'inference'

export type RelationStatus = 'active' | 'retracted'

/** 地层身份：与画布位置完全分离 */
export interface StratUnit {
  id: string
  label: string
  type: UnitType
  note: string
  createdAt: number
}

/** 画布位置：独立成表，删除/修改不影响地层身份 */
export interface UnitPosition {
  unitId: string
  x: number
  y: number
}

export interface Relation {
  id: string
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  status: RelationStatus
  /** 与既有记录构成环时被标记为矛盾记录（仍保留为证据） */
  conflict: boolean
  evidenceIds: string[]
  note: string
  createdAt: number
}

/** 原始证据：日记页码、照片号、剖面图编号等，仅保存在本地 IndexedDB */
export interface Evidence {
  id: string
  ref: string
  text: string
  createdAt: number
}

/** 被撤销的判断：单独成表保存快照与理由，不混入活跃关系 */
export interface Retraction {
  id: string
  relationId: string
  snapshot: Relation
  reason: string
  at: number
}

/* ---------- 地层阶段与相对年代区间 ---------- */

/** 阶段：相对年代序列中的一段（如“一期”“二里头文化期”） */
export interface Phase {
  id: string
  label: string
  note: string
  createdAt: number
}

/** 阶段前后约束：before 阶段早于 after 阶段（可选设置，构成阶段偏序） */
export interface PhaseConstraint {
  id: string
  before: string
  after: string
  createdAt: number
}

/** 层位 → 阶段分配：一个层位至多属于一个阶段（主键即 unitId） */
export interface PhaseAssignment {
  unitId: string
  phaseId: string
  createdAt: number
}

/** 单个层位的推演结果：可能处于的最早/最晚阶段区间（不能唯一定位时保留区间） */
export interface UnitPhaseInterval {
  unitId: string
  /** 产生本记录的计算版本 */
  versionId: string
  /** 最早可能阶段；与 latestPhaseId 相同即唯一定位 */
  earliestPhaseId: string | null
  latestPhaseId: string | null
  /** 全部可行阶段（按阶段拓扑序排列）；为空表示层位关系与阶段顺序矛盾 */
  feasiblePhaseIds: string[]
  conflict: boolean
}

/** 一次区间推演的版本记录：只记录实际受影响的层位，未受影响的沿用旧结果 */
export interface PhaseComputation {
  id: string
  at: number
  /** 触发原因（批次标签 / 导入 / 初始化等） */
  trigger: string
  /** 本次实际重算的层位；其余层位结果沿用先前版本 */
  affectedUnitIds: string[]
  /** 阶段拓扑序快照（阶段约束成环时为去环骨架序，valid=false） */
  phaseOrder: string[]
  /** 无未解决诊断时为 true */
  valid: boolean
  diagnosticIds: string[]
  /** 记录员确认该组阶段有效；存在诊断时系统阻止标记 */
  approved: boolean
  approvedAt: number | null
}

/** 诊断证据路径中的一步 */
export interface DiagnosticStep {
  kind: 'relation' | 'contemporary' | 'assignment' | 'constraint'
  refId: string
  text: string
}

/** 阶段推演诊断：层位关系与阶段顺序矛盾等，含可定位的证据路径 */
export interface PhaseDiagnostic {
  /** 由内容派生的稳定 id：重算不产生重复，导入导出可比对 */
  id: string
  kind: 'phase-cycle' | 'order-conflict' | 'contemporary-conflict' | 'empty-interval'
  /** 最近一次检测到它的计算版本 */
  computationId: string
  message: string
  path: DiagnosticStep[]
  /** 首次出现时间（重算保留） */
  createdAt: number
}

export type TableName =
  | 'units'
  | 'positions'
  | 'relations'
  | 'evidences'
  | 'retractions'
  | 'phases'
  | 'phaseConstraints'
  | 'phaseAssignments'

/** 通用变更记录：before/after 支持正向应用与逆向撤销 */
export interface Mutation {
  table: TableName
  key: string
  before: unknown | null
  after: unknown | null
}

/** 一批操作（可整体撤销） */
export interface Batch {
  id: string
  label: string
  at: number
  undone: boolean
  mutations: Mutation[]
}

export interface RelationDraft {
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  evidenceIds: string[]
  note: string
}

/** 导出文件格式：携带偏序闭包用于导入校验；v2 起携带阶段推演数据 */
export interface ProjectExport {
  app: 'harris-matrix-workbench'
  version: 1 | 2
  exportedAt: string
  units: StratUnit[]
  positions: UnitPosition[]
  relations: Relation[]
  evidences: Evidence[]
  retractions: Retraction[]
  /** 活跃“早于”关系的可达对闭包（排序后），导入时重算比对 */
  partialOrder: string[]
  /** v2：阶段、前后约束、层位分配 */
  phases?: Phase[]
  phaseConstraints?: PhaseConstraint[]
  phaseAssignments?: PhaseAssignment[]
  /** v2：当前有效的区间结果与诊断（历史版本不导出） */
  phaseIntervals?: UnitPhaseInterval[]
  phaseDiagnostics?: PhaseDiagnostic[]
  /** v2：阶段拓扑序快照（标签序列），导入后重算比对 */
  phaseOrder?: string[]
}
