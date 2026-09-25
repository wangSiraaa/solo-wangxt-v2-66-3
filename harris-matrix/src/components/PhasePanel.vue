<script setup lang="ts">
import { computed, reactive } from 'vue'
import {
  addPhase,
  addPhaseConstraint,
  approveCurrentPhases,
  assignUnitPhase,
  currentPhaseComputation,
  deletePhase,
  phaseLabel,
  removePhaseConstraint,
  state,
} from '../store'
import type { PhaseDiagnostic } from '../types'

const phaseForm = reactive({ label: '', note: '', earlierThanId: '', laterThanId: '' })
const constraintForm = reactive({ before: '', after: '' })

const current = computed(() => currentPhaseComputation.value)

/** 阶段拓扑序（当前计算版本的快照；无版本时按创建顺序） */
const orderedPhaseIds = computed(() => current.value?.phaseOrder ?? state.phases.map((p) => p.id))

const diagKindNames: Record<PhaseDiagnostic['kind'], string> = {
  'phase-cycle': '阶段成环',
  'order-conflict': '关系↔阶段矛盾',
  'contemporary-conflict': '同期冲突',
  'empty-interval': '区间为空',
}

function intervalText(unitId: string): string {
  const iv = state.phaseIntervals[unitId]
  if (!iv) return '—'
  if (iv.conflict) return '矛盾：无可行阶段'
  if (iv.feasiblePhaseIds.length === 1) return `唯一定位：${phaseLabel(iv.earliestPhaseId!)}`
  return `${phaseLabel(iv.earliestPhaseId!)} ~ ${phaseLabel(iv.latestPhaseId!)}（${iv.feasiblePhaseIds.length} 个可行阶段）`
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

async function submitPhase() {
  await addPhase(phaseForm.label, phaseForm.note, phaseForm.earlierThanId || undefined, phaseForm.laterThanId || undefined)
  phaseForm.label = ''
  phaseForm.note = ''
  phaseForm.earlierThanId = ''
  phaseForm.laterThanId = ''
}

async function submitConstraint() {
  await addPhaseConstraint(constraintForm.before, constraintForm.after)
  constraintForm.before = ''
  constraintForm.after = ''
}

function onAssign(unitId: string, e: Event) {
  const value = (e.target as HTMLSelectElement).value
  void assignUnitPhase(unitId, value || null)
}
</script>

<template>
  <section class="panel">
    <h3>阶段与相对年代区间</h3>

    <template v-if="state.phases.length === 0">
      <p class="hint">
        尚无阶段。创建阶段并设置可选的前后约束、把层位分配到阶段后，系统将结合层位偏序推演每个层位可能处于的最早/最晚阶段区间；不能唯一定位时保留区间。
      </p>
    </template>

    <template v-else>
      <div class="order-line">
        <span class="muted small">阶段顺序：</span>
        <b>{{ orderedPhaseIds.map(phaseLabel).join(' → ') }}</b>
      </div>
      <div class="order-line">
        <span v-if="current?.valid" class="tag ok">无矛盾</span>
        <span v-else class="tag conflict">存在矛盾，不可标记为有效</span>
        <span v-if="current?.approved" class="tag approved">已标记有效 {{ fmtTime(current.approvedAt!) }}</span>
        <button
          v-if="current && !current.approved"
          class="sm"
          :disabled="!current.valid"
          :title="current.valid ? '确认该组阶段方案' : '存在未解决诊断，系统阻止标记'"
          @click="approveCurrentPhases"
        >
          标记为有效
        </button>
      </div>
    </template>

    <form class="form" @submit.prevent="submitPhase">
      <div class="row">
        <input v-model="phaseForm.label" placeholder="阶段名，如 一期" required />
        <input v-model="phaseForm.note" placeholder="备注（可选）" />
      </div>
      <div class="row">
        <select v-model="phaseForm.laterThanId">
          <option value="">晚于…（可选）</option>
          <option v-for="p in state.phases" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
        <select v-model="phaseForm.earlierThanId">
          <option value="">早于…（可选）</option>
          <option v-for="p in state.phases" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
      </div>
      <button type="submit">新增阶段</button>
    </form>

    <ul v-if="state.phases.length" class="list">
      <li v-for="(pid, i) in orderedPhaseIds" :key="pid">
        <span class="badge phase">{{ i + 1 }}</span>
        <span class="grow">
          <b>{{ phaseLabel(pid) }}</b>
          <small v-if="state.phases.find((p) => p.id === pid)?.note">　{{ state.phases.find((p) => p.id === pid)?.note }}</small>
        </span>
        <button class="danger sm" title="删除阶段（连带约束与分配）" @click="deletePhase(pid)">删</button>
      </li>
    </ul>

    <template v-if="state.phases.length >= 2">
      <h4>前后约束（{{ state.phaseConstraints.length }}）</h4>
      <form class="form" @submit.prevent="submitConstraint">
        <div class="row">
          <select v-model="constraintForm.before" required>
            <option value="" disabled>较早阶段</option>
            <option v-for="p in state.phases" :key="p.id" :value="p.id">{{ p.label }}</option>
          </select>
          <select v-model="constraintForm.after" required>
            <option value="" disabled>较晚阶段</option>
            <option v-for="p in state.phases" :key="p.id" :value="p.id">{{ p.label }}</option>
          </select>
        </div>
        <button type="submit">新增约束</button>
      </form>
      <ul class="list">
        <li v-for="c in state.phaseConstraints" :key="c.id">
          <span class="grow">{{ phaseLabel(c.before) }} 早于 {{ phaseLabel(c.after) }}</span>
          <button class="danger sm" title="删除约束（区间将随之放宽重算）" @click="removePhaseConstraint(c.id)">删</button>
        </li>
        <li v-if="state.phaseConstraints.length === 0" class="muted">暂无约束：阶段间互不排序，区间保持最宽</li>
      </ul>
    </template>
  </section>

  <section v-if="state.phases.length" class="panel">
    <h3>层位分配与推演区间</h3>
    <ul class="list">
      <li v-for="u in state.units" :key="u.id" :class="{ conflicted: state.phaseIntervals[u.id]?.conflict }">
        <span class="grow">
          <b>{{ u.label }}</b>
          <br />
          <small :class="state.phaseIntervals[u.id]?.conflict ? 'conflict-text' : 'muted'">{{ intervalText(u.id) }}</small>
        </span>
        <select class="assign" :value="state.phaseAssignments[u.id]?.phaseId ?? ''" @change="onAssign(u.id, $event)">
          <option value="">未分配</option>
          <option v-for="p in state.phases" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
      </li>
      <li v-if="state.units.length === 0" class="muted">暂无层位</li>
    </ul>
    <p v-if="current" class="hint">
      版本 {{ fmtTime(current.at) }}　触发：{{ current.trigger }}　本次重算 {{ current.affectedUnitIds.length }} 个层位
    </p>
  </section>

  <section v-if="state.phaseDiagnostics.length" class="panel">
    <h3>矛盾诊断（{{ state.phaseDiagnostics.length }}）</h3>
    <ul class="list">
      <li v-for="d in state.phaseDiagnostics" :key="d.id" class="diag">
        <span class="grow">
          <span class="tag conflict">{{ diagKindNames[d.kind] }}</span>
          <br />
          {{ d.message }}
          <br />
          <small class="muted">证据路径：</small>
          <ol class="path">
            <li v-for="(s, i) in d.path" :key="i">{{ s.text }}</li>
          </ol>
        </span>
      </li>
    </ul>
    <p class="hint">原始关系与分配全部保留；解决矛盾或调整阶段约束后，诊断将自动更新。</p>
  </section>
</template>

<style scoped>
h4 {
  margin: 10px 0 6px;
  font-size: 12px;
  color: #6d5c47;
}
.order-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.badge.phase {
  background: #6d5c47;
}
.tag.ok {
  border-color: #2e7d32;
  color: #2e7d32;
}
.tag.approved {
  border-color: #1565c0;
  color: #1565c0;
}
select.assign {
  width: 88px;
  flex-shrink: 0;
  font-size: 12px;
}
li.conflicted {
  border-color: #e0a8a8;
  background: #fdf6f6;
}
.conflict-text {
  color: #c62828;
}
.diag {
  align-items: flex-start;
  background: #fdf6f6;
  border-color: #e8c8c8;
}
.path {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: #555;
}
.path li {
  border: none;
  background: none;
  padding: 1px 0;
  display: list-item;
}
.hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: #888;
}
</style>
