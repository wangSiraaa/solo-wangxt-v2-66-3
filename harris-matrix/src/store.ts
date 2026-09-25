import { computed, reactive } from 'vue'
import { db } from './db'
import { cyclePathIfAdded, layeredPositions, reachablePairs, redundantEdges, type OrderEdge } from './graph'
import { componentsOf, computePhaseModel, type ContemporaryPair, type PhaseEngineInput } from './phase'
import { buildSample } from './sample'
import type {
  Batch,
  Evidence,
  Mutation,
  Phase,
  PhaseAssignment,
  PhaseComputation,
  PhaseConstraint,
  PhaseDiagnostic,
  ProjectExport,
  Relation,
  RelationDraft,
  Retraction,
  StratUnit,
  TableName,
  UnitPhaseInterval,
  UnitPosition,
  UnitType,
} from './types'

export const state = reactive({
  loaded: false,
  units: [] as StratUnit[],
  positions: {} as Record<string, UnitPosition>,
  relations: [] as Relation[],
  evidences: [] as Evidence[],
  retractions: [] as Retraction[],
  batches: [] as Batch[],
  phases: [] as Phase[],
  phaseConstraints: [] as PhaseConstraint[],
  /** 层位 → 阶段分配（一个层位至多一个阶段） */
  phaseAssignments: {} as Record<string, PhaseAssignment>,
  /** 当前各层位的阶段区间（按 unitId 索引；未受重算影响的层位沿用旧结果） */
  phaseIntervals: {} as Record<string, UnitPhaseInterval>,
  phaseDiagnostics: [] as PhaseDiagnostic[],
  /** 推演计算版本（按时间升序，最后一个为当前版本） */
  phaseComputations: [] as PhaseComputation[],
  viewMode: 'raw' as 'raw' | 'simplified',
  selectedUnitId: null as string | null,
  /** 待确认的成环关系：记录员可选择保留为矛盾记录或取消 */
  pendingCycle: null as { draft: RelationDraft; path: string[] } | null,
  toast: '',
  /** 自增以通知画布重排（身份与位置分离，位置变化不触发数据刷新） */
  layoutVersion: 0,
})

/* ---------- 派生数据 ---------- */

export const activeRelations = computed(() => state.relations.filter((r) => r.status === 'active'))

/** 仅“早于”关系进入有向图；同期关联被明确排除 */
export const orderEdges = computed<OrderEdge[]>(() =>
  activeRelations.value.filter((r) => r.kind === 'earlier').map((r) => ({ id: r.id, from: r.from, to: r.to })),
)

/** 简化视图要隐藏的传递冗余边（只隐藏，不删除） */
export const redundantIds = computed(() => redundantEdges(orderEdges.value))

export const lastBatch = computed(() => {
  for (let i = state.batches.length - 1; i >= 0; i--) {
    if (!state.batches[i].undone) return state.batches[i]
  }
  return null
})

export function unitLabel(id: string): string {
  return state.units.find((u) => u.id === id)?.label ?? id
}

export function evidenceRef(id: string): string {
  return state.evidences.find((e) => e.id === id)?.ref ?? id
}

export function phaseLabel(id: string): string {
  return state.phases.find((p) => p.id === id)?.label ?? id
}

/** 当前推演版本（最后一个）；无阶段体系时为 null */
export const currentPhaseComputation = computed(() => state.phaseComputations[state.phaseComputations.length - 1] ?? null)

/* ---------- 基础工具 ---------- */

const uid = () => crypto.randomUUID()

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(msg: string) {
  state.toast = msg
  if (typeof window === 'undefined') return
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (state.toast = ''), 4000)
}

function tableOf(name: TableName) {
  return {
    units: db.units,
    positions: db.positions,
    relations: db.relations,
    evidences: db.evidences,
    retractions: db.retractions,
    phases: db.phases,
    phaseConstraints: db.phaseConstraints,
    phaseAssignments: db.phaseAssignments,
  }[name]
}

/** 写入 IndexedDB 前去除 Vue 响应式代理（structuredClone 无法克隆 Proxy） */
function plain<T>(v: T): T {
  return v == null ? v : JSON.parse(JSON.stringify(v))
}

