import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import Dexie from 'dexie'

/**
 * 旧工程（v1，无阶段表）直接打开：Dexie 自动升级 schema，
 * 既有层位/关系数据保留，阶段体系为空且可正常补建。
 */
describe('旧工程（v1）直接打开', () => {
  it('v1 数据升级后保留，阶段功能可正常使用', async () => {
    // 模拟旧版本数据库：只有 v1 的六张表
    const v1 = new Dexie('harris-matrix')
    v1.version(1).stores({
      units: 'id',
      positions: 'unitId',
      relations: 'id, from, to, status',
      evidences: 'id',
      retractions: 'id, relationId',
      batches: 'id, at',
    })
    await v1.table('units').put({ id: 'u1', label: '1001', type: 'deposit', note: '旧工程层位', createdAt: 1 })
    await v1.table('relations').put({
      id: 'r1',
      from: 'u1',
      to: 'u2',
      kind: 'earlier',
      source: 'observation',
      status: 'active',
      conflict: false,
      evidenceIds: [],
      note: '',
      createdAt: 1,
    })
    await v1.close()

    // 打开应用（v2 schema）：升级应透明完成
    const store = await import('./store')
    await store.refresh()
    expect(store.state.units.map((u) => u.label)).toEqual(['1001'])
    expect(store.state.relations).toHaveLength(1)
    expect(store.state.phases).toEqual([])
    expect(store.state.phaseComputations).toEqual([])

    // 升级后可以正常建立阶段体系并推演
    await store.addPhase('一期', '')
    expect(store.state.phases).toHaveLength(1)
    expect(store.state.phaseComputations.length).toBeGreaterThan(0)
    expect(store.state.phaseIntervals['u1'].feasiblePhaseIds).toHaveLength(1)
  })
})
