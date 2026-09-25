import { buildGraph, findPath, type OrderEdge } from './graph'
import type {
  Phase,
  PhaseAssignment,
  PhaseConstraint,
  PhaseDiagnostic,
  Relation,
  UnitInterval,
} from './types'

/**
 * 阶段推演引擎（纯函数，不触碰存储与 UI）。
 *
 * 语义约定（可能世界语义）：
 * - 层位先后 u→v 表示 phase(u) 不晚于 phase(v)；
 * - 阶段约束构成阶段偏序 DAG，p<q 当且仅当存在约束路径 p→…→q；
 * - 某阶段 q 对层位 u 可行，当且仅当没有任何证据【证明】q 违反上述约束
 *   （与界限阶段不可比较时视为可行，而非武断排除）；
 * - 因此删除约束只会放宽区间，互不相连的层位保持覆盖全部阶段的宽区间；
 *   可行集合恰含一个阶段时才给出单值，否则一律以区间（极小/极大阶段）呈现。
 */

export interface PhasingInput {
  unitIds: string[]
  /** 活跃“早于”关系边（同期关联不进入） */
  edges: OrderEdge[]
  phases: Phase[]
  constraints: PhaseConstraint[]
  assignments: PhaseAssignment[]
}

/** 阶段 id 的稳定排序键（按创建时间，再按 id），保证结果可复现 */
function phaseOrderKey(phases: Phase[]): Map<string, number> {
  const sorted = [...phases].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return new Map(sorted.map((p, i) => [p.id, i]))
}

/** 严格阶段先后：存在约束路径 a→…→b 且 a≠b */
function makePhaseLt(constraints: PhaseConstraint[]) {
  const g = buildGraph(constraints.map((c) => ({ id: c.id, from: c.from, to: c.to })))
  return (a: string, b: string): boolean => a !== b && findPath(g, a, b) !== null
}

/**
 * 计算指定层位的阶段区间。targetIds 之外的层位不计算（增量重算由调用方合并旧结果）。
 * 每个结果同时记录 lower/upper 证据阶段，供界面解释与增量受影响判断使用。
 */
export function computeUnitIntervals(targetIds: string[], input: PhasingInput): Map<string, UnitInterval> {
  const out = new Map<string, UnitInterval>()
  if (input.phases.length === 0) return out

  const phaseLt = makePhaseLt(input.constraints)
  const order = phaseOrderKey(input.phases)
  const byCreated = (a: string, b: string) => (order.get(a) ?? 0) - (order.get(b) ?? 0)
  const phaseIds = input.phases.map((p) => p.id).sort(byCreated)
  const assignedPhase = new Map(input.assignments.map((a) => [a.unitId, a.phaseId]))

  // 从每个已分配层位沿层位偏序双向传播其阶段证据
  const lower = new Map<string, Set<string>>() // 必须不晚于本层位的阶段
  const upper = new Map<string, Set<string>>() // 必须不早于本层位的阶段
  const g = buildGraph(input.edges)
  for (const id of input.unitIds) if (!g.hasNode(id)) g.addNode(id)

  const addTo = (map: Map<string, Set<string>>, unit: string, phase: string) => {
    const set = map.get(unit) ?? new Set<string>()
    set.add(phase)
    map.set(unit, set)
  }
  for (const [unitId, phaseId] of assignedPhase) {
    if (!g.hasNode(unitId) || !order.has(phaseId)) continue
    // v 不晚于 z（v→…→z）：phase(v) 是 z 的下界证据
    const seen = new Set<string>([unitId])
    const queue = [unitId]
    while (queue.length > 0) {
      const cur = queue.shift()!
      addTo(lower, cur, phaseId)
      g.forEachOutboundNeighbor(cur, (nb) => {
        if (!seen.has(nb)) {
          seen.add(nb)
          queue.push(nb)
        }
      })
    }
    // z 不晚于 v（z→…→v）：phase(v) 是 z 的上界证据
    const seenBack = new Set<string>([unitId])
    const queueBack = [unitId]
    while (queueBack.length > 0) {
      const cur = queueBack.shift()!
      addTo(upper, cur, phaseId)
      g.forEachInboundNeighbor(cur, (nb) => {
        if (!seenBack.has(nb)) {
          seenBack.add(nb)
          queueBack.push(nb)
        }
      })
    }
  }

  for (const id of targetIds) {
    const lo = [...(lower.get(id) ?? [])].sort(byCreated)
    const up = [...(upper.get(id) ?? [])].sort(byCreated)
    const own = assignedPhase.get(id)
    // 已分配层位的可行集合固定为其阶段（若与证据矛盾则为空，由诊断呈现）
    const candidates = own && order.has(own) ? [own] : phaseIds
    const feasible = candidates.filter(
      (q) => !lo.some((p) => phaseLt(q, p)) && !up.some((p) => phaseLt(p, q)),
    )
    const feasibleSet = new Set(feasible)
    const earliest = feasible.filter((q) => !feasible.some((x) => x !== q && feasibleSet.has(x) && phaseLt(x, q)))
    const latest = feasible.filter((q) => !feasible.some((x) => x !== q && feasibleSet.has(x) && phaseLt(q, x)))
    out.set(id, {
      unitId: id,
      lower: lo,
      upper: up,
      feasible,
      earliest,
      latest,
      exact: feasible.length === 1 ? feasible[0] : null,
    })
  }
  return out
}