async function applyForward(m: Mutation) {
  const t = tableOf(m.table)
  if (m.after == null) await t.delete(m.key)
  else await t.put(plain(m.after) as never)
}

async function applyInverse(m: Mutation) {
  const t = tableOf(m.table)
  if (m.before == null) await t.delete(m.key)
  else await t.put(plain(m.before) as never)
}

export async function refresh() {
  const [units, positions, relations, evidences, retractions, batches, phases, phaseConstraints, phaseAssignments, phaseResults, phaseDiagnostics, phaseComputations] =
    await Promise.all([
      db.units.toArray(),
      db.positions.toArray(),
      db.relations.toArray(),
      db.evidences.toArray(),
      db.retractions.toArray(),
      db.batches.orderBy('at').toArray(),
      db.phases.toArray(),
      db.phaseConstraints.toArray(),
      db.phaseAssignments.toArray(),
      db.phaseResults.toArray(),
      db.phaseDiagnostics.toArray(),
      db.phaseComputations.orderBy('at').toArray(),
    ])
  state.units = units.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  state.positions = Object.fromEntries(positions.map((p) => [p.unitId, p]))
  state.relations = relations.sort((a, b) => a.createdAt - b.createdAt)
  state.evidences = evidences.sort((a, b) => a.createdAt - b.createdAt)
  state.retractions = retractions.sort((a, b) => a.at - b.at)
  state.batches = batches
  state.phases = phases.sort((a, b) => a.createdAt - b.createdAt)
  state.phaseConstraints = phaseConstraints.sort((a, b) => a.createdAt - b.createdAt)
  state.phaseAssignments = Object.fromEntries(phaseAssignments.map((a) => [a.unitId, a]))
  state.phaseIntervals = Object.fromEntries(phaseResults.map((r) => [r.unitId, r]))
  state.phaseDiagnostics = phaseDiagnostics.sort((a, b) => a.createdAt - b.createdAt)
  state.phaseComputations = phaseComputations
  state.loaded = true
}

/** 会影响阶段推演的表：关系 / 层位 / 阶段 / 阶段约束 / 分配 */
const PHASE_RELEVANT_TABLES: TableName[] = ['relations', 'units', 'phases', 'phaseConstraints', 'phaseAssignments']

interface GraphSnapshot {
  unitIds: string[]
  orderEdges: OrderEdge[]
  contemporary: ContemporaryPair[]
}

function snapshotGraph(): GraphSnapshot {
  return {
    unitIds: state.units.map((u) => u.id),
    orderEdges: orderEdges.value,
    contemporary: activeRelations.value
      .filter((r) => r.kind === 'contemporary')
      .map((r) => ({ id: r.id, a: r.from, b: r.to })),
  }
}

/**
 * 从批次变更推算受影响的层位集合：变更触及的层位在新旧图中的连通分量之并。
 * 区间推演在不同分量间互不影响，因此分量外的层位结果保持原样（增量重算）。
 * 阶段或阶段约束变更影响全局，返回 'all'；与推演无关的变更返回 null。
 */
function affectedFromMutations(mutations: Mutation[], pre: GraphSnapshot): Set<string> | 'all' | null {
  let touched: Set<string> | null = null
  for (const m of mutations) {
    if (m.table === 'phases' || m.table === 'phaseConstraints') return 'all'
    if (!PHASE_RELEVANT_TABLES.includes(m.table)) continue
    touched ??= new Set<string>()
    for (const row of [m.before, m.after]) {
      if (!row) continue
      if (m.table === 'relations') {
        const r = row as Relation
        touched.add(r.from)
        touched.add(r.to)
      } else if (m.table === 'phaseAssignments') {
        touched.add((row as PhaseAssignment).unitId)
      } else {
        touched.add((row as StratUnit).id)
      }
    }
  }
  if (!touched || state.phases.length === 0) return null
  const post = snapshotGraph()
  const preComps = componentsOf(pre.unitIds, pre.orderEdges, pre.contemporary)
  const postComps = componentsOf(post.unitIds, post.orderEdges, post.contemporary)
  const affected = new Set<string>()
  for (const t of touched) {
    for (const u of preComps.get(t) ?? []) affected.add(u)
    for (const u of postComps.get(t) ?? []) affected.add(u)
  }
  return affected
}

