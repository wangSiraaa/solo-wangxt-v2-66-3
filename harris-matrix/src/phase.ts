import type { DiagnosticStep, Phase, PhaseAssignment, PhaseConstraint } from './types'
import type { OrderEdge } from './graph'

/**
 * 地层阶段与相对年代区间推演引擎（纯函数，不依赖 Vue / IndexedDB）。
 *
 * 语义约定：
 * - 层位“早于”边 u→v 表示 phase(v) 不早于 phase(u)（同一阶段允许，严格倒退不允许）。
 * - 同期关联 u≈v 表示两者必须处于同一阶段。
 * - 阶段前后约束构成阶段偏序；层位的可行阶段集合在弧一致（arc consistency）不动点上求得。
 * - 不能唯一定位时保留区间（最早/最晚可行阶段），绝不武断给出单值。
 */

/** 同期关联（无向）：仅要求两端层位处于同一阶段 */
export interface ContemporaryPair {
  id: string
  a: string
  b: string
}

/** 诊断文本的人类可读格式化器（由调用方按当前数据提供） */
export interface PhaseFormatters {
  unit(id: string): string
  phase(id: string): string
  /** 关系的人类可读描述（含证据引用），用于诊断证据路径 */
  relation(id: string): string
}

export interface PhaseEngineInput {
  unitIds: string[]
  /** 活跃“早于”边（可能含成环的矛盾边；推演取 DAG 骨架，成环边不传导边界） */
  orderEdges: OrderEdge[]
  contemporary: ContemporaryPair[]
  phases: Phase[]
  constraints: PhaseConstraint[]
  assignments: PhaseAssignment[]
  fmt?: Partial<PhaseFormatters>
}

/** 单个层位的推演结果 */
export interface IntervalResult {
  /** 全部可行阶段（按阶段拓扑序）；为空表示矛盾 */
  feasiblePhaseIds: string[]
  earliestPhaseId: string | null
  latestPhaseId: string | null
  conflict: boolean
}

export interface RawDiagnostic {
  /** 由内容派生的稳定 id：重算/导入导出比对不产生重复 */
  id: string
  kind: 'phase-cycle' | 'order-conflict' | 'contemporary-conflict' | 'empty-interval'
  message: string
  path: DiagnosticStep[]
}

export interface PhaseModel {
  /** 阶段拓扑序（成环约束被忽略后的骨架序） */
  phaseOrder: string[]
  intervals: Map<string, IntervalResult>
  diagnostics: RawDiagnostic[]
  valid: boolean
}

/* ---------- 通用有向图工具（确定性：均按输入顺序遍历） ---------- */

interface Edge {
  id: string
  from: string
  to: string
}

/** BFS 求 from→to 的一条边路径；不存在返回 null */
function edgePath<T extends Edge>(edges: T[], from: string, to: string): T[] | null {
  if (from === to) return []
  const adj = new Map<string, T[]>()
  for (const e of edges) {
    const list = adj.get(e.from) ?? []
    list.push(e)
    adj.set(e.from, list)
  }
  const prev = new Map<string, { node: string; edge: T }>()
  const seen = new Set<string>([from])
  const queue: string[] = [from]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const e of adj.get(cur) ?? []) {
      if (seen.has(e.to)) continue
      seen.add(e.to)
      prev.set(e.to, { node: cur, edge: e })
      if (e.to === to) {
        const path: T[] = []
        let n = to
        while (n !== from) {
          const p = prev.get(n)!
          path.unshift(p.edge)
          n = p.node
        }
        return path
      }
      queue.push(e.to)
    }
  }
  return null
}

/** 逐条加边构建 DAG 骨架：会成环的边被剔除，并连同构成环的既有路径一起返回 */
function skeleton<T extends Edge>(edges: T[]): { dag: T[]; dropped: { edge: T; cycle: T[] }[] } {
  const dag: T[] = []
  const dropped: { edge: T; cycle: T[] }[] = []
  for (const e of edges) {
    if (e.from === e.to) {
      dropped.push({ edge: e, cycle: [e] })
      continue
    }
    const back = edgePath(dag, e.to, e.from)
    if (back) dropped.push({ edge: e, cycle: [e, ...back] })
    else dag.push(e)
  }
  return { dag, dropped }
}

/** 严格传递闭包：reach[x] = 从 x 出发可到达的全部节点（不含 x 自身） */
function transitiveClosure(nodes: string[], edges: Edge[]): Map<string, Set<string>> {
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    const list = adj.get(e.from) ?? []
    if (!list.includes(e.to)) list.push(e.to)
    adj.set(e.from, list)
  }
  const reach = new Map<string, Set<string>>()
  for (const n of nodes) {
    const seen = new Set<string>()
    const queue = [...(adj.get(n) ?? [])]
    while (queue.length > 0) {
      const cur = queue.shift()!
      if (seen.has(cur)) continue
      seen.add(cur)
      queue.push(...(adj.get(cur) ?? []))
    }
    reach.set(n, seen)
  }
  return reach
}

