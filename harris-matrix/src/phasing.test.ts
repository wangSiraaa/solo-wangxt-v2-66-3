import { describe, expect, it } from 'vitest'
import { computeDiagnostics, computeUnitIntervals, type PhasingInput } from './phasing'
import type { Phase, PhaseAssignment, PhaseConstraint, Relation } from './types'
import type { OrderEdge } from './graph'

/** 构造阶段：createdAt 递增保证排序稳定 */
function mkPhases(labels: string[]): Phase[] {
  return labels.map((label, i) => ({ id: label, label, note: '', createdAt: i + 1, valid: false, validAt: null }))
}

function mkConstraints(pairs: Array<[string, string]>): PhaseConstraint[] {
  return pairs.map(([from, to], i) => ({ id: `C${i}`, from, to, note: '', createdAt: i + 1 }))
}

function mkEdges(pairs: Array<[string, string]>): OrderEdge[] {
  return pairs.map(([from, to], i) => ({ id: `E${i}`, from, to }))
}

function mkAssignments(pairs: Array<[string, string]>): PhaseAssignment[] {
  return pairs.map(([unitId, phaseId]) => ({ unitId, phaseId, at: 1 }))
}

function mkRelation(id: string, from: string, to: string, kind: Relation['kind']): Relation {
  return { id, from, to, kind, source: 'observation', status: 'active', conflict: false, evidenceIds: [], note: '', createdAt: 1 }
}

const labels = { unit: (id: string) => id, phase: (id: string) => id }

function input(over: Partial<PhasingInput>): PhasingInput {
  return { unitIds: [], edges: [], phases: [], constraints: [], assignments: [], ...over }
}

const sorted = (xs: string[]) => [...xs].sort()