/** 以批次执行一组变更：全部正向应用后登记批次，供整体撤销；随后按需增量重算阶段区间 */
async function runBatch(label: string, mutations: Mutation[]) {
  if (mutations.length === 0) return
  const relevant = mutations.some((m) => PHASE_RELEVANT_TABLES.includes(m.table))
  const pre = relevant ? snapshotGraph() : null
  for (const m of mutations) await applyForward(m)
  const batch: Batch = { id: uid(), label, at: Date.now(), undone: false, mutations }
  await db.batches.put(plain(batch))
  await refresh()
  if (pre) {
    const affected = affectedFromMutations(mutations, pre)
    if (affected) await recomputePhases(label, affected)
  }
}

/** 撤销最近一个未撤销的批次：关系与证据引用随逆向变更一起恢复，阶段区间同步重算 */
export async function undo() {
  const batch = [...state.batches].reverse().find((b) => !b.undone)
  if (!batch) {
    toast('没有可撤销的操作')
    return
  }
  const relevant = batch.mutations.some((m) => PHASE_RELEVANT_TABLES.includes(m.table))
  const pre = relevant ? snapshotGraph() : null
  for (const m of [...batch.mutations].reverse()) await applyInverse(m)
  await db.batches.update(batch.id, { undone: true })
  await refresh()
  if (pre) {
    const affected = affectedFromMutations(batch.mutations, pre)
    if (affected) await recomputePhases(`撤销：${batch.label}`, affected)
  }
  toast(`已撤销：${batch.label}`)
}

/* ---------- 层位 ---------- */

export async function addUnit(label: string, type: UnitType, note: string) {
  label = label.trim()
  if (!label) return
  if (state.units.some((u) => u.label === label)) {
    toast(`层位 ${label} 已存在`)
    return
  }
  const unit: StratUnit = { id: uid(), label, type, note: note.trim(), createdAt: Date.now() }
  await runBatch(`新增层位 ${label}`, [{ table: 'units', key: unit.id, before: null, after: unit }])
  toast(`已新增层位 ${label}`)
}

export async function deleteUnit(id: string) {
  const unit = state.units.find((u) => u.id === id)
  if (!unit) return
  const mutations: Mutation[] = [{ table: 'units', key: id, before: unit, after: null }]
  const pos = state.positions[id]
  if (pos) mutations.push({ table: 'positions', key: id, before: pos, after: null })
  // 连带删除涉及该层位的关系及其撤销记录（全部记入批次，可整体撤销）
  for (const r of state.relations.filter((r) => r.from === id || r.to === id)) {
    mutations.push({ table: 'relations', key: r.id, before: r, after: null })
    for (const x of state.retractions.filter((x) => x.relationId === r.id)) {
      mutations.push({ table: 'retractions', key: x.id, before: x, after: null })
    }
  }
  // 连带删除该层位的阶段分配
  const asg = state.phaseAssignments[id]
  if (asg) mutations.push({ table: 'phaseAssignments', key: id, before: asg, after: null })
  const relCount = mutations.filter((m) => m.table === 'relations').length
  await runBatch(`删除层位 ${unit.label}（连带 ${relCount} 条关系）`, mutations)
  if (state.selectedUnitId === id) state.selectedUnitId = null
  toast(`已删除层位 ${unit.label}`)
}

/* ---------- 证据 ---------- */

export async function addEvidence(ref: string, text: string) {
  ref = ref.trim()
  if (!ref) return
  const ev: Evidence = { id: uid(), ref, text: text.trim(), createdAt: Date.now() }
  await runBatch(`登记证据 ${ref}`, [{ table: 'evidences', key: ev.id, before: null, after: ev }])
  toast(`已登记证据 ${ref}`)
}

/* ---------- 关系 ---------- */

function makeRelation(draft: RelationDraft, conflict: boolean): Relation {
  return {
    id: uid(),
    from: draft.from,
    to: draft.to,
    kind: draft.kind,
    source: draft.source,
    status: 'active',
    conflict,
    evidenceIds: [...draft.evidenceIds],
    note: draft.note.trim(),
    createdAt: Date.now(),
  }
}

