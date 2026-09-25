import Dexie, { type Table } from 'dexie'
import type {
  Batch,
  Evidence,
  Phase,
  PhaseAssignment,
  PhaseComputation,
  PhaseConstraint,
  PhaseDiagnostic,
  Relation,
  Retraction,
  StratUnit,
  UnitPhaseInterval,
  UnitPosition,
} from './types'

/**
 * 纯本地存储：所有现场资料只写入浏览器 IndexedDB，不发生任何网络上传。
 * 原始观察 / 推断关系（relations 表，以 source 区分）、被撤销判断（retractions 表）分开保存。
 *
 * v2 新增阶段推演六张表：阶段、阶段前后约束、层位分配（可撤销的用户数据），
 * 以及区间结果、计算版本、诊断（派生数据，随重算更新）。
 * 旧工程（v1）打开时自动升级，新表为空，不影响既有数据。
 */
class MatrixDB extends Dexie {
  units!: Table<StratUnit, string>
  positions!: Table<UnitPosition, string>
  relations!: Table<Relation, string>
  evidences!: Table<Evidence, string>
  retractions!: Table<Retraction, string>
  batches!: Table<Batch, string>
  phases!: Table<Phase, string>
  phaseConstraints!: Table<PhaseConstraint, string>
  phaseAssignments!: Table<PhaseAssignment, string>
  phaseResults!: Table<UnitPhaseInterval, string>
  phaseDiagnostics!: Table<PhaseDiagnostic, string>
  phaseComputations!: Table<PhaseComputation, string>

  constructor() {
    super('harris-matrix')
    this.version(1).stores({
      units: 'id',
      positions: 'unitId',
      relations: 'id, from, to, status',
      evidences: 'id',
      retractions: 'id, relationId',
      batches: 'id, at',
    })
    this.version(2).stores({
      phases: 'id',
      phaseConstraints: 'id',
      phaseAssignments: 'unitId',
      phaseResults: 'unitId, versionId',
      phaseDiagnostics: 'id, computationId',
      phaseComputations: 'id, at',
    })
  }
}

export const db = new MatrixDB()
