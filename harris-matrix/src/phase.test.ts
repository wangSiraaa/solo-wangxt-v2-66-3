import { describe, expect, it } from 'vitest'
import { computePhaseModel, componentsOf, type PhaseEngineInput } from './phase'
import type { Phase, PhaseAssignment, PhaseConstraint } from './types'
import type { OrderEdge } from './graph'

/** 线性阶段序列 P1..Pn */
const phases = (n: number): Phase[] =>
  Array.from({ length: n }, (_, i) => ({ id: `P${i + 1}`, label: `P${i + 1}`, note: '', createdAt: i }))

/** 依次相连的阶段约束链 idList[0] < idList[1] < … */
const chain = (idList: string[]): PhaseConstraint[] =>
  idList.slice(1).map((after, i) => ({ id: `C${i}`, before: idList[i], after, createdAt: i }))

const asg = (unitId: string, phaseId: string): PhaseAssignment => ({ unitId, phaseId, createdAt: 0 })

const edge = (id: string, from: string, to: string): OrderEdge => ({ id, from, to })

const base = (over: Partial<PhaseEngineInput>): PhaseEngineInput => ({
  unitIds: [],
  orderEdges: [],
  contemporary: [],
  phases: [],
  constraints: [],
  assignments: [],
  ...over,
})

const interval = (input: PhaseEngineInput, unitId: string) => computePhaseModel(input).intervals.get(unitId)!

