import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import {
  addPhase,
  addPhaseConstraint,
  addRelation,
  addUnit,
  approveCurrentPhases,
  assignUnitPhase,
  buildExportData,
  clearAll,
  currentPhaseComputation,
  importProjectData,
  loadSample,
  refresh,
  removePhaseConstraint,
  state,
  undo,
} from './store'
import type { RelationDraft } from './types'

const unitId = (label: string) => state.units.find((u) => u.label === label)!.id
const phaseId = (label: string) => state.phases.find((p) => p.label === label)!.id

const earlier = (from: string, to: string): RelationDraft => ({
  from: unitId(from),
  to: unitId(to),
  kind: 'earlier',
  source: 'observation',
  evidenceIds: [],
  note: '',
})

/** 依次创建 一期<二期<…<n 期 的线序阶段 */
async function setupPhases(labels: string[]) {
  for (const label of labels) await addPhase(label, '')
  for (let i = 1; i < labels.length; i++) await addPhaseConstraint(phaseId(labels[i - 1]), phaseId(labels[i]))
}

beforeEach(async () => {
  await clearAll(false)
})

describe('阶段推演：持久化与刷新', () => {
  it('链式关系收紧上下界、孤立层位保持宽区间，刷新后结果一致', async () => {
    for (const l of ['A', 'B', 'C', 'D', 'X']) await addUnit(l, 'deposit', '')
    await setupPhases(['一期', '二期', '三期', '四期'])
    await addRelation(earlier('A', 'B'))
    await addRelation(earlier('B', 'C'))
    await addRelation(earlier('C', 'D'))
    await assignUnitPhase(unitId('A'), phaseId('一期'))
    await assignUnitPhase(unitId('D'), phaseId('二期'))

    // 链式传播：B、C 被夹逼到 [一期, 二期]
    expect(state.phaseIntervals[unitId('B')].feasiblePhaseIds).toEqual([phaseId('一期'), phaseId('二期')])
    expect(state.phaseIntervals[unitId('C')].feasiblePhaseIds).toEqual([phaseId('一期'), phaseId('二期')])
    // 孤立层位 X：全区间
    expect(state.phaseIntervals[unitId('X')].feasiblePhaseIds).toHaveLength(4)

    // 结果已持久化到 IndexedDB
    const row = await db.phaseResults.get(unitId('B'))
    expect(row!.earliestPhaseId).toBe(phaseId('一期'))
    expect(row!.latestPhaseId).toBe(phaseId('二期'))
    expect(state.phaseComputations.length).toBeGreaterThan(0)

    // 模拟刷新：从 IndexedDB 重载，区间/顺序/诊断完全一致
    const before = JSON.stringify({
      intervals: state.phaseIntervals,
      diagnostics: state.phaseDiagnostics,
      order: currentPhaseComputation.value?.phaseOrder,
    })
    await refresh()
    const after = JSON.stringify({
      intervals: state.phaseIntervals,
      diagnostics: state.phaseDiagnostics,
      order: currentPhaseComputation.value?.phaseOrder,
    })
    expect(after).toBe(before)
  })

  it('删除中间约束后区间正确放宽', async () => {
    await addUnit('A', 'deposit', '')
    await addUnit('M', 'deposit', '')
    await setupPhases(['一期', '二期', '三期'])
    await addRelation(earlier('A', 'M'))
    await assignUnitPhase(unitId('A'), phaseId('三期'))

    // A 归属三期且 A→M：M 被唯一定位到三期
    expect(state.phaseIntervals[unitId('M')].feasiblePhaseIds).toEqual([phaseId('三期')])

    // 删除中间约束（二期<三期）后：M 放宽到全部三个阶段（集合意义）
    const c23 = state.phaseConstraints.find((c) => c.before === phaseId('二期') && c.after === phaseId('三期'))!
    await removePhaseConstraint(c23.id)
    expect([...state.phaseIntervals[unitId('M')].feasiblePhaseIds].sort()).toEqual(
      [phaseId('一期'), phaseId('二期'), phaseId('三期')].sort(),
    )
  })
})

