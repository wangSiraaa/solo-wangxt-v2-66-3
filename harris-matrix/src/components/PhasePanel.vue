<script setup lang="ts">
import { computed, reactive } from 'vue'
import {
  addPhase,
  addPhaseConstraint,
  assignUnitPhase,
  deletePhase,
  diagnosticsForPhase,
  intervalByUnit,
  latestVersion,
  markPhaseValid,
  phaseLabel,
  removePhaseConstraint,
  state,
  unassignUnit,
  unitLabel,
  unmarkPhaseValid,
} from '../store'
import type { PhaseDiagnostic, UnitInterval } from '../types'

const phaseForm = reactive({ label: '', note: '' })
const constraintForm = reactive({ from: '', to: '', note: '' })
const assignForm = reactive({ unitId: '', phaseId: '' })

const unassignedUnits = computed(() => state.units.filter((u) => !state.assignments[u.id]))
const assignmentList = computed(() =>
  Object.values(state.assignments).sort((a, b) => unitLabel(a.unitId).localeCompare(unitLabel(b.unitId), 'zh-CN')),
)

/** 区间文本：不能唯一定位时给出区间，绝不武断给出单值 */
function intervalText(r: UnitInterval | undefined): string {
  if (!r) return '暂无结果'
  if (r.feasible.length === 0) return '无可行阶段（证据互相矛盾）'
  if (r.exact) return `确定为 ${phaseLabel(r.exact)}`
  const earliest = r.earliest.map(phaseLabel).join('、')
  const latest = r.latest.map(phaseLabel).join('、')
  if (r.feasible.length === state.phases.length) return `全部阶段皆可能（${earliest} ～ ${latest}）`
  return `最早 ${earliest} ～ 最晚 ${latest}`
}

function evidenceText(r: UnitInterval | undefined): string {
  if (!r) return ''
  const parts: string[] = []
  if (r.lower.length > 0) parts.push(`不早于 ${r.lower.map(phaseLabel).join('、')}`)
  if (r.upper.length > 0) parts.push(`不晚于 ${r.upper.map(phaseLabel).join('、')}`)
  return parts.length > 0 ? `证据：${parts.join('；')}` : '无阶段证据约束'
}

async function submitPhase() {
  await addPhase(phaseForm.label, phaseForm.note)
  phaseForm.label = ''
  phaseForm.note = ''
}

async function submitConstraint() {
  await addPhaseConstraint(constraintForm.from, constraintForm.to, constraintForm.note)
  constraintForm.note = ''
}

async function submitAssign() {
  if (!assignForm.unitId || !assignForm.phaseId) return
  await assignUnitPhase(assignForm.unitId, assignForm.phaseId)
  assignForm.unitId = ''
}

function confirmDeletePhase(id: string, label: string) {
  if (window.confirm(`删除阶段 ${label}？涉及它的约束与层位分配将一并删除（可整体撤销）。`)) {
    void deletePhase(id)
  }
}

function toggleValid(id: string, valid: boolean) {
  if (valid) void unmarkPhaseValid(id)
  else void markPhaseValid(id)
}

