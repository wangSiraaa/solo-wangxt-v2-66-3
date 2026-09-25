import Dexie, { type Table } from 'dexie'
import type {
  Batch,
  ComputationVersion,
  Evidence,
  Phase,
  PhaseAssignment,
  PhaseConstraint,
  PhaseDiagnostic,
  Relation,
  Retraction,
  StratUnit,
  UnitPosition,
} from './types'

/**
 * 纯本地存储：所有现场资料只写入浏览器 IndexedDB，不发生任何网络上传。
 * 原始观察 / 推断关系（relations 表，以 source 区分）、被撤销判断（retractions 表）分开保存。
 * version(2) 新增阶段推演相关表；保留 version(1) 定义，旧工程打开时由 Dexie 自动升级，数据不动。
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
  assignments!: Table<PhaseAssignment, string>
  versions!: Table<ComputationVersion, string>
  diagnostics!: Table<PhaseDiagnostic, string>

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
      assignments: 'unitId',
      versions: 'id, at',
      diagnostics: 'id',
    })
  }
}

export const db = new MatrixDB()