function describe(draft: RelationDraft): string {
  return draft.kind === 'earlier'
    ? `${unitLabel(draft.from)} 早于 ${unitLabel(draft.to)}`
    : `${unitLabel(draft.from)} 与 ${unitLabel(draft.to)} 同期`
}

/**
 * 新增关系。先后关系先做有向成环检测：若成环则挂起并给出完整环路径，
 * 由记录员决定保留为矛盾记录或取消。同期关联不进入有向图，直接保存。
 */
export async function addRelation(draft: RelationDraft, allowConflict = false) {
  if (!draft.from || !draft.to) return
  if (draft.kind === 'earlier' && draft.from === draft.to) {
    toast('层位不能早于其自身')
    return
  }
  const dup = activeRelations.value.some(
    (r) => r.from === draft.from && r.to === draft.to && r.kind === draft.kind,
  )
  if (dup) {
    toast('相同的关系已存在')
    return
  }

  if (draft.kind === 'contemporary') {
    // 同期关联：只存档，不作为有向边参与偏序
    const relation = makeRelation(draft, false)
    await runBatch(`新增同期关联：${describe(draft)}`, [
      { table: 'relations', key: relation.id, before: null, after: relation },
    ])
    toast('已保存同期关联（不进入有向图）')
    return
  }

  const cycle = cyclePathIfAdded(orderEdges.value, draft.from, draft.to)
  if (cycle && !allowConflict) {
    state.pendingCycle = { draft: { ...draft }, path: cycle }
    return
  }
  const relation = makeRelation(draft, cycle !== null)
  await runBatch(
    cycle ? `新增矛盾记录：${describe(draft)}` : `新增先后关系：${describe(draft)}`,
    [{ table: 'relations', key: relation.id, before: null, after: relation }],
  )
  toast(cycle ? '已保存为矛盾记录（成环路径见画布红边）' : '已添加先后关系')
}

/** 确认保留成环关系为矛盾记录 */
export async function confirmCycle() {
  const pending = state.pendingCycle
  if (!pending) return
  state.pendingCycle = null
  await addRelation(pending.draft, true)
}

export function cancelCycle() {
  state.pendingCycle = null
}

/** 撤回判断：关系标记为 retracted，快照与理由单独存入 retractions 表 */
export async function retractRelation(id: string, reason: string) {
  const rel = state.relations.find((r) => r.id === id)
  if (!rel || rel.status !== 'active') return
  const retraction: Retraction = {
    id: uid(),
    relationId: id,
    snapshot: { ...rel },
    reason: reason.trim() || '（未填写理由）',
    at: Date.now(),
  }
  await runBatch(`撤回判断：${unitLabel(rel.from)} → ${unitLabel(rel.to)}`, [
    { table: 'relations', key: id, before: rel, after: { ...rel, status: 'retracted' as const } },
    { table: 'retractions', key: retraction.id, before: null, after: retraction },
  ])
  toast('已撤回，判断与理由已单独存档')
}

/* ---------- 地层阶段与相对年代区间推演 ---------- */

function relationText(id: string): string {
  const r = state.relations.find((x) => x.id === id)
  if (!r) return id
  const base =
    r.kind === 'contemporary' ? `${unitLabel(r.from)} 与 ${unitLabel(r.to)} 同期` : `${unitLabel(r.from)} 早于 ${unitLabel(r.to)}`
  const ev = r.evidenceIds.map(evidenceRef).join('、')
  return ev ? `${base}（证据：${ev}）` : base
}

function phaseEngineInput(): PhaseEngineInput {
  return {
    unitIds: state.units.map((u) => u.id),
    orderEdges: orderEdges.value,
    contemporary: activeRelations.value
      .filter((r) => r.kind === 'contemporary')
      .map((r) => ({ id: r.id, a: r.from, b: r.to })),
    phases: state.phases,
    constraints: state.phaseConstraints,
    assignments: Object.values(state.phaseAssignments),
    fmt: { unit: unitLabel, phase: phaseLabel, relation: relationText },
  }
}

/**
 * 重算阶段区间并持久化一个新计算版本。
 * 只重写受影响（scope 内）且结果确实变化的层位行；其余层位沿用旧结果与旧版本号。
 * 诊断按内容稳定 id 差量更新；全部无变化时不产生新版本（启动/刷新幂等）。
 */