describe('阶段推演：增量重算', () => {
  it('调整关系只重算受影响分量，互不相连层位的结果与版本号不变', async () => {
    for (const l of ['A', 'B', 'X', 'Y']) await addUnit(l, 'deposit', '')
    await setupPhases(['一期', '二期', '三期'])
    await addRelation(earlier('A', 'B'))
    await addRelation(earlier('X', 'Y'))
    const versionsBefore = state.phaseComputations.length
    const xRowBefore = state.phaseIntervals[unitId('X')]
    const yRowBefore = state.phaseIntervals[unitId('Y')]

    // 在 {A,B} 分量中分配阶段：只有该分量被重算
    await assignUnitPhase(unitId('A'), phaseId('二期'))

    const cur = currentPhaseComputation.value!
    expect(state.phaseComputations.length).toBe(versionsBefore + 1)
    expect(cur.affectedUnitIds.sort()).toEqual([unitId('A'), unitId('B')].sort())
    // B 被收紧（不得早于二期），X/Y 保持宽区间且沿用旧版本号
    expect(state.phaseIntervals[unitId('B')].feasiblePhaseIds).toEqual([phaseId('二期'), phaseId('三期')])
    expect(state.phaseIntervals[unitId('X')].versionId).toBe(xRowBefore.versionId)
    expect(state.phaseIntervals[unitId('Y')].versionId).toBe(yRowBefore.versionId)
    expect(state.phaseIntervals[unitId('X')].feasiblePhaseIds).toHaveLength(3)
  })

  it('撤销分配后区间随之恢复', async () => {
    await addUnit('A', 'deposit', '')
    await addUnit('B', 'deposit', '')
    await setupPhases(['一期', '二期', '三期'])
    await addRelation(earlier('A', 'B'))
    await assignUnitPhase(unitId('A'), phaseId('二期'))
    expect(state.phaseIntervals[unitId('B')].feasiblePhaseIds).toEqual([phaseId('二期'), phaseId('三期')])
    await undo()
    expect(state.phaseIntervals[unitId('B')].feasiblePhaseIds).toHaveLength(3)
  })
})

describe('阶段推演：矛盾诊断与有效性', () => {
  it('同期层位被分配到冲突阶段：生成可定位诊断并阻止标记有效，原始关系保留', async () => {
    await addUnit('U', 'deposit', '')
    await addUnit('V', 'deposit', '')
    await setupPhases(['一期', '二期'])
    await addRelation({ from: unitId('U'), to: unitId('V'), kind: 'contemporary', source: 'observation', evidenceIds: [], note: '' })
    await assignUnitPhase(unitId('U'), phaseId('一期'))
    await assignUnitPhase(unitId('V'), phaseId('二期'))

    // 诊断含证据路径：同期关系 + 两条分配
    expect(state.phaseDiagnostics).toHaveLength(1)
    const d = state.phaseDiagnostics[0]
    expect(d.kind).toBe('contemporary-conflict')
    expect(d.path.some((s) => s.kind === 'contemporary')).toBe(true)
    expect(d.path.filter((s) => s.kind === 'assignment')).toHaveLength(2)
    expect(currentPhaseComputation.value!.valid).toBe(false)

    // 阻止标记为有效
    await approveCurrentPhases()
    expect(currentPhaseComputation.value!.approved).toBe(false)
    expect(state.toast).toContain('无法')

    // 原始同期关系仍保留
    expect(state.relations.some((r) => r.kind === 'contemporary' && r.status === 'active')).toBe(true)

    // 解除冲突分配后诊断消失，可以标记有效
    await assignUnitPhase(unitId('V'), null)
    expect(state.phaseDiagnostics).toHaveLength(0)
    expect(currentPhaseComputation.value!.valid).toBe(true)
    await approveCurrentPhases()
    expect(currentPhaseComputation.value!.approved).toBe(true)
  })

  it('层位关系与阶段顺序矛盾：诊断含关系链证据路径', async () => {
    await addUnit('A', 'deposit', '')
    await addUnit('M', 'deposit', '')
    await addUnit('B', 'deposit', '')
    await setupPhases(['一期', '二期'])
    await addRelation(earlier('A', 'M'))
    await addRelation(earlier('M', 'B'))
    await assignUnitPhase(unitId('A'), phaseId('二期'))
    await assignUnitPhase(unitId('B'), phaseId('一期'))

    const d = state.phaseDiagnostics.find((x) => x.kind === 'order-conflict')
    expect(d).toBeDefined()
    // 证据路径沿关系链 A→M→B 定位
    expect(d!.path.filter((s) => s.kind === 'relation')).toHaveLength(2)
    expect(d!.path.some((s) => s.kind === 'constraint')).toBe(true)
    expect(currentPhaseComputation.value!.valid).toBe(false)
    // 中间层位 M 被夹逼到空区间
    expect(state.phaseIntervals[unitId('M')].conflict).toBe(true)
  })
})