function intersectAll(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set()
  const acc = new Set(sets[0])
  for (let i = 1; i < sets.length; i++) {
    for (const x of [...acc]) if (!sets[i].has(x)) acc.delete(x)
  }
  return acc
}

/**
 * 层位连通分量（“早于”边视为无向连接 + 同期关联）。
 * 区间推演在不同分量之间互不影响——增量重算以分量粒度圈定受影响层位。
 */
export function componentsOf(
  unitIds: string[],
  orderEdges: OrderEdge[],
  contemporary: ContemporaryPair[],
): Map<string, Set<string>> {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    let cur = x
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!
      parent.set(cur, r)
      cur = next
    }
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const id of unitIds) parent.set(id, id)
  for (const e of orderEdges) if (parent.has(e.from) && parent.has(e.to)) union(e.from, e.to)
  for (const c of contemporary) if (parent.has(c.a) && parent.has(c.b)) union(c.a, c.b)
  const groups = new Map<string, Set<string>>()
  for (const id of unitIds) {
    const r = find(id)
    const set = groups.get(r) ?? new Set<string>()
    set.add(id)
    groups.set(r, set)
  }
  const out = new Map<string, Set<string>>()
  for (const id of unitIds) out.set(id, groups.get(find(id))!)
  return out
}

/** 阶段拓扑序：Kahn 算法，同层按（标签, id）决胜，保证跨设备/导入导出结果确定 */
function topoOrder(phases: Phase[], dag: Edge[]): string[] {
  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const p of phases) {
    indeg.set(p.id, 0)
    adj.set(p.id, [])
  }
  for (const e of dag) {
    if (!indeg.has(e.from) || !indeg.has(e.to)) continue
    indeg.set(e.to, indeg.get(e.to)! + 1)
    adj.get(e.from)!.push(e.to)
  }
  const label = new Map(phases.map((p) => [p.id, p.label]))
  const byName = (a: string, b: string) => label.get(a)!.localeCompare(label.get(b)!, 'zh-CN') || a.localeCompare(b)
  const ready = phases.filter((p) => indeg.get(p.id) === 0).map((p) => p.id)
  const out: string[] = []
  while (ready.length > 0) {
    ready.sort(byName)
    const cur = ready.shift()!
    out.push(cur)
    for (const nb of adj.get(cur)!) {
      const d = indeg.get(nb)! - 1
      indeg.set(nb, d)
      if (d === 0) ready.push(nb)
    }
  }
  for (const p of phases) if (!out.includes(p.id)) out.push(p.id)
  return out
}

/* ---------- 主推演 ---------- */

/**
 * 计算阶段拓扑序、各层位可行阶段区间与诊断。
 * scope 给定时只为其中层位产出区间（其余由调用方沿用旧结果）；
 * 诊断始终基于全量数据计算（一致性是全局性质）。
 */