export async function recomputePhases(trigger: string, affected: Set<string> | 'all') {
  // 无阶段体系：清空派生数据（旧工程/清空场景），不产生版本
  if (state.phases.length === 0) {
    if (state.phaseComputations.length > 0 || Object.keys(state.phaseIntervals).length > 0 || state.phaseDiagnostics.length > 0) {
      await Promise.all([db.phaseResults.clear(), db.phaseDiagnostics.clear(), db.phaseComputations.clear()])
      await refresh()
    }
    return
  }
  const alive = new Set(state.units.map((u) => u.id))
  const scope = affected === 'all' ? new Set(alive) : new Set([...affected].filter((u) => alive.has(u)))
  const model = computePhaseModel(phaseEngineInput(), scope)

  const versionId = uid()
  const scopedIds = [...scope].sort()
  const writes: UnitPhaseInterval[] = []
  for (const unitId of scopedIds) {
    const r = model.intervals.get(unitId)
    if (!r) continue
    const prev = state.phaseIntervals[unitId]
    const unchanged =
      prev &&
      prev.earliestPhaseId === r.earliestPhaseId &&
      prev.latestPhaseId === r.latestPhaseId &&
      prev.conflict === r.conflict &&
      prev.feasiblePhaseIds.join(',') === r.feasiblePhaseIds.join(',')
    if (unchanged) continue // 结果未变：保留旧行与其版本号
    writes.push({
      unitId,
      versionId,
      earliestPhaseId: r.earliestPhaseId,
      latestPhaseId: r.latestPhaseId,
      feasiblePhaseIds: r.feasiblePhaseIds,
      conflict: r.conflict,
    })
  }
  const staleUnits = Object.keys(state.phaseIntervals).filter((id) => !alive.has(id))
  const diagnosticIds = model.diagnostics.map((d) => d.id).sort()
  const diagSame = diagnosticIds.join(',') === state.phaseDiagnostics.map((d) => d.id).sort().join(',')
  const lastVersion = state.phaseComputations[state.phaseComputations.length - 1]
  const orderSame = !!lastVersion && lastVersion.phaseOrder.join(',') === model.phaseOrder.join(',')
  if (writes.length === 0 && staleUnits.length === 0 && diagSame && orderSame) return // 无任何变化：不产生新版本

  const version: PhaseComputation = {
    id: versionId,
    // 版本时间严格递增：同一毫秒内连续重算也能稳定排序
    at: Math.max(Date.now(), (lastVersion?.at ?? 0) + 1),
    trigger,
    affectedUnitIds: scopedIds,
    phaseOrder: model.phaseOrder,
    valid: model.valid,
    diagnosticIds,
    approved: false,
    approvedAt: null,
  }
  await db.transaction('rw', [db.phaseResults, db.phaseDiagnostics, db.phaseComputations], async () => {
    if (staleUnits.length > 0) await db.phaseResults.bulkDelete(staleUnits)
    if (writes.length > 0) await db.phaseResults.bulkPut(plain(writes))
    if (!diagSame) {
      const staleDiagIds = state.phaseDiagnostics.filter((d) => !diagnosticIds.includes(d.id)).map((d) => d.id)
      if (staleDiagIds.length > 0) await db.phaseDiagnostics.bulkDelete(staleDiagIds)
      const existing = new Map(state.phaseDiagnostics.map((d) => [d.id, d]))
      const rows: PhaseDiagnostic[] = model.diagnostics.map((d) => ({
        ...d,
        computationId: versionId,
        createdAt: existing.get(d.id)?.createdAt ?? Date.now(), // 首次出现时间保留
      }))
      if (rows.length > 0) await db.phaseDiagnostics.bulkPut(plain(rows))
    }
    await db.phaseComputations.put(plain(version))
  })
  await refresh()
}

/** 启动时若已有阶段体系但尚无计算版本（如旧工程升级后补建阶段），补一次全量推演 */
export async function ensurePhaseComputation() {
  if (state.phases.length === 0) return
  if (state.phaseComputations.length === 0) await recomputePhases('初始化', 'all')
}

