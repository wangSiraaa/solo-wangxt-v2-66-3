import { computed, reactive } from 'vue'
import { db } from './db'
import { cyclePathIfAdded, layeredPositions, reachablePairs, redundantEdges, type OrderEdge } from './graph'
import {
  affectedUnits,
  canonicalDiagnostics,
  canonicalResults,
  computeDiagnostics,
  computeUnitIntervals,
  type PhasingInput,
  type RecomputeCause,
} from './phasing'
import { buildSample } from './sample'
import type {
  Batch,
  ComputationVersion,
  Evidence,
  Mutation,
  Phase,
  PhaseAssignment,
  PhaseConstraint,
  PhaseDiagnostic,
  ProjectExport,
  Relation,
  RelationDraft,
  Retraction,
  StratUnit,
  TableName,
  UnitInterval,
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
  /** 以 unitId 为键：一个层位至多分配到一个阶段 */
  assignments: {} as Record<string, PhaseAssignment>,
  versions: [] as ComputationVersion[],
  /** 当前（最新版本）的矛盾诊断 */
  diagnostics: [] as PhaseDiagnostic[],
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

export function phaseLabel(id: string): string {
  return state.phases.find((p) => p.id === id)?.label ?? id
}

export function evidenceRef(id: string): string {
  return state.evidences.find((e) => e.id === id)?.ref ?? id
}

/* ---------- 阶段推演派生数据 ---------- */

export const latestVersion = computed(() =>
  state.versions.length > 0 ? state.versions[state.versions.length - 1] : null,
)

/** 层位 id → 最新区间结果 */
export const intervalByUnit = computed(() => {
  const map = new Map<string, UnitInterval>()
  for (const r of latestVersion.value?.results ?? []) map.set(r.unitId, r)
  return map
})

/** 涉及某阶段的未解决诊断（用于阻止标记有效） */
export function diagnosticsForPhase(phaseId: string): PhaseDiagnostic[] {
  return state.diagnostics.filter((d) => d.phaseIds.includes(phaseId))
}

/* ---------- 基础工具 ---------- */

const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

let toastTimer = 0
export function toast(msg: string) {
  state.toast = msg
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
    assignments: db.assignments,
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
  const [units, positions, relations, evidences, retractions, batches, phases, phaseConstraints, assignments, versions, diagnostics] =
    await Promise.all([
      db.units.toArray(),
      db.positions.toArray(),
      db.relations.toArray(),
      db.evidences.toArray(),
      db.retractions.toArray(),
      db.batches.orderBy('at').toArray(),
      db.phases.toArray(),
      db.phaseConstraints.toArray(),
      db.assignments.toArray(),
      db.versions.orderBy('at').toArray(),
      db.diagnostics.toArray(),
    ])
  state.units = units.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  state.positions = Object.fromEntries(positions.map((p) => [p.unitId, p]))
  state.relations = relations.sort((a, b) => a.createdAt - b.createdAt)
  state.evidences = evidences.sort((a, b) => a.createdAt - b.createdAt)
  state.retractions = retractions.sort((a, b) => a.at - b.at)
  state.batches = batches
  state.phases = phases.sort((a, b) => a.createdAt - b.createdAt)
  state.phaseConstraints = phaseConstraints.sort((a, b) => a.createdAt - b.createdAt)
  state.assignments = Object.fromEntries(assignments.map((a) => [a.unitId, a]))
  state.versions = versions
  state.diagnostics = diagnostics
  state.loaded = true
}

/** 以批次执行一组变更：全部正向应用后登记批次，供整体撤销 */
async function runBatch(label: string, mutations: Mutation[]) {
  if (mutations.length === 0) return
  for (const m of mutations) await applyForward(m)
  const batch: Batch = { id: uid(), label, at: Date.now(), undone: false, mutations }
  await db.batches.put(plain(batch))
  await refresh()
}

/** 撤销最近一个未撤销的批次：关系与证据引用随逆向变更一起恢复 */
export async function undo() {
  const batch = [...state.batches].reverse().find((b) => !b.undone)
  if (!batch) {
    toast('没有可撤销的操作')
    return
  }
  for (const m of [...batch.mutations].reverse()) await applyInverse(m)
  await db.batches.update(batch.id, { undone: true })
  await refresh()
  await maybeRecompute({ type: 'all' }, `撤销：${batch.label}`)
  toast(`已撤销：${batch.label}`)
}

/* ---------- 阶段推演：增量重算 ---------- */

function phasingInput(): PhasingInput {
  return {
    unitIds: state.units.map((u) => u.id),
    edges: orderEdges.value,
    phases: state.phases,
    constraints: state.phaseConstraints,
    assignments: Object.values(state.assignments),
  }
}

/**
 * 重算阶段区间与诊断，并持久化为一个新的计算版本。
 * 依据变更原因只重算受影响的层位，其余层位沿用上一版本结果；
 * 诊断涉及全局证据链，每次全量重算（代价极低）。
 */
export async function recomputePhases(cause: RecomputeCause, label: string) {
  const input = phasingInput()
  const prev = state.versions.length > 0 ? state.versions[state.versions.length - 1] : null
  const prevResults = new Map((prev?.results ?? []).map((r) => [r.unitId, r]))

  let affected: Set<string> | null = null
  if (prev) {
    affected = affectedUnits(cause, {
      unitIds: input.unitIds,
      prevEdges: prev.edgesSnapshot,
      nextEdges: input.edges,
      prevConstraints: prev.constraintsSnapshot,
      nextConstraints: input.constraints,
      prevResults,
    })
  }
  const targets = affected ? input.unitIds.filter((id) => affected.has(id)) : input.unitIds

  let results: UnitInterval[] = []
  if (input.phases.length > 0) {
    const fresh = computeUnitIntervals(targets, input)
    for (const id of input.unitIds) {
      const hit = fresh.get(id) ?? prevResults.get(id) ?? computeUnitIntervals([id], input).get(id)
      if (hit) results.push(hit)
    }
  }

  const diagnostics = computeDiagnostics(
    { ...input, relations: state.relations },
    { unit: unitLabel, phase: phaseLabel },
  )
  for (const d of diagnostics) d.id = uid()

  const version: ComputationVersion = {
    id: uid(),
    // 严格递增，保证刷新后按 at 排序仍能还原版本先后
    at: Math.max(Date.now(), (prev?.at ?? 0) + 1),
    cause: label,
    affectedUnitIds: targets,
    results,
    diagnostics,
    edgesSnapshot: input.edges,
    constraintsSnapshot: input.constraints.map((c) => ({ from: c.from, to: c.to })),
  }
  await db.versions.put(plain(version))
  await db.transaction('rw', [db.diagnostics], async () => {
    await db.diagnostics.clear()
    if (diagnostics.length > 0) await db.diagnostics.bulkPut(plain(diagnostics))
  })
  state.versions = [...state.versions, version]
  state.diagnostics = diagnostics

  // 矛盾波及的阶段：自动撤销其“有效”标记（有效标记是直接写入，不进入撤销批次）
  const involved = new Set(diagnostics.flatMap((d) => d.phaseIds))
  const revoked = state.phases.filter((p) => p.valid && involved.has(p.id))
  for (const p of revoked) await db.phases.update(p.id, { valid: false, validAt: null })
  if (revoked.length > 0) {
    const ids = new Set(revoked.map((p) => p.id))
    state.phases = state.phases.map((p) => (ids.has(p.id) ? { ...p, valid: false, validAt: null } : p))
    toast(`阶段 ${revoked.map((p) => p.label).join('、')} 出现矛盾，已撤销其有效标记`)
  }
}

/** 尚未建立阶段框架且从未计算过时跳过，避免产生空白版本 */
async function maybeRecompute(cause: RecomputeCause, label: string) {
  if (state.phases.length === 0 && state.versions.length === 0) return
  await recomputePhases(cause, label)
}

/* ---------- 阶段 ---------- */

export async function addPhase(label: string, note: string) {
  label = label.trim()
  if (!label) return
  if (state.phases.some((p) => p.label === label)) {
    toast(`阶段 ${label} 已存在`)
    return
  }
  const phase: Phase = { id: uid(), label, note: note.trim(), createdAt: Date.now(), valid: false, validAt: null }
  await runBatch(`新增阶段 ${label}`, [{ table: 'phases', key: phase.id, before: null, after: phase }])
  // 新阶段对所有层位都可行，区间整体放宽
  await recomputePhases({ type: 'all' }, `新增阶段 ${label}`)
  toast(`已新增阶段 ${label}`)
}

export async function deletePhase(id: string) {
  const phase = state.phases.find((p) => p.id === id)
  if (!phase) return
  const mutations: Mutation[] = [{ table: 'phases', key: id, before: phase, after: null }]
  // 连带删除涉及该阶段的约束与分配（全部记入批次，可整体撤销）
  for (const c of state.phaseConstraints.filter((c) => c.from === id || c.to === id)) {
    mutations.push({ table: 'phaseConstraints', key: c.id, before: c, after: null })
  }
  for (const a of Object.values(state.assignments).filter((a) => a.phaseId === id)) {
    mutations.push({ table: 'assignments', key: a.unitId, before: a, after: null })
  }
  await runBatch(`删除阶段 ${phase.label}（连带 ${mutations.length - 1} 条约束/分配）`, mutations)
  await recomputePhases({ type: 'all' }, `删除阶段 ${phase.label}`)
  toast(`已删除阶段 ${phase.label}`)
}

/** 新增阶段前后约束；阶段偏序必须保持无环，成环直接拒绝 */
export async function addPhaseConstraint(from: string, to: string, note: string) {
  if (!from || !to) return
  if (from === to) {
    toast('阶段不能早于其自身')
    return
  }
  const dup = state.phaseConstraints.some((c) => c.from === from && c.to === to)
  if (dup) {
    toast('相同的阶段约束已存在')
    return
  }
  const edges = state.phaseConstraints.map((c) => ({ id: c.id, from: c.from, to: c.to }))
  const cycle = cyclePathIfAdded(edges, from, to)
  if (cycle) {
    toast(`该约束会使阶段顺序成环：${cycle.map(phaseLabel).join(' → ')}`)
    return
  }
  const constraint: PhaseConstraint = { id: uid(), from, to, note: note.trim(), createdAt: Date.now() }
  await runBatch(`新增阶段约束：${phaseLabel(from)} 早于 ${phaseLabel(to)}`, [
    { table: 'phaseConstraints', key: constraint.id, before: null, after: constraint },
  ])
  await recomputePhases({ type: 'constraint', from, to }, `新增阶段约束 ${phaseLabel(from)}→${phaseLabel(to)}`)
  toast('已添加阶段约束')
}

export async function removePhaseConstraint(id: string) {
  const constraint = state.phaseConstraints.find((c) => c.id === id)
  if (!constraint) return
  await runBatch(`删除阶段约束：${phaseLabel(constraint.from)} 早于 ${phaseLabel(constraint.to)}`, [
    { table: 'phaseConstraints', key: id, before: constraint, after: null },
  ])
  await recomputePhases(
    { type: 'constraint', from: constraint.from, to: constraint.to },
    `删除阶段约束 ${phaseLabel(constraint.from)}→${phaseLabel(constraint.to)}`,
  )
  toast('已删除阶段约束，相关区间已放宽重算')
}

/* ---------- 层位 → 阶段分配 ---------- */

export async function assignUnitPhase(unitId: string, phaseId: string) {
  const unit = state.units.find((u) => u.id === unitId)
  const phase = state.phases.find((p) => p.id === phaseId)
  if (!unit || !phase) return
  const existing = state.assignments[unitId]
  const assignment: PhaseAssignment = { unitId, phaseId, at: Date.now() }
  await runBatch(
    existing ? `改派层位 ${unit.label}：${phaseLabel(existing.phaseId)} → ${phase.label}` : `分配层位 ${unit.label} 至 ${phase.label}`,
    [{ table: 'assignments', key: unitId, before: existing ?? null, after: assignment }],
  )
  await recomputePhases({ type: 'assignment', unitId }, `分配 ${unit.label} 至 ${phase.label}`)
  toast(`已分配 ${unit.label} 至阶段 ${phase.label}`)
}

export async function unassignUnit(unitId: string) {
  const existing = state.assignments[unitId]
  if (!existing) return
  await runBatch(`移除层位 ${unitLabel(unitId)} 的阶段分配`, [
    { table: 'assignments', key: unitId, before: existing, after: null },
  ])
  await recomputePhases({ type: 'assignment', unitId }, `移除 ${unitLabel(unitId)} 的阶段分配`)
  toast('已移除分配')
}

/* ---------- 阶段有效标记（直接写入，不进入撤销批次） ---------- */

/** 标记阶段为有效：存在涉及该阶段的未解决诊断时拒绝 */
export async function markPhaseValid(id: string): Promise<boolean> {
  const phase = state.phases.find((p) => p.id === id)
  if (!phase) return false
  const blocking = diagnosticsForPhase(id)
  if (blocking.length > 0) {
    toast(`无法标记有效：${blocking.length} 条矛盾诊断涉及阶段 ${phase.label}，请先处理`)
    return false
  }
  await db.phases.update(id, { valid: true, validAt: Date.now() })
  state.phases = state.phases.map((p) => (p.id === id ? { ...p, valid: true, validAt: Date.now() } : p))
  toast(`阶段 ${phase.label} 已标记为有效`)
  return true
}

export async function unmarkPhaseValid(id: string) {
  const phase = state.phases.find((p) => p.id === id)
  if (!phase) return
  await db.phases.update(id, { valid: false, validAt: null })
  state.phases = state.phases.map((p) => (p.id === id ? { ...p, valid: false, validAt: null } : p))
  toast(`已取消阶段 ${phase.label} 的有效标记`)
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
  await maybeRecompute({ type: 'unit-added', unitId: unit.id }, `新增层位 ${label}`)
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
  const assignment = state.assignments[id]
  if (assignment) mutations.push({ table: 'assignments', key: id, before: assignment, after: null })
  await runBatch(`删除层位 ${unit.label}（连带 ${mutations.length - (pos ? 2 : 1)} 条关系）`, mutations)
  if (state.selectedUnitId === id) state.selectedUnitId = null
  // 层位消失对偏序的影响范围难以局部界定，保守全量重算
  await maybeRecompute({ type: 'all' }, `删除层位 ${unit.label}`)
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
    await maybeRecompute({ type: 'relation', from: draft.from, to: draft.to }, `新增同期关联 ${describe(draft)}`)
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
  await maybeRecompute({ type: 'relation', from: draft.from, to: draft.to }, `新增先后关系 ${describe(draft)}`)
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
  await maybeRecompute({ type: 'relation', from: rel.from, to: rel.to }, `撤回判断 ${unitLabel(rel.from)}→${unitLabel(rel.to)}`)
  toast('已撤回，判断与理由已单独存档')
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
  for (const u of sample.units) {
    const p = positions.get(u.id)
    if (p) mutations.push({ table: 'positions', key: u.id, before: null, after: { unitId: u.id, ...p } })
  }
  await runBatch('载入示例工程', mutations)
  state.layoutVersion++
  toast('示例工程已载入（含切割事件、孤立层位、矛盾记录与已撤销判断）')
}

/** 清空时需要覆盖的全部数据表（含阶段推演与计算版本） */
const ALL_TABLES = [
  db.units,
  db.positions,
  db.relations,
  db.evidences,
  db.retractions,
  db.batches,
  db.phases,
  db.phaseConstraints,
  db.assignments,
  db.versions,
  db.diagnostics,
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

/** 组装导出数据（纯函数，便于测试与复用） */
export function buildExport(): ProjectExport {
  const latest = latestVersion.value
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
    assignments: Object.values(state.assignments),
    phaseSnapshot: latest ? { results: latest.results, diagnostics: latest.diagnostics } : null,
  }
}

export function exportProject() {
  const data = buildExport()
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `harris-matrix-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  toast(`已导出（偏序闭包 ${data.partialOrder.length} 个可达对，阶段 ${data.phases.length} 个）`)
}

export interface ImportCheck {
  /** 偏序闭包与导出快照是否一致 */
  orderSame: boolean
  /** 重算后的阶段区间与诊断是否与导出快照一致 */
  phaseSame: boolean
}

/**
 * 导入数据本体（不含确认交互，便于测试）。
 * 导入后全量重算阶段推演，并与导出快照逐项比对区间与矛盾证据。
 */
export async function importData(data: ProjectExport): Promise<ImportCheck> {
  await db.transaction('rw', ALL_TABLES, async () => {
    await Promise.all(ALL_TABLES.map((t) => t.clear()))
    await db.units.bulkPut(data.units)
    await db.positions.bulkPut(data.positions ?? [])
    await db.relations.bulkPut(data.relations)
    await db.evidences.bulkPut(data.evidences ?? [])
    await db.retractions.bulkPut(data.retractions ?? [])
    await db.phases.bulkPut(data.phases ?? [])
    await db.phaseConstraints.bulkPut(data.phaseConstraints ?? [])
    await db.assignments.bulkPut(data.assignments ?? [])
  })
  await refresh()
  state.layoutVersion++

  // 偏序一致性校验：重算可达对并与导出快照比对
  const expected = [...(data.partialOrder ?? [])].sort()
  const actual = reachablePairs(orderEdges.value)
  const orderSame = JSON.stringify(expected) === JSON.stringify(actual)

  // 阶段推演校验：全量重算后与导出快照比对区间与诊断
  let phaseSame = true
  if ((data.phases ?? []).length > 0) {
    await recomputePhases({ type: 'all' }, '导入工程')
    const snap = data.phaseSnapshot
    if (snap) {
      const latest = state.versions[state.versions.length - 1]
      phaseSame =
        canonicalResults(latest.results) === canonicalResults(snap.results ?? []) &&
        canonicalDiagnostics(latest.diagnostics) === canonicalDiagnostics(snap.diagnostics ?? [])
    }
  }
  return { orderSame, phaseSame }
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
  const check = await importData(data)
  if (!check.orderSame) {
    toast('导入完成，但偏序与导出时不一致，请检查数据')
  } else if (!check.phaseSame) {
    toast('导入完成，但阶段区间/诊断与导出时不一致，请检查数据')
  } else {
    toast('导入完成，偏序与阶段推演校验一致')
  }
}