export function computePhaseModel(input: PhaseEngineInput, scope?: Set<string>): PhaseModel {
  const fmt: PhaseFormatters = {
    unit: input.fmt?.unit ?? ((id) => id),
    phase: input.fmt?.phase ?? ((id) => id),
    relation: input.fmt?.relation ?? ((id) => id),
  }
  const empty: PhaseModel = { phaseOrder: [], intervals: new Map(), diagnostics: [], valid: true }
  if (input.phases.length === 0) return empty

  const phaseIds = input.phases.map((p) => p.id)
  const phaseSet = new Set(phaseIds)
  const unitSet = new Set(input.unitIds)

  /* 1. 阶段偏序：骨架 + 拓扑序 + 成环约束诊断 */
  const constraintEdges = [...input.constraints]
    .filter((c) => phaseSet.has(c.before) && phaseSet.has(c.after))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((c) => ({ id: c.id, from: c.before, to: c.after }))
  const phaseSkel = skeleton(constraintEdges)
  const phaseOrder = topoOrder(input.phases, phaseSkel.dag)

  const strictAfter = transitiveClosure(phaseIds, phaseSkel.dag)
  const strictBefore = new Map<string, Set<string>>()
  for (const p of phaseIds) strictBefore.set(p, new Set())
  for (const [p, later] of strictAfter) for (const q of later) strictBefore.get(q)!.add(p)

  const diagnostics: RawDiagnostic[] = []
  for (const d of phaseSkel.dropped) {
    const nodes = [d.edge.from, d.edge.to, ...d.cycle.slice(1).map((e) => e.to)]
    diagnostics.push({
      id: `phase-cycle:${d.edge.id}`,
      kind: 'phase-cycle',
      message: `阶段约束构成环：${nodes.map(fmt.phase).join(' → ')}，阶段顺序无效`,
      path: d.cycle.map((e) => ({
        kind: 'constraint',
        refId: e.id,
        text: `阶段约束：${fmt.phase(e.from)} 早于 ${fmt.phase(e.to)}`,
      })),
    })
  }

  /* 2. 层位偏序骨架（成环的矛盾关系不传导边界，已在关系层标红；
        悬空引用——如旧工程中端点已删除的关系——一律忽略） */
  const unitEdges = input.orderEdges.filter((e) => unitSet.has(e.from) && unitSet.has(e.to))
  const unitSkel = skeleton(unitEdges)
  const unitClosure = transitiveClosure(input.unitIds, unitSkel.dag)

  /* 3. 可行阶段集合：弧一致不动点 */
  const assignmentOf = new Map<string, string>()
  for (const a of input.assignments) {
    if (phaseSet.has(a.phaseId) && unitSet.has(a.unitId)) assignmentOf.set(a.unitId, a.phaseId)
  }
  const feasible = new Map<string, Set<string>>()
  for (const u of input.unitIds) {
    const assigned = assignmentOf.get(u)
    feasible.set(u, new Set(assigned ? [assigned] : phaseIds))
  }
  let changed = true
  let guard = 0
  while (changed && guard++ < 1000) {
    changed = false
    for (const e of unitSkel.dag) {
      const fx = feasible.get(e.from)!
      const fy = feasible.get(e.to)!
      // 空集不向外传导：矛盾就地定位，不级联污染整个分量
      if (fx.size === 0 || fy.size === 0) continue
      // 终点不得早于起点的全部可行阶段；起点不得晚于终点的全部可行阶段
      const forbidForTo = intersectAll([...fx].map((p) => strictBefore.get(p)!))
      const forbidForFrom = intersectAll([...fy].map((p) => strictAfter.get(p)!))
      for (const q of forbidForTo) if (fy.delete(q)) changed = true
      for (const p of forbidForFrom) if (fx.delete(p)) changed = true
    }
    for (const c of input.contemporary) {
      const fa = feasible.get(c.a)
      const fb = feasible.get(c.b)
      if (!fa || !fb) continue
      for (const p of [...fa]) if (!fb.has(p)) { fa.delete(p); changed = true }
      for (const p of [...fb]) if (!fa.has(p)) { fb.delete(p); changed = true }
    }
  }

  /* 4. 区间结果（仅 scope 内的层位；缺省为全部） */
  const rankOf = new Map(phaseOrder.map((id, i) => [id, i]))
  const wanted = scope ?? new Set(input.unitIds)
  const intervals = new Map<string, IntervalResult>()
  for (const u of input.unitIds) {
    if (!wanted.has(u)) continue
    const f = feasible.get(u)!
    const list = [...f].sort((a, b) => rankOf.get(a)! - rankOf.get(b)!)
    intervals.set(u, {
      feasiblePhaseIds: list,
      earliestPhaseId: list[0] ?? null,
      latestPhaseId: list[list.length - 1] ?? null,
      conflict: list.length === 0,
    })
  }

  /* 5. 诊断 */
  const assignedUnits = [...assignmentOf.keys()].sort()
  const coveredByDiagnostic = new Set<string>()

  // 5a. 层位关系与阶段顺序矛盾：a→…→b 但 b 的阶段严格早于 a 的阶段
  for (const a of assignedUnits) {
    for (const b of assignedUnits) {
      if (a === b || !unitClosure.get(a)!.has(b)) continue
      const pa = assignmentOf.get(a)!
      const pb = assignmentOf.get(b)!
      if (!strictBefore.get(pa)!.has(pb)) continue
      const relPath = edgePath(unitSkel.dag, a, b)!
      const phasePath = edgePath(phaseSkel.dag, pb, pa) ?? []
      for (const e of relPath) {
        coveredByDiagnostic.add(e.from)
        coveredByDiagnostic.add(e.to)
      }
      diagnostics.push({
        id: `order-conflict:${a}:${b}`,
        kind: 'order-conflict',
        message:
          `层位关系与阶段顺序矛盾：${fmt.unit(a)} 早于 ${fmt.unit(b)}，` +
          `但 ${fmt.unit(a)} 归属 ${fmt.phase(pa)}、${fmt.unit(b)} 归属更早的 ${fmt.phase(pb)}`,
        path: [
          ...relPath.map((e): DiagnosticStep => ({ kind: 'relation', refId: e.id, text: fmt.relation(e.id) })),
          { kind: 'assignment', refId: a, text: `${fmt.unit(a)} 归属阶段 ${fmt.phase(pa)}` },
          { kind: 'assignment', refId: b, text: `${fmt.unit(b)} 归属阶段 ${fmt.phase(pb)}` },
          ...phasePath.map((e): DiagnosticStep => ({
            kind: 'constraint',
            refId: e.id,
            text: `阶段约束：${fmt.phase(e.from)} 早于 ${fmt.phase(e.to)}`,
          })),
        ],
      })
    }
  }

  // 5b. 同期层位组无可行共同阶段（典型：同期层位被分配到不同/冲突阶段）
  const contempParent = new Map<string, string>()
  const findC = (x: string): string => {
    let r = x
    while (contempParent.get(r) !== r) r = contempParent.get(r)!
    return r
  }
  for (const u of input.unitIds) contempParent.set(u, u)
  for (const c of input.contemporary) {
    if (!unitSet.has(c.a) || !unitSet.has(c.b)) continue
    const ra = findC(c.a)
    const rb = findC(c.b)
    if (ra !== rb) contempParent.set(ra, rb)
  }
  const contempGroups = new Map<string, string[]>()
  for (const u of input.unitIds) {
    const r = findC(u)
    const list = contempGroups.get(r) ?? []
    list.push(u)
    contempGroups.set(r, list)
  }
  for (const members of contempGroups.values()) {
    if (members.length < 2) continue
    const inter = intersectAll(members.map((m) => feasible.get(m)!))
    if (inter.size > 0) continue
    members.forEach((m) => coveredByDiagnostic.add(m))
    const sorted = [...members].sort()
    const links = input.contemporary.filter((c) => members.includes(c.a) && members.includes(c.b))
    const assignedMembers = sorted.filter((m) => assignmentOf.has(m))
    // 找出一对归属不同的成员，附阶段约束链作为证据
    let detail = ''
    let phaseSteps: DiagnosticStep[] = []
    outer: for (const x of assignedMembers) {
      for (const y of assignedMembers) {
        if (x === y) continue
        const px = assignmentOf.get(x)!
        const py = assignmentOf.get(y)!
        if (px === py) continue
        detail = `（${fmt.unit(x)} 归属 ${fmt.phase(px)}，${fmt.unit(y)} 归属 ${fmt.phase(py)}）`
        const pPath = edgePath(phaseSkel.dag, px, py) ?? edgePath(phaseSkel.dag, py, px) ?? []
        phaseSteps = pPath.map((e) => ({
          kind: 'constraint' as const,
          refId: e.id,
          text: `阶段约束：${fmt.phase(e.from)} 早于 ${fmt.phase(e.to)}`,
        }))
        break outer
      }
    }
    diagnostics.push({
      id: `contemporary-conflict:${sorted.join(':')}`,
      kind: 'contemporary-conflict',
      message: `同期层位无法处于同一阶段：${sorted.map(fmt.unit).join('、')} 的可行阶段交集为空${detail}`,
      path: [
        ...links.map((c): DiagnosticStep => ({ kind: 'contemporary', refId: c.id, text: fmt.relation(c.id) })),
        ...assignedMembers.map((m): DiagnosticStep => ({
          kind: 'assignment',
          refId: m,
          text: `${fmt.unit(m)} 归属阶段 ${fmt.phase(assignmentOf.get(m)!)}`,
        })),
        ...phaseSteps,
      ],
    })
  }

  // 5c. 区间为空且未被上述诊断覆盖的层位：列出夹逼它的全部分配作为证据
  for (const u of [...input.unitIds].sort()) {
    if (feasible.get(u)!.size > 0 || coveredByDiagnostic.has(u)) continue
    const ancestors = assignedUnits.filter((x) => unitClosure.get(x)!.has(u))
    const descendants = assignedUnits.filter((x) => unitClosure.get(u)!.has(x))
    const path: DiagnosticStep[] = []
    for (const anc of ancestors) {
      for (const e of edgePath(unitSkel.dag, anc, u) ?? []) {
        path.push({ kind: 'relation', refId: e.id, text: fmt.relation(e.id) })
      }
      path.push({ kind: 'assignment', refId: anc, text: `${fmt.unit(anc)} 归属阶段 ${fmt.phase(assignmentOf.get(anc)!)}` })
    }
    for (const desc of descendants) {
      for (const e of edgePath(unitSkel.dag, u, desc) ?? []) {
        path.push({ kind: 'relation', refId: e.id, text: fmt.relation(e.id) })
      }
      path.push({ kind: 'assignment', refId: desc, text: `${fmt.unit(desc)} 归属阶段 ${fmt.phase(assignmentOf.get(desc)!)}` })
    }
    diagnostics.push({
      id: `empty-interval:${u}`,
      kind: 'empty-interval',
      message: `层位 ${fmt.unit(u)} 没有可行阶段：先后约束与阶段归属共同夹逼导致区间为空`,
      path,
    })
  }

  diagnostics.sort((a, b) => a.id.localeCompare(b.id))
  return { phaseOrder, intervals, diagnostics, valid: diagnostics.length === 0 }
}
