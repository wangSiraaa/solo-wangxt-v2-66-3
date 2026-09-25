import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { canonicalDiagnostics, canonicalResults } from './phasing'
import {
  addPhase,
  addPhaseConstraint,
  addRelation,
  addUnit,
  assignUnitPhase,
  buildExport,
  clearAll,
  importData,
  intervalByUnit,
  markPhaseValid,
  recomputePhases,
  refresh,
  removePhaseConstraint,
  retractRelation,
  state,
  unassignUnit,
} from './store'
import type { ProjectExport, RelationDraft } from './types'

const sorted = (xs: string[]) => [...xs].sort()

function unitId(label: string): string {
  return state.units.find((u) => u.label === label)!.id
}

function phaseId(label: string): string {
  return state.phases.find((p) => p.label === label)!.id
}

function draft(from: string, to: string, kind: RelationDraft['kind'] = 'earlier'): RelationDraft {
  return { from, to, kind, source: 'observation', evidenceIds: [], note: '' }
}

/** 搭建 P1<P2<P3<P4 阶段框架 */
async function setupPhases(labels: string[] = ['P1', 'P2', 'P3', 'P4']) {
  for (const label of labels) await addPhase(label, '')
  for (let i = 0; i + 1 < labels.length; i++) await addPhaseConstraint(phaseId(labels[i]), phaseId(labels[i + 1]), '')
}

async function setupUnits(labels: string[]) {
  for (const label of labels) await addUnit(label, 'deposit', '')
}

beforeEach(async () => {
  await clearAll(false)
})

describe('阶段区间推演（含持久化）', () => {
  it('链式关系传播收紧上下界；刷新后区间与诊断保持一致', async () => {
    await setupPhases()
    await setupUnits(['A', 'B', 'C', 'D'])
    await addRelation(draft(unitId('A'), unitId('B')))
    await addRelation(draft(unitId('B'), unitId('C')))
    await addRelation(draft(unitId('C'), unitId('D')))
    await assignUnitPhase(unitId('A'), phaseId('P1'))
    await assignUnitPhase(unitId('D'), phaseId('P3'))

    // B、C 被链式传播收紧到 [P1, P3]，不武断给出单值
    for (const label of ['B', 'C']) {
      const r = intervalByUnit.value.get(unitId(label))!
      expect(sorted(r.feasible)).toEqual([phaseId('P1'), phaseId('P2'), phaseId('P3')].sort())
      expect(r.earliest).toEqual([phaseId('P1')])
      expect(r.latest).toEqual([phaseId('P3')])
      expect(r.exact).toBeNull()
    }
    expect(intervalByUnit.value.get(unitId('A'))!.exact).toBe(phaseId('P1'))

    // 结果版本已持久化；模拟刷新（从 IndexedDB 重载）后区间一致
    const beforeResults = canonicalResults(state.versions[state.versions.length - 1].results)
    const beforeDiags = canonicalDiagnostics(state.diagnostics)
    const versionCount = state.versions.length
    await refresh()
    expect(state.versions.length).toBe(versionCount)
    expect(canonicalResults(state.versions[state.versions.length - 1].results)).toBe(beforeResults)
    expect(canonicalDiagnostics(state.diagnostics)).toBe(beforeDiags)
  })

  it('互不相连层位保持宽区间', async () => {
    await setupPhases()
    await setupUnits(['A', 'X'])
    await assignUnitPhase(unitId('A'), phaseId('P2'))
    const x = intervalByUnit.value.get(unitId('X'))!
    expect(sorted(x.feasible)).toEqual(sorted(state.phases.map((p) => p.id)))
    expect(x.earliest).toEqual([phaseId('P1')])
    expect(x.latest).toEqual([phaseId('P4')])
    expect(x.exact).toBeNull()
  })

  it='' // placeholder
})