function diagKindName(d: PhaseDiagnostic): string {
  return d.kind === 'order-conflict' ? '先后冲突' : '同期冲突'
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <section class="panel">
    <h3>阶段（{{ state.phases.length }}）</h3>
    <form class="form" @submit.prevent="submitPhase">
      <div class="row">
        <input v-model="phaseForm.label" placeholder="阶段名，如 第二期" required />
        <input v-model="phaseForm.note" placeholder="备注（可选）" />
      </div>
      <button type="submit">新增阶段</button>
    </form>
    <ul class="list">
      <li v-for="p in state.phases" :key="p.id">
        <span class="grow">
          <b>{{ p.label }}</b>
          <span v-if="p.valid" class="tag valid">有效</span>
          <span v-if="diagnosticsForPhase(p.id).length" class="tag conflict">
            {{ diagnosticsForPhase(p.id).length }} 条矛盾
          </span>
          <small v-if="p.note">　{{ p.note }}</small>
          <br />
          <small class="muted">已分配 {{ assignmentList.filter((a) => a.phaseId === p.id).length }} 个层位</small>
        </span>
        <button
          class="sm"
          :title="p.valid ? '取消有效标记' : '确认该阶段与层位关系无矛盾后标记为有效'"
          @click="toggleValid(p.id, p.valid)"
        >
          {{ p.valid ? '取消有效' : '标记有效' }}
        </button>
        <button class="danger sm" title="删除阶段" @click="confirmDeletePhase(p.id, p.label)">删</button>
      </li>
      <li v-if="state.phases.length === 0" class="muted">暂无阶段</li>
    </ul>
  </section>

  <section class="panel">
    <h3>阶段前后约束（{{ state.phaseConstraints.length }}）</h3>
    <form class="form" @submit.prevent="submitConstraint">
      <div class="row">
        <select v-model="constraintForm.from" required>
          <option value="" disabled>较早阶段</option>
          <option v-for="p in state.phases" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
        <span class="muted">早于</span>
        <select v-model="constraintForm.to" required>
          <option value="" disabled>较晚阶段</option>
          <option v-for="p in state.phases" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
      </div>
      <input v-model="constraintForm.note" placeholder="备注（可选）" />
      <button type="submit" :disabled="state.phases.length < 2">添加约束</button>
      <p class="hint">约束为可选；阶段偏序必须保持无环，成环将被拒绝。</p>
    </form>
    <ul class="list">
      <li v-for="c in state.phaseConstraints" :key="c.id">
        <span class="grow">
          {{ phaseLabel(c.from) }} 早于 {{ phaseLabel(c.to) }}
          <small v-if="c.note" class="muted">　{{ c.note }}</small>
        </span>
        <button class="danger sm" title="删除约束（相关区间将放宽重算）" @click="removePhaseConstraint(c.id)">删</button>
      </li>
      <li v-if="state.phaseConstraints.length === 0" class="muted">暂无约束</li>
    </ul>
  </section>

  <section class="panel">
    <h3>层位分配（{{ assignmentList.length }}）</h3>
    <form class="form" @submit.prevent="submitAssign">
      <div class="row">
        <select v-model="assignForm.unitId" required>
          <option value="" disabled>选择层位</option>
          <option v-for="u in state.units" :key="u.id" :value="u.id">
            {{ u.label }}{{ state.assignments[u.id] ? `（现属 ${phaseLabel(state.assignments[u.id].phaseId)}）` : '' }}
          </option>
        </select>
        <select v-model="assignForm.phaseId" required>
          <option value="" disabled>分配到阶段</option>
          <option v-for="p in state.phases" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
      </div>
      <button type="submit" :disabled="state.phases.length === 0 || unassignedUnits.length === 0 && !assignForm.unitId">
        分配 / 改派
      </button>
    </form>
    <ul class="list">
      <li v-for="a in assignmentList" :key="a.unitId">
        <span class="grow">
          <b>{{ unitLabel(a.unitId) }}</b> → {{ phaseLabel(a.phaseId) }}
        </span>
        <button class="danger sm" title="移除分配" @click="unassignUnit(a.unitId)">移除</button>
      </li>
      <li v-if="assignmentList.length === 0" class="muted">暂无分配</li>
    </ul>
  </section>

  <section class="panel">
    <h3>相对年代区间</h3>
    <p v-if="latestVersion" class="hint">
      版本 {{ fmtTime(latestVersion.at) }}　触发：{{ latestVersion.cause }}　本次重算
      {{ latestVersion.affectedUnitIds.length }} / {{ state.units.length }} 个层位
    </p>
    <p v-else class="hint">建立阶段并分配层位后，此处显示推演结果。</p>
    <ul class="list">
      <li v-for="u in state.units" :key="u.id">
        <span class="grow">
          <b>{{ u.label }}</b>
          <span v-if="state.assignments[u.id]" class="tag assigned">
            已分配 {{ phaseLabel(state.assignments[u.id].phaseId) }}
          </span>
          <br />
          <small>{{ intervalText(intervalByUnit.get(u.id)) }}</small>
          <br />
          <small class="muted">{{ evidenceText(intervalByUnit.get(u.id)) }}</small>
        </span>
      </li>
      <li v-if="state.units.length === 0" class="muted">暂无层位</li>
    </ul>
  </section>

  <section class="panel">
    <h3>矛盾诊断（{{ state.diagnostics.length }}）</h3>
    <ul class="list">
      <li v-for="d in state.diagnostics" :key="d.id" class="diag">
        <span class="grow">
          <span class="tag conflict">{{ diagKindName(d) }}</span>
          {{ d.message }}
          <br />
          <small class="muted">
            层位证据链：{{ d.unitPath.map(unitLabel).join(' → ') }}
            <br />
            阶段证据链：{{ d.phasePath.map(phaseLabel).join(' → ') }}
            <br />
            涉及关系记录：{{ d.relationIds.join('、') || '—' }}（原始记录保留，未被修改）
          </small>
        </span>
      </li>
      <li v-if="state.diagnostics.length === 0" class="muted">层位关系与阶段顺序一致，无矛盾</li>
    </ul>
  </section>
</template>

<style scoped>
.hint {
  margin: 4px 0 8px;
  font-size: 12px;
  color: #888;
}
.diag {
  background: #fdf3f2;
  border-color: #f0d4d0 !important;
}
.tag.valid {
  border-color: #2e7d32;
  color: #2e7d32;
}
.tag.assigned {
  border-color: #1565c0;
  color: #1565c0;
}
</style>