/** 新增阶段；可选同时设置前后约束（earlierThanId：新阶段早于它；laterThanId：新阶段晚于它） */
export async function addPhase(label: string, note: string, earlierThanId?: string, laterThanId?: string) {
  label = label.trim()
  if (!label) return
  if (state.phases.some((p) => p.label === label)) {
    toast(`阶段 ${label} 已存在`)
    return
  }
  const phase: Phase = { id: uid(), label, note: note.trim(), createdAt: Date.now() }
  const mutations: Mutation[] = [{ table: 'phases', key: phase.id, before: null, after: phase }]
  if (earlierThanId && state.phases.some((p) => p.id === earlierThanId)) {
    const c: PhaseConstraint = { id: uid(), before: phase.id, after: earlierThanId, createdAt: Date.now() }
    mutations.push({ table: 'phaseConstraints', key: c.id, before: null, after: c })
  }
  if (laterThanId && state.phases.some((p) => p.id === laterThanId)) {
    const c: PhaseConstraint = { id: uid(), before: laterThanId, after: phase.id, createdAt: Date.now() }
    mutations.push({ table: 'phaseConstraints', key: c.id, before: null, after: c })
  }
  await runBatch(`新增阶段 ${label}`, mutations)
  toast(`已新增阶段 ${label}`)
}

/** 删除阶段：连带其约束与指向它的层位分配（记入批次，可整体撤销） */
export async function deletePhase(id: string) {
  const phase = state.phases.find((p) => p.id === id)
  if (!phase) return
  const mutations: Mutation[] = [{ table: 'phases', key: id, before: phase, after: null }]
  for (const c of state.phaseConstraints.filter((c) => c.before === id || c.after === id)) {
    mutations.push({ table: 'phaseConstraints', key: c.id, before: c, after: null })
  }
  for (const a of Object.values(state.phaseAssignments).filter((a) => a.phaseId === id)) {
    mutations.push({ table: 'phaseAssignments', key: a.unitId, before: a, after: null })
  }
  await runBatch(`删除阶段 ${phase.label}`, mutations)
  toast(`已删除阶段 ${phase.label}`)
}

/** 新增阶段前后约束（before 阶段早于 after 阶段）；成环不禁止，由诊断标记 */
export async function addPhaseConstraint(before: string, after: string) {
  if (!before || !after || before === after) {
    toast('阶段约束需选择两个不同阶段')
    return
  }
  if (state.phaseConstraints.some((c) => c.before === before && c.after === after)) {
    toast('相同的阶段约束已存在')
    return
  }
  const c: PhaseConstraint = { id: uid(), before, after, createdAt: Date.now() }
  await runBatch(`新增阶段约束：${phaseLabel(before)} 早于 ${phaseLabel(after)}`, [
    { table: 'phaseConstraints', key: c.id, before: null, after: c },
  ])
  toast('已新增阶段约束')
}

export async function removePhaseConstraint(id: string) {
  const c = state.phaseConstraints.find((x) => x.id === id)
  if (!c) return
  await runBatch(`删除阶段约束：${phaseLabel(c.before)} 早于 ${phaseLabel(c.after)}`, [
    { table: 'phaseConstraints', key: id, before: c, after: null },
  ])
  toast('已删除阶段约束')
}

/** 把层位分配到阶段（phaseId 为 null 表示取消分配） */
export async function assignUnitPhase(unitId: string, phaseId: string | null) {
  const prev = state.phaseAssignments[unitId] ?? null
  if (phaseId && prev?.phaseId === phaseId) return
  if (!phaseId && !prev) return
  const label = unitLabel(unitId)
  const mutations: Mutation[] = phaseId
    ? [
        {
          table: 'phaseAssignments',
          key: unitId,
          before: prev,
          after: { unitId, phaseId, createdAt: prev?.createdAt ?? Date.now() },
        },
      ]
    : [{ table: 'phaseAssignments', key: unitId, before: prev, after: null }]
  await runBatch(phaseId ? `分配层位 ${label} → ${phaseLabel(phaseId)}` : `取消层位 ${label} 的阶段分配`, mutations)
}