describe('阶段推演：导出/导入一致性', () => {
  it('JSON 导出再导入后阶段顺序、区间和矛盾证据一致', async () => {
    for (const l of ['A', 'B', 'C', 'U', 'V']) await addUnit(l, 'deposit', '')
    await setupPhases(['一期', '二期', '三期'])
    await addRelation(earlier('A', 'B'))
    await addRelation(earlier('B', 'C'))
    await addRelation({ from: unitId('U'), to: unitId('V'), kind: 'contemporary', source: 'observation', evidenceIds: [], note: '' })
    await assignUnitPhase(unitId('A'), phaseId('一期'))
    await assignUnitPhase(unitId('C'), phaseId('二期'))
    // 制造一个同期冲突诊断
    await assignUnitPhase(unitId('U'), phaseId('一期'))
    await assignUnitPhase(unitId('V'), phaseId('二期'))
    expect(state.phaseDiagnostics.length).toBeGreaterThan(0)

    const exported = JSON.parse(JSON.stringify(buildExportData()))
    // 区间快照不含版本号（导入后重算会产生新版本，区间内容必须一致）
    const stripVersion = (iv: Record<string, { feasiblePhaseIds: string[]; earliestPhaseId: string | null; latestPhaseId: string | null; conflict: boolean }>) =>
      Object.fromEntries(
        Object.entries(iv).map(([k, v]) => [k, [v.earliestPhaseId, v.latestPhaseId, v.feasiblePhaseIds, v.conflict]]),
      )
    const intervalSnapshot = JSON.stringify(stripVersion(state.phaseIntervals))
    const diagSnapshot = JSON.stringify(state.phaseDiagnostics.map((d) => [d.id, d.kind, d.message, d.path]))
    const orderSnapshot = currentPhaseComputation.value!.phaseOrder

    await clearAll(false)
    expect(state.units).toHaveLength(0)

    const result = await importProjectData(exported)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('矛盾证据一致')

    // 阶段顺序、区间、矛盾证据与导出前一致
    expect(currentPhaseComputation.value!.phaseOrder).toEqual(orderSnapshot)
    expect(JSON.stringify(stripVersion(state.phaseIntervals))).toBe(intervalSnapshot)
    expect(JSON.stringify(state.phaseDiagnostics.map((d) => [d.id, d.kind, d.message, d.path]))).toBe(diagSnapshot)
  })

  it('v1 旧格式文件（无阶段数据）可导入', async () => {
    await addUnit('A', 'deposit', '')
    const data = JSON.parse(JSON.stringify(buildExportData()))
    data.version = 1
    delete data.phases
    delete data.phaseConstraints
    delete data.phaseAssignments
    delete data.phaseIntervals
    delete data.phaseDiagnostics
    delete data.phaseOrder
    await clearAll(false)
    const result = await importProjectData(data)
    expect(result.ok).toBe(true)
    expect(state.units).toHaveLength(1)
    expect(state.phases).toHaveLength(0)
  })
})

describe('示例工程的阶段推演', () => {
  it('示例载入后阶段方案无矛盾，区间符合预期', async () => {
    await loadSample()
    // 三期线序 + 三个直接归属，整体无矛盾
    expect(state.phaseDiagnostics).toHaveLength(0)
    expect(currentPhaseComputation.value!.valid).toBe(true)
    expect(currentPhaseComputation.value!.phaseOrder.map((id) => state.phases.find((p) => p.id === id)!.label)).toEqual([
      '早期',
      '中期',
      '晚期',
    ])
    const iv = (label: string) => state.phaseIntervals[unitId(label)]
    const ph = (label: string) => phaseId(label)
    // 1001 被表土关系唯一定位到晚期；1012/1015 同期组收紧到 [早期, 中期]；孤立层位 1018 保持全区间
    expect(iv('1001').feasiblePhaseIds).toEqual([ph('晚期')])
    expect(iv('1012').feasiblePhaseIds).toEqual([ph('早期'), ph('中期')])
    expect(iv('1015').feasiblePhaseIds).toEqual([ph('早期'), ph('中期')])
    expect(iv('1018').feasiblePhaseIds).toEqual([ph('早期'), ph('中期'), ph('晚期')])
  })
})