/** 沿层位路径收集每一步对应的活跃“早于”关系 id（证据链） */
function relationIdsAlong(path: string[], relations: Relation[]): string[] {
  const ids = new Set<string>()
  for (let i = 0; i + 1 < path.length; i++) {
    for (const r of relations) {
      if (r.status === 'active' && r.kind === 'earlier' && r.from === path[i] && r.to === path[i + 1]) ids.add(r.id)
    }
  }
  return [...ids].sort()
}

/**
 * 矛盾诊断：层位偏序与阶段顺序冲突时，给出层位证据链 + 阶段证据链。
 * 只读原始数据，绝不修改任何关系记录。
 */
export function computeDiagnostics(
  input: PhasingInput & { relations: Relation[] },
  labels: { unit: (id: string) => string; phase: (id: string) => string },
): PhaseDiagnostic[] {
  const diagnostics: PhaseDiagnostic[] = []
  if (input.phases.length === 0) return diagnostics

  const unitGraph = buildGraph(input.edges)
  const phaseGraph = buildGraph(input.constraints.map((c) => ({ id: c.id, from: c.from, to: c.to })))
  const phaseLt = makePhaseLt(input.constraints)
  const assigned = new Map(input.assignments.map((a) => [a.unitId, a.phaseId]))
  const assignedUnits = [...assigned.keys()].sort()

  // 先后冲突：a 早于 b（层位证据链），但阶段顺序证明 phase(b) 早于 phase(a)
  for (const a of assignedUnits) {
    for (const b of assignedUnits) {
      if (a === b) continue
      const pa = assigned.get(a)!
      const pb = assigned.get(b)!
      if (!phaseLt(pb, pa)) continue
      const unitPath = findPath(unitGraph, a, b)
      const phasePath = findPath(phaseGraph, pb, pa)
      if (!unitPath || !phasePath) continue
      diagnostics.push({
        id: '',
        kind: 'order-conflict',
        phaseIds: [...new Set(phasePath)],
        unitPath,
        phasePath,
        relationIds: relationIdsAlong(unitPath, input.relations),
        message:
          `${labels.unit(a)}（${labels.phase(pa)}）经层位关系链早于 ${labels.unit(b)}（${labels.phase(pb)}），` +
          `但阶段约束为 ${phasePath.map(labels.phase).join(' 早于 ')}`,
      })
    }
  }

  // 同期冲突：同期关联的两层位被分配到可比较但不同的阶段
  for (const r of input.relations) {
    if (r.status !== 'active' || r.kind !== 'contemporary') continue
    const pa = assigned.get(r.from)
    const pb = assigned.get(r.to)
    if (!pa || !pb || pa === pb) continue
    const forward = phaseLt(pa, pb)
    const backward = phaseLt(pb, pa)
    if (!forward && !backward) continue
    const phasePath = findPath(phaseGraph, forward ? pa : pb, forward ? pb : pa)!
    diagnostics.push({
      id: '',
      kind: 'contemporary-conflict',
      phaseIds: [...new Set(phasePath)],
      unitPath: [r.from, r.to],
      phasePath,
      relationIds: [r.id],
      message:
        `${labels.unit(r.from)} 与 ${labels.unit(r.to)} 为同期关联，却被分配到 ` +
        `${labels.phase(pa)} 与 ${labels.phase(pb)}（${phasePath.map(labels.phase).join(' 早于 ')}）`,
    })
  }

  // 稳定排序，保证跨版本/跨导入导出可比对
  diagnostics.sort(
    (x, y) =>
      x.kind.localeCompare(y.kind) ||
      x.unitPath.join('').localeCompare(y.unitPath.join('')) ||
      x.phasePath.join('').localeCompare(y.phasePath.join('')),
  )
  return diagnostics
}

/* ---------- 增量重算：受影响层位集合 ---------- */