/** 把当前推演结果标记为有效；存在未解决诊断时系统阻止标记 */
export async function approveCurrentPhases() {
  const cur = currentPhaseComputation.value
  if (!cur) {
    toast('尚无推演结果')
    return
  }
  if (!cur.valid) {
    toast(`存在 ${cur.diagnosticIds.length} 条未解决的矛盾诊断，无法将该组阶段标记为有效`)
    return
  }
  if (cur.approved) {
    toast('当前结果已标记为有效')
    return
  }
  await db.phaseComputations.update(cur.id, { approved: true, approvedAt: Date.now() })
  await refresh()
  toast('已将当前阶段方案标记为有效')
}

/* ---------- 画布位置（与地层身份分离，不进入撤销批次） ---------- */

export async function savePosition(unitId: string, x: number, y: number) {
  const pos: UnitPosition = { unitId, x, y }
  await db.positions.put(pos)
  state.positions = { ...state.positions, [unitId]: pos }
}

/** 按最长路径分层自动排布（忽略成环边） */
export async function autoLayout() {
  const auto = layeredPositions(
    state.units.map((u) => u.id),
    orderEdges.value,
  )
  for (const [id, p] of auto) await db.positions.put({ unitId: id, x: p.x, y: p.y })
  await refresh()
  state.layoutVersion++
  toast('已按地层早晚自动分层排布')
}

/* ---------- 示例 / 清空 / 导出 / 导入 ---------- */

export async function loadSample() {
  if (state.units.length > 0 && !window.confirm('载入示例将先清空当前工程（不可撤销），继续？')) return
  await clearAll(false)
  const now = Date.now()
  const sample = buildSample(now)
  const positions = layeredPositions(
    sample.units.map((u) => u.id),
    sample.relations.filter((r) => r.kind === 'earlier' && r.status === 'active'),
  )
  const mutations: Mutation[] = []
  for (const u of sample.units) mutations.push({ table: 'units', key: u.id, before: null, after: u })
  for (const e of sample.evidences) mutations.push({ table: 'evidences', key: e.id, before: null, after: e })
  for (const r of sample.relations) mutations.push({ table: 'relations', key: r.id, before: null, after: r })
  for (const x of sample.retractions) mutations.push({ table: 'retractions', key: x.id, before: null, after: x })
  for (const p of sample.phases) mutations.push({ table: 'phases', key: p.id, before: null, after: p })
  for (const c of sample.phaseConstraints) mutations.push({ table: 'phaseConstraints', key: c.id, before: null, after: c })
  for (const a of sample.phaseAssignments) mutations.push({ table: 'phaseAssignments', key: a.unitId, before: null, after: a })
  for (const u of sample.units) {
    const p = positions.get(u.id)
    if (p) mutations.push({ table: 'positions', key: u.id, before: null, after: { unitId: u.id, ...p } })
  }
  await runBatch('载入示例工程', mutations)
  state.layoutVersion++
  toast('示例工程已载入（含切割事件、孤立层位、矛盾记录、已撤销判断与阶段推演）')
}

const ALL_TABLES = [
  db.units,
  db.positions,
  db.relations,
  db.evidences,
  db.retractions,
  db.batches,
  db.phases,
  db.phaseConstraints,
  db.phaseAssignments,
  db.phaseResults,
  db.phaseDiagnostics,
  db.phaseComputations,
]

export async function clearAll(confirm = true) {
  if (confirm && !window.confirm('清空全部工程数据？此操作不可撤销。')) return
  await db.transaction('rw', ALL_TABLES, async () => {
    await Promise.all(ALL_TABLES.map((t) => t.clear()))
  })
  state.selectedUnitId = null
  await refresh()
  if (confirm) toast('工程已清空')
}

export function buildExportData(): ProjectExport {
  return {
    app: 'harris-matrix-workbench',
    version: 2,
    exportedAt: new Date().toISOString(),
    units: state.units,
    positions: Object.values(state.positions),
    relations: state.relations,
    evidences: state.evidences,
    retractions: state.retractions,
    partialOrder: reachablePairs(orderEdges.value),
    phases: state.phases,
    phaseConstraints: state.phaseConstraints,
    phaseAssignments: Object.values(state.phaseAssignments),
    phaseIntervals: Object.values(state.phaseIntervals),
    phaseDiagnostics: state.phaseDiagnostics,
    phaseOrder: currentPhaseComputation.value?.phaseOrder ?? [],
  }
}

