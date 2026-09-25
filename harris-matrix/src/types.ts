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

/* ---------- 阶段与相对年代区间 ---------- */

/** 阶段：相对年代框架中的一个时段，本身不带绝对年代 */
export interface Phase {
  id: string
  label: string
  note: string
  createdAt: number
  /** 记录员确认标记：存在涉及该阶段的未解决矛盾时系统拒绝置位/自动撤销 */
  valid: boolean
  validAt: number | null
}

/** 阶段前后约束（可选）：from 阶段早于 to 阶段；全体约束构成阶段偏序 DAG */
export interface PhaseConstraint {
  id: string
  from: string
  to: string
  note: string
  createdAt: number
}

/** 层位 → 阶段分配：一个层位至多属于一个阶段，可改派 */
export interface PhaseAssignment {
  unitId: string
  phaseId: string
  at: number
}

/** 单个层位的推演结果：不能唯一定位时以区间（极小/极大阶段集合）表达 */
export interface UnitInterval {
  unitId: string
  /** 下界证据：必须不晚于本层位的阶段（来自更早层位的分配） */
  lower: string[]
  /** 上界证据：必须不早于本层位的阶段（来自更晚层位的分配） */
  upper: string[]
  /** 未被证据排除的全部阶段（可能世界语义：未被证明违反即可行） */
  feasible: string[]
  /** 可行集合中的极小阶段 = 最早可能所处 */
  earliest: string[]
  /** 可行集合中的极大阶段 = 最晚可能所处 */
  latest: string[]
  /** 可行集合恰含一个阶段时为该阶段 id，否则为 null（显示区间而非单值） */
  exact: string | null
}

/** 层位关系与阶段顺序的矛盾诊断：附完整证据路径，原始关系保留不动 */
export interface PhaseDiagnostic {
  id: string
  kind: 'order-conflict' | 'contemporary-conflict'
  /** 涉及的阶段（沿矛盾阶段路径），用于阻止标记有效 */
  phaseIds: string[]
  /** 证据路径：层位先后链（unitId 序列，沿活跃“早于”关系） */
  unitPath: string[]
  /** 证据路径：阶段先后链（phaseId 序列，沿阶段约束） */
  phasePath: string[]
  /** 证据路径上的关系记录 id（层位链各步对应的活跃关系） */
  relationIds: string[]
  message: string
}

/** 一次计算的结果版本：全量结果快照 + 本次实际重算的层位（增量痕迹） */
export interface ComputationVersion {
  id: string
  at: number
  /** 触发原因（人读） */
  cause: string
  /** 本次实际重算的层位 id；等价于全量时为全部层位 */
  affectedUnitIds: string[]
  results: UnitInterval[]
  diagnostics: PhaseDiagnostic[]
  /** 本次计算依据的层位偏序边快照（供下次增量计算求并集图，删除类变更不遗漏） */
  edgesSnapshot: Array<{ id: string; from: string; to: string }>
  /** 本次计算依据的阶段约束快照 */
  constraintsSnapshot: Array<{ from: string; to: string }>
}

export type TableName =
  | 'units'
  | 'positions'
  | 'relations'
  | 'evidences'
  | 'retractions'
  | 'phases'
  | 'phaseConstraints'
  | 'assignments'

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

/** 导出文件格式：携带偏序闭包与阶段推演快照用于导入校验（v1 文件缺少的字段按空处理） */
export interface ProjectExport {
  app: 'harris-matrix-workbench'
  version: 2
  exportedAt: string
  units: StratUnit[]
  positions: UnitPosition[]
  relations: Relation[]
  evidences: Evidence[]
  retractions: Retraction[]
  /** 活跃“早于”关系的可达对闭包（排序后），导入时重算比对 */
  partialOrder: string[]
  phases: Phase[]
  phaseConstraints: PhaseConstraint[]
  assignments: PhaseAssignment[]
  /** 导出时最新计算版本的结果与诊断快照；导入后重算并逐项比对 */
  phaseSnapshot: { results: UnitInterval[]; diagnostics: PhaseDiagnostic[] } | null
}