export type RecomputeCause =
  | { type: 'all' }
  | { type: 'unit-added'; unitId: string }
  | { type: 'relation'; from: string; to: string }
  | { type: 'assignment'; unitId: string }
  | { type: 'constraint'; from: string; to: string }

/** 求并集图中 from 的祖先（含自身）与 to 的后代（含自身） */
function ancestorDescendantSets(
  prevEdges: { from: string; to: string }[],
  nextEdges: { from: string; to: string }[],
  from: string,
  to: string,
): { ancestors: Set<string>; descendants: Set<string> } {
  const g = buildGraph([
    ...prevEdges.map((e, i) => ({ id: `p${i}`, from: e.from, to: e.to })),
    ...nextEdges.map((e, i) => ({ id: `n${i}`, from: e.from, to: e.to })),
  ])
  const ancestors = new Set<string>([from])
  const descendants = new Set<string>([to])
  if (g.hasNode(from)) {
    const queue = [from]
    while (queue.length > 0) {
      const cur = queue.shift()!
      g.forEachInboundNeighbor(cur, (nb) => {
        if (!ancestors.has(nb)) {
          ancestors.add(nb)
          queue.push(nb)
        }
      })
    }
  }
  if (g.hasNode(to)) {
    const queue = [to]
    while (queue.length > 0) {
      const cur = queue.shift()!
      g.forEachOutboundNeighbor(cur, (nb) => {
        if (!descendants.has(nb)) {
          descendants.add(nb)
          queue.push(nb)
        }
      })
    }
  }
  return { ancestors, descendants }
}

/**
 * 依据变更原因计算需要重算的层位集合；返回 null 表示必须全量。
 * prev* 为上一计算版本所依据的快照，与当前图求并集，保证删除类变更不遗漏。
 */
export function affectedUnits(
  cause: RecomputeCause,
  ctx: {
    unitIds: string[]
    prevEdges: OrderEdge[]
    nextEdges: OrderEdge[]
    prevConstraints: PhaseConstraint[]
    nextConstraints: PhaseConstraint[]
    prevResults: Map<string, UnitInterval>
  },
): Set<string> | null {
  switch (cause.type) {
    case 'all':
      return null
    case 'unit-added':
      return new Set([cause.unitId])
    case 'assignment': {
      // 该层位阶段变化会影响其全部祖先（上界证据）与后代（下界证据）
      const { ancestors, descendants } = ancestorDescendantSets([], ctx.nextEdges, cause.unitId, cause.unitId)
      return new Set([...ancestors, ...descendants])
    }
    case 'relation': {
      // 可达性变化只波及 from 的祖先（上界证据变化）与 to 的后代（下界证据变化）
      const { ancestors, descendants } = ancestorDescendantSets(ctx.prevEdges, ctx.nextEdges, cause.from, cause.to)
      return new Set([...ancestors, ...descendants])
    }
    case 'constraint': {
      // 阶段偏序中新增/消失的可比较对，只波及下界证据含“较晚侧阶段”
      // 或上界证据含“较早侧阶段”的层位
      const { ancestors, descendants } = ancestorDescendantSets(
        ctx.prevConstraints,
        ctx.nextConstraints,
        cause.from,
        cause.to,
      )
      const affected = new Set<string>()
      for (const id of ctx.unitIds) {
        const r = ctx.prevResults.get(id)
        if (!r) {
          affected.add(id)
          continue
        }
        if (r.lower.some((p) => descendants.has(p)) || r.upper.some((p) => ancestors.has(p))) affected.add(id)
      }
      return affected
    }
  }
}

/* ---------- 导出/导入一致性比对 ---------- */

/** 区间结果的规范化串行（排序后 JSON），用于导入后与导出快照逐项比对 */
export function canonicalResults(results: UnitInterval[]): string {
  const norm = results
    .map((r) => ({
      unitId: r.unitId,
      lower: [...r.lower].sort(),
      upper: [...r.upper].sort(),
      feasible: [...r.feasible].sort(),
      earliest: [...r.earliest].sort(),
      latest: [...r.latest].sort(),
      exact: r.exact,
    }))
    .sort((a, b) => a.unitId.localeCompare(b.unitId))
  return JSON.stringify(norm)
}

/** 诊断的规范化串行：忽略每次重算都变化的 id，保留证据路径 */
export function canonicalDiagnostics(diagnostics: PhaseDiagnostic[]): string {
  const norm = diagnostics
    .map((d) => ({
      kind: d.kind,
      phaseIds: [...d.phaseIds].sort(),
      unitPath: d.unitPath,
      phasePath: d.phasePath,
      relationIds: [...d.relationIds].sort(),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return JSON.stringify(norm)
}