export function exportProject() {
  const data = buildExportData()
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `harris-matrix-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  toast(`已导出（偏序闭包 ${data.partialOrder.length} 个可达对，阶段 ${data.phases?.length ?? 0} 个）`)
}

/** 区间签名：用于导入后比对推演结果是否一致 */
function intervalSignature(rows: UnitPhaseInterval[]): string {
  return rows
    .map((r) => `${r.unitId}:${r.earliestPhaseId}>${r.latestPhaseId}:${r.feasiblePhaseIds.join(',')}:${r.conflict}`)
    .sort()
    .join('|')
}

/** 诊断签名：含证据路径全文，用于导入后比对矛盾证据是否一致 */
function diagnosticSignature(rows: Array<Pick<PhaseDiagnostic, 'id' | 'kind' | 'message' | 'path'>>): string {
  return rows
    .map((d) => JSON.stringify([d.id, d.kind, d.message, d.path]))
    .sort()
    .join('|')
}

export interface ImportResult {
  ok: boolean
  message: string
}

/**
 * 导入工程数据（替换当前工程）。阶段派生数据（区间/诊断）不直接采用文件内容，
 * 而是在导入后整体重算，再与文件快照比对：阶段顺序、区间、矛盾证据一致才确认。
 */
export async function importProjectData(data: ProjectExport): Promise<ImportResult> {
  if (data?.app !== 'harris-matrix-workbench' || !Array.isArray(data.units) || !Array.isArray(data.relations)) {
    return { ok: false, message: '导入失败：文件格式不符' }
  }
  await db.transaction('rw', ALL_TABLES, async () => {
    await Promise.all(ALL_TABLES.map((t) => t.clear()))
    await db.units.bulkPut(data.units)
    await db.positions.bulkPut(data.positions ?? [])
    await db.relations.bulkPut(data.relations)
    await db.evidences.bulkPut(data.evidences ?? [])
    await db.retractions.bulkPut(data.retractions ?? [])
    await db.phases.bulkPut(data.phases ?? [])
    await db.phaseConstraints.bulkPut(data.phaseConstraints ?? [])
    await db.phaseAssignments.bulkPut(data.phaseAssignments ?? [])
  })
  await refresh()
  state.layoutVersion++
  await recomputePhases('导入工程', 'all')
  // 偏序一致性校验：重算可达对并与导出快照比对
  const expected = [...(data.partialOrder ?? [])].sort()
  const actual = reachablePairs(orderEdges.value)
  const partialSame = JSON.stringify(expected) === JSON.stringify(actual)
  // 阶段一致性校验：拓扑序、区间、矛盾证据（含路径）
  const phaseProblems: string[] = []
  if ((data.phases?.length ?? 0) > 0 || (data.phaseOrder?.length ?? 0) > 0) {
    if (JSON.stringify(data.phaseOrder ?? []) !== JSON.stringify(currentPhaseComputation.value?.phaseOrder ?? [])) {
      phaseProblems.push('阶段顺序')
    }
    if (intervalSignature(data.phaseIntervals ?? []) !== intervalSignature(Object.values(state.phaseIntervals))) {
      phaseProblems.push('阶段区间')
    }
    if (diagnosticSignature(data.phaseDiagnostics ?? []) !== diagnosticSignature(state.phaseDiagnostics)) {
      phaseProblems.push('矛盾证据')
    }
  }
  const phaseMsg = phaseProblems.length === 0 ? '，阶段顺序/区间/矛盾证据一致' : `，但${phaseProblems.join('、')}与导出时不一致`
  if (!partialSame) return { ok: true, message: '导入完成，但偏序与导出时不一致，请检查数据' }
  return { ok: true, message: `导入完成，偏序校验一致（${actual.length} 个可达对）${phaseMsg}` }
}

export async function importProject(file: File) {
  let data: ProjectExport
  try {
    data = JSON.parse(await file.text())
  } catch {
    toast('导入失败：不是有效的 JSON 文件')
    return
  }
  if (data?.app !== 'harris-matrix-workbench' || !Array.isArray(data.units) || !Array.isArray(data.relations)) {
    toast('导入失败：文件格式不符')
    return
  }
  if (!window.confirm('导入将替换当前工程（不可撤销），继续？')) return
  const result = await importProjectData(data)
  toast(result.message)
}