describe('阶段区间推演', () => {
  it('链式关系沿层位偏序传播，收紧中间层位的上下界', () => {
    const phases = mkPhases(['P1', 'P2', 'P3', 'P4'])
    const constraints = mkConstraints([
      ['P1', 'P2'],
      ['P2', 'P3'],
      ['P3', 'P4'],
    ])
    const unitIds = ['A', 'B', 'C', 'D']
    const edges = mkEdges([
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'D'],
    ])

    // 仅固定链首 A→P1：B/C/D 的上界未被收紧，最晚可到 P4
    const onlyHead = computeUnitIntervals(
      unitIds,
      input({ unitIds, edges, phases, constraints, assignments: mkAssignments([['A', 'P1']]) }),
    )
    expect(onlyHead.get('B')!.earliest).toEqual(['P1'])
    expect(onlyHead.get('B')!.latest).toEqual(['P4'])
    expect(onlyHead.get('B')!.exact).toBeNull()

    // 再固定链尾 D→P3：B、C 的区间被链式传播收紧到 [P1, P3]
    const both = computeUnitIntervals(
      unitIds,
      input({ unitIds, edges, phases, constraints, assignments: mkAssignments([['A', 'P1'], ['D', 'P3']]) }),
    )
    for (const id of ['B', 'C']) {
      const r = both.get(id)!
      expect(sorted(r.feasible)).toEqual(['P1', 'P2', 'P3'])
      expect(r.earliest).toEqual(['P1'])
      expect(r.latest).toEqual(['P3'])
      expect(r.exact).toBeNull()
    }
    expect(both.get('A')!.exact).toBe('P1')
    expect(both.get('D')!.exact).toBe('P3')
  })

  it('互不相连的层位保持覆盖全部阶段的宽区间', () => {
    const phases = mkPhases(['P1', 'P2', 'P3', 'P4'])
    const constraints = mkConstraints([
      ['P1', 'P2'],
      ['P2', 'P3'],
      ['P3', 'P4'],
    ])
    const unitIds = ['A', 'X']
    const edges: OrderEdge[] = [] // X 与任何层位都不相连
    const result = computeUnitIntervals(
      unitIds,
      input({ unitIds, edges, phases, constraints, assignments: mkAssignments([['A', 'P2']]) }),
    )
    const x = result.get('X')!
    expect(sorted(x.feasible)).toEqual(['P1', 'P2', 'P3', 'P4'])
    expect(x.earliest).toEqual(['P1'])
    expect(x.latest).toEqual(['P4'])
    expect(x.exact).toBeNull()
    expect(x.lower).toEqual([])
    expect(x.upper).toEqual([])
  })

  it('删除中间层位关系后，区间正确放宽', () => {
    const phases = mkPhases(['P1', 'P2', 'P3'])
    const constraints = mkConstraints([
      ['P1', 'P2'],
      ['P2', 'P3'],
    ])
    const unitIds = ['A', 'X', 'B']
    const assignments = mkAssignments([
      ['A', 'P1'],
      ['B', 'P2'],
    ])
    // A→X→B：X 被夹在 [P1, P2]
    const before = computeUnitIntervals(
      unitIds,
      input({ unitIds, edges: mkEdges([['A', 'X'], ['X', 'B']]), phases, constraints, assignments }),
    )
    expect(sorted(before.get('X')!.feasible)).toEqual(['P1', 'P2'])

    // 删除 X→B 后，上界证据消失：放宽为 [P1, P3]
    const after = computeUnitIntervals(
      unitIds,
      input({ unitIds, edges: mkEdges([['A', 'X']]), phases, constraints, assignments }),
    )
    expect(sorted(after.get('X')!.feasible)).toEqual(['P1', 'P2', 'P3'])
    expect(after.get('X')!.latest).toEqual(['P3'])
  })

  it('删除中间阶段约束后，区间正确放宽', () => {
    const phases = mkPhases(['P1', 'P2', 'P3'])
    const unitIds = ['U', 'V']
    const edges = mkEdges([['V', 'U']]) // V 早于 U
    const assignments = mkAssignments([['U', 'P2']])
    // P1<P2<P3：V 必须不晚于 P2，且 P3 被证明晚于 P2 → V ∈ {P1, P2}
    const before = computeUnitIntervals(
      unitIds,
      input({
        unitIds,
        edges,
        phases,
        constraints: mkConstraints([['P1', 'P2'], ['P2', 'P3']]),
        assignments,
      }),
    )
    expect(sorted(before.get('V')!.feasible)).toEqual(['P1', 'P2'])

    // 删除 P2→P3 后，P3 不再被证明晚于 P2 → V 放宽为全部阶段
    const after = computeUnitIntervals(
      unitIds,
      input({ unitIds, edges, phases, constraints: mkConstraints([['P1', 'P2']]), assignments }),
    )
    expect(sorted(after.get('V')!.feasible)).toEqual(['P1', 'P2', 'P3'])
  })

  it('层位关系与阶段顺序矛盾时，给出含层位链与阶段链的诊断', () => {
    const phases = mkPhases(['P1', 'P2'])
    const constraints = mkConstraints([['P1', 'P2']])
    const relations = [mkRelation('R1', 'A', 'B', 'earlier')]
    // A 属于较晚的 P2，B 属于较早的 P1，但层位关系为 A 早于 B
    const diagnostics = computeDiagnostics(
      input({
        unitIds: ['A', 'B'],
        edges: mkEdges([['A', 'B']]),
        phases,
        constraints,
        assignments: mkAssignments([
          ['A', 'P2'],
          ['B', 'P1'],
        ]),
        relations,
      }),
      labels,
    )
    expect(diagnostics).toHaveLength(1)
    const d = diagnostics[0]
    expect(d.kind).toBe('order-conflict')
    expect(d.unitPath).toEqual(['A', 'B'])
    expect(d.phasePath).toEqual(['P1', 'P2'])
    expect(d.relationIds).toEqual(['R1'])
    expect(sorted(d.phaseIds)).toEqual(['P1', 'P2'])
  })

  it('同期层位被分配到冲突阶段时，给出可定位诊断', () => {
    const phases = mkPhases(['P1', 'P2', 'P3'])
    const constraints = mkConstraints([
      ['P1', 'P2'],
      ['P2', 'P3'],
    ])
    const relations = [mkRelation('R9', 'X', 'Y', 'contemporary')]
    const diagnostics = computeDiagnostics(
      input({
        unitIds: ['X', 'Y'],
        edges: [],
        phases,
        constraints,
        assignments: mkAssignments([
          ['X', 'P1'],
          ['Y', 'P3'],
        ]),
        relations,
      }),
      labels,
    )
    expect(diagnostics).toHaveLength(1)
    const d = diagnostics[0]
    expect(d.kind).toBe('contemporary-conflict')
    expect(d.unitPath).toEqual(['X', 'Y'])
    expect(d.phasePath).toEqual(['P1', 'P2', 'P3'])
    expect(d.relationIds).toEqual(['R9'])
    expect(sorted(d.phaseIds)).toEqual(['P1', 'P2', 'P3'])
  })

  it('同期层位分配到同一阶段或不可比较阶段时不产生诊断', () => {
    const phases = mkPhases(['P1', 'P2'])
    const relations = [mkRelation('R9', 'X', 'Y', 'contemporary')]
    // 同一阶段
    const same = computeDiagnostics(
      input({
        unitIds: ['X', 'Y'],
        edges: [],
        phases,
        constraints: [],
        assignments: mkAssignments([
          ['X', 'P1'],
          ['Y', 'P1'],
        ]),
        relations,
      }),
      labels,
    )
    expect(same).toHaveLength(0)
    // 不可比较阶段（无约束）：可能同期，不武断判矛盾
    const incomparable = computeDiagnostics(
      input({
        unitIds: ['X', 'Y'],
        edges: [],
        phases,
        constraints: [],
        assignments: mkAssignments([
          ['X', 'P1'],
          ['Y', 'P2'],
        ]),
        relations,
      }),
      labels,
    )
    expect(incomparable).toHaveLength(0)
  })
})