describe('阶段区间推演引擎', () => {
  it('链式关系传播并收紧上下界', () => {
    // A→B→C→D，A 归属 P1、D 归属 P2：中间层位被两端夹逼收紧
    const input = base({
      unitIds: ['A', 'B', 'C', 'D'],
      orderEdges: [edge('R1', 'A', 'B'), edge('R2', 'B', 'C'), edge('R3', 'C', 'D')],
      phases: phases(4),
      constraints: chain(['P1', 'P2', 'P3', 'P4']),
      assignments: [asg('A', 'P1'), asg('D', 'P2')],
    })
    const model = computePhaseModel(input)
    expect(model.valid).toBe(true)
    expect(model.phaseOrder).toEqual(['P1', 'P2', 'P3', 'P4'])
    // 下界由 A 传播、上界由 D 传播：B、C 收紧到 [P1, P2]
    expect(model.intervals.get('B')!.feasiblePhaseIds).toEqual(['P1', 'P2'])
    expect(model.intervals.get('B')!.earliestPhaseId).toBe('P1')
    expect(model.intervals.get('B')!.latestPhaseId).toBe('P2')
    expect(model.intervals.get('C')!.feasiblePhaseIds).toEqual(['P1', 'P2'])
    // 已分配层位唯一定位
    expect(model.intervals.get('A')!.feasiblePhaseIds).toEqual(['P1'])
    expect(model.intervals.get('D')!.feasiblePhaseIds).toEqual(['P2'])
  })

  it('互不相连的层位保持宽区间', () => {
    const input = base({
      unitIds: ['A', 'B', 'X', 'Y'],
      orderEdges: [edge('R1', 'A', 'B')],
      phases: phases(4),
      constraints: chain(['P1', 'P2', 'P3', 'P4']),
      assignments: [asg('A', 'P1')],
    })
    // X、Y 与任何层位都无关系：覆盖全部阶段
    expect(interval(input, 'X').feasiblePhaseIds).toEqual(['P1', 'P2', 'P3', 'P4'])
    expect(interval(input, 'Y').feasiblePhaseIds).toEqual(['P1', 'P2', 'P3', 'P4'])
    expect(interval(input, 'X').conflict).toBe(false)
    // B 只受单侧约束：不得早于 P1，上界不受限
    expect(interval(input, 'B').feasiblePhaseIds).toEqual(['P1', 'P2', 'P3', 'P4'])
  })

  it('删除中间约束后区间正确放宽', () => {
    const constraints = chain(['P1', 'P2', 'P3']) // C0: P1<P2，C1: P2<P3
    const withFull = base({
      unitIds: ['A', 'M'],
      orderEdges: [edge('R1', 'A', 'M')],
      phases: phases(3),
      constraints,
      assignments: [asg('A', 'P3')],
    })
    // A 归属 P3 且 A→M：M 不得早于 P3，被唯一定位到 P3
    expect(interval(withFull, 'M').feasiblePhaseIds).toEqual(['P3'])

    // 删除中间约束 C1（P2<P3）后：P3 之前不再有已知阶段，M 放宽到全区间
    const withoutMiddle = base({
      unitIds: ['A', 'M'],
      orderEdges: [edge('R1', 'A', 'M')],
      phases: phases(3),
      constraints: constraints.filter((c) => c.id !== 'C1'),
      assignments: [asg('A', 'P3')],
    })
    expect(interval(withoutMiddle, 'M').feasiblePhaseIds).toEqual(['P1', 'P2', 'P3'])
    expect(interval(withoutMiddle, 'M').earliestPhaseId).toBe('P1')
    expect(interval(withoutMiddle, 'M').latestPhaseId).toBe('P3')
  })

  it('同期层位被分配到冲突阶段时给出可定位诊断', () => {
    const input = base({
      unitIds: ['U', 'V'],
      contemporary: [{ id: 'RC1', a: 'U', b: 'V' }],
      phases: phases(2),
      constraints: chain(['P1', 'P2']),
      assignments: [asg('U', 'P1'), asg('V', 'P2')],
    })
    const model = computePhaseModel(input)
    expect(model.valid).toBe(false)
    const d = model.diagnostics.find((x) => x.kind === 'contemporary-conflict')
    expect(d).toBeDefined()
    // 证据路径可定位：同期关系 + 两条分配 + 阶段约束
    expect(d!.path.some((s) => s.kind === 'contemporary' && s.refId === 'RC1')).toBe(true)
    expect(d!.path.filter((s) => s.kind === 'assignment').map((s) => s.refId).sort()).toEqual(['U', 'V'])
    expect(d!.path.some((s) => s.kind === 'constraint' && s.refId === 'C0')).toBe(true)
    // 诊断 id 由内容决定，重算稳定
    expect(computePhaseModel(input).diagnostics.map((x) => x.id)).toEqual(model.diagnostics.map((x) => x.id))
  })

  it('层位关系与阶段顺序矛盾：给出含证据路径的诊断且结果无效', () => {
    // A→M→B，但 A 归属较晚的 P2、B 归属较早的 P1
    const input = base({
      unitIds: ['A', 'M', 'B'],
      orderEdges: [edge('R1', 'A', 'M'), edge('R2', 'M', 'B')],
      phases: phases(2),
      constraints: chain(['P1', 'P2']),
      assignments: [asg('A', 'P2'), asg('B', 'P1')],
    })
    const model = computePhaseModel(input)
    expect(model.valid).toBe(false)
    const d = model.diagnostics.find((x) => x.kind === 'order-conflict')
    expect(d).toBeDefined()
    // 证据路径：沿关系链 A→M→B 定位，含两条分配与阶段约束
    expect(d!.path.filter((s) => s.kind === 'relation').map((s) => s.refId)).toEqual(['R1', 'R2'])
    expect(d!.path.filter((s) => s.kind === 'assignment').map((s) => s.refId).sort()).toEqual(['A', 'B'])
    expect(d!.path.some((s) => s.kind === 'constraint')).toBe(true)
    // 中间层位 M 被夹逼到空区间，且已被 order-conflict 覆盖，不重复诊断
    expect(model.intervals.get('M')!.conflict).toBe(true)
    expect(model.diagnostics.filter((x) => x.kind === 'empty-interval')).toHaveLength(0)
  })

  it('阶段约束成环：诊断且阶段顺序无效', () => {
    const input = base({
      unitIds: ['A'],
      phases: phases(3),
      constraints: [...chain(['P1', 'P2', 'P3']), { id: 'C9', before: 'P3', after: 'P1', createdAt: 9 }],
    })
    const model = computePhaseModel(input)
    expect(model.valid).toBe(false)
    const d = model.diagnostics.find((x) => x.kind === 'phase-cycle')
    expect(d).toBeDefined()
    expect(d!.path.length).toBeGreaterThanOrEqual(3) // 完整环路径
  })

  it('连通分量：增量重算的受影响范围', () => {
    const comps = componentsOf(
      ['A', 'B', 'C', 'X'],
      [edge('R1', 'A', 'B')],
      [{ id: 'RC', a: 'B', b: 'C' }],
    )
    expect([...(comps.get('A') ?? [])].sort()).toEqual(['A', 'B', 'C'])
    expect(comps.get('A')).toBe(comps.get('B')) // 同一分量
    expect([...(comps.get('X') ?? [])]).toEqual(['X']) // 孤立层位独立分量
  })

  it('相同输入产出完全一致的结果（导出/导入一致性的基础）', () => {
    const input = base({
      unitIds: ['A', 'M', 'B'],
      orderEdges: [edge('R1', 'A', 'M'), edge('R2', 'M', 'B')],
      phases: phases(3),
      constraints: chain(['P1', 'P2', 'P3']),
      assignments: [asg('A', 'P1'), asg('B', 'P3')],
    })
    const m1 = computePhaseModel(input)
    const m2 = computePhaseModel(input)
    expect(m2.phaseOrder).toEqual(m1.phaseOrder)
    for (const u of input.unitIds) {
      expect(m2.intervals.get(u)).toEqual(m1.intervals.get(u))
    }
    expect(m2.diagnostics).toEqual(m1.diagnostics)
  })
})
