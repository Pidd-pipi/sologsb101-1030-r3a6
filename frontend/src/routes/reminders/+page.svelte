<script lang="ts">
  /** /reminders 调律周期提醒与结构版本导出：超期琴置顶，本地库版本查看与 JSON 导入导出 */
  import { onMount } from 'svelte';
  import { push, router } from '$lib/router';
  import FilterBar from '$lib/components/common/FilterBar.svelte';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import { useIdbTable } from '$lib/hooks/useIdbTable';
  import {
    countAll,
    DB_NAME,
    DB_SCHEMA_VERSION,
    db,
    exportSnapshot,
    resetDatabase,
    type PianoRow,
    type ReminderRow,
    type TuningRow
  } from '$lib/utils/db';
  import { mergeSnapshot, parseSnapshot, type MergeCounts, type MergeReport } from '$lib/utils/merge';
  import { createEmptyReminder, daysToDue, type Reminder } from '$lib/types/reminder';
  import {
    computeNextDue,
    computeState,
    createReminder,
    deleteReminder,
    editReminder,
    REMINDER_FILTER_KEYS,
    reminderFilters,
    resetReminderFilters,
    setReminderFilters,
    sortByUrgency
  } from '$lib/stores/reminderStore';
  import { buildPianoArchive, downloadJson, serializeArchive } from '$lib/utils/export';
  import type { FilterModel } from '$lib/types/filter';
  import { queryToFilters, toQueryString } from '$lib/utils/query';

  const pianos = useIdbTable<PianoRow>(db.pianos, (a, b) => a.brand.localeCompare(b.brand, 'zh-Hans-CN'));
  const reminders = useIdbTable<ReminderRow>(db.reminders, (a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
  const tunings = useIdbTable<TuningRow>(db.tunings, (a, b) => b.date.localeCompare(a.date));

  let dialogOpen = $state(false);
  let editingId = $state<string | null>(null);
  let form = $state<Omit<Reminder, 'id'>>(createEmptyReminder());
  let formError = $state<string | null>(null);
  let counts = $state<Record<string, number>>({});
  let archivePianoId = $state('');
  let archivePreview = $state('');
  let importOpen = $state(false);
  let importText = $state('');
  let importError = $state<string | null>(null);
  let mergeReport = $state<MergeReport | null>(null);

  function asArray(value: string | string[] | boolean | undefined): string[] {
    return Array.isArray(value) ? value : [];
  }

  function pianoOf(pianoId: string): PianoRow | null {
    return $pianos.find((item) => item.id === pianoId) ?? null;
  }

  function pianoLabel(pianoId: string): string {
    const piano = pianoOf(pianoId);
    return piano ? `${piano.brand} ${piano.model}` : '钢琴已删除';
  }

  /** 最近一次调律日期（用于校准周期） */
  function lastTuningOf(pianoId: string): string {
    return $tunings.find((item) => item.pianoId === pianoId)?.date ?? '';
  }

  const filtered = $derived.by(() =>
    sortByUrgency(
      $reminders.filter((reminder) => {
        const keyword = String($reminderFilters.keyword ?? '').trim().toLowerCase();
        const states = asArray($reminderFilters.states);
        const venues = asArray($reminderFilters.venues);
        const piano = pianoOf(reminder.pianoId);
        const label = `${pianoLabel(reminder.pianoId)} ${reminder.state}`.toLowerCase();
        if (keyword && !label.includes(keyword)) return false;
        if (states.length > 0 && !states.includes(reminder.state)) return false;
        if (venues.length > 0 && (!piano || !venues.includes(piano.venue))) return false;
        return true;
      })
    )
  );

  const totals = $derived.by(() => {
    const overdue = $reminders.filter((item) => item.state === '超期').length;
    const soon = $reminders.filter((item) => item.state === '临近').length;
    return {
      total: $reminders.length,
      overdue,
      soon,
      normal: $reminders.filter((item) => item.state === '正常').length,
      coverage: $pianos.length > 0 ? Math.round(($reminders.length / $pianos.length) * 100) : 0
    };
  });

  async function refreshCounts(): Promise<void> {
    counts = await countAll();
  }

  function openCreate(): void {
    editingId = null;
    form = createEmptyReminder();
    form.pianoId = $pianos[0]?.id ?? '';
    const last = lastTuningOf(form.pianoId);
    if (last) {
      form.lastTuningDate = last;
      form.nextDueDate = computeNextDue(last, form.cycleMonths);
      form.state = computeState(form.nextDueDate);
    }
    formError = null;
    dialogOpen = true;
  }

  function openEdit(reminder: ReminderRow): void {
    editingId = reminder.id;
    form = {
      pianoId: reminder.pianoId,
      cycleMonths: reminder.cycleMonths,
      lastTuningDate: reminder.lastTuningDate,
      nextDueDate: reminder.nextDueDate,
      state: reminder.state
    };
    formError = null;
    dialogOpen = true;
  }

  /** 周期或上次调律日期变化时自动推算下次建议日期 */
  function recalc(): void {
    const last = form.lastTuningDate || lastTuningOf(form.pianoId);
    if (!last) return;
    form.lastTuningDate = last;
    form.nextDueDate = computeNextDue(last, form.cycleMonths);
    form.state = computeState(form.nextDueDate);
  }

  /** 选择钢琴后带出最近调律日期 */
  function onPianoChange(): void {
    const last = lastTuningOf(form.pianoId);
    if (last) {
      form.lastTuningDate = last;
      recalc();
    }
  }

  async function submit(): Promise<void> {
    if (!form.pianoId) {
      formError = '请选择钢琴';
      return;
    }
    if (form.cycleMonths < 1 || form.cycleMonths > 36) {
      formError = '建议周期应在 1–36 个月之间';
      return;
    }
    recalc();
    if (editingId) {
      await editReminder(editingId, { ...form });
    } else {
      await createReminder({ ...form });
    }
    await refreshCounts();
    dialogOpen = false;
  }

  async function remove(reminder: ReminderRow): Promise<void> {
    if (!window.confirm(`删除「${pianoLabel(reminder.pianoId)}」的周期提醒？`)) return;
    await deleteReminder(reminder.id);
    await refreshCounts();
  }

  async function previewArchive(): Promise<void> {
    if (!archivePianoId) {
      archivePreview = '';
      return;
    }
    const archive = await buildPianoArchive(archivePianoId);
    archivePreview = serializeArchive(archive);
  }

  async function exportArchive(): Promise<void> {
    if (!archivePianoId) return;
    const archive = await buildPianoArchive(archivePianoId);
    downloadJson(`钢琴档案-${archivePianoId}.json`, serializeArchive(archive));
  }

  async function exportLibrary(): Promise<void> {
    const snapshot = await exportSnapshot();
    downloadJson(`gbpianotune-备份-${snapshot.exportedAt.slice(0, 10)}.json`, JSON.stringify(snapshot, null, 2));
  }

  /** 合档：按编号逐条对齐合并备份，任一环节失败整体撤回 */
  async function doMerge(): Promise<void> {
    importError = null;
    try {
      const snapshot = parseSnapshot(importText);
      mergeReport = await mergeSnapshot(snapshot);
      await refreshCounts();
    } catch (error) {
      mergeReport = null;
      importError = error instanceof Error ? error.message : '合档失败，已撤回全部改动';
    }
  }

  function closeImport(): void {
    importOpen = false;
    importText = '';
    importError = null;
    mergeReport = null;
  }

  /** 合档报告的分类行 */
  function reportRows(report: MergeReport): Array<[string, MergeCounts]> {
    return [
      ['钢琴', report.pianos],
      ['调律', report.tunings],
      ['维修', report.voicings],
      ['环境', report.environments],
      ['提醒', report.reminders]
    ];
  }

  /** 挂起记录的分组编号清单 */
  function suspendedSummary(report: MergeReport): string {
    const labels: Record<keyof MergeReport['suspendedIds'], string> = {
      tunings: '调律',
      voicings: '维修',
      environments: '环境',
      reminders: '提醒'
    };
    return (Object.entries(report.suspendedIds) as Array<[keyof MergeReport['suspendedIds'], string[]]>)
      .filter(([, ids]) => ids.length > 0)
      .map(([key, ids]) => `${labels[key]}：${ids.join('、')}`)
      .join('；');
  }

  async function resetDemo(): Promise<void> {
    if (!window.confirm('将清空本地库并重新灌入演示数据，是否继续？')) return;
    await resetDatabase();
    await refreshCounts();
  }

  function applyFilters(next: FilterModel): void {
    setReminderFilters(next);
    void push(`/reminders${toQueryString(next)}`);
  }

  onMount(() => {
    const query: Record<string, string> = {};
    new URLSearchParams(router.querystring ?? '').forEach((value, key) => {
      query[key] = value;
    });
    setReminderFilters(queryToFilters(query, REMINDER_FILTER_KEYS));
    archivePianoId = $pianos[0]?.id ?? '';
    void refreshCounts();
  });
</script>

<div class="page">
  <div class="page-head">
    <div>
      <h2 class="page-title">调律周期提醒与结构版本导出</h2>
      <p class="page-subtitle">
        本地库 {DB_NAME}（结构版本 v{DB_SCHEMA_VERSION}）· 超期琴自动置顶，可按场所批量筛选。
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <button type="button" class="btn" onclick={exportLibrary}>导出整库备份</button>
      <button
        type="button"
        class="btn"
        onclick={() => {
          importOpen = true;
          importError = null;
          mergeReport = null;
        }}>合并备份</button
      >
      <button type="button" class="btn-primary" onclick={openCreate} disabled={$pianos.length === 0}>+ 新建周期提醒</button>
    </div>
  </div>

  <div class="badge-row">
    <StatBadge label="提醒条目" value={totals.total} suffix="条" tone="walnut" icon="⏰" />
    <StatBadge label="超期" value={totals.overdue} suffix="台" tone="rose" icon="‼" />
    <StatBadge label="临近" value={totals.soon} suffix="台" tone="amber" icon="!" />
    <StatBadge label="正常" value={totals.normal} suffix="台" tone="green" icon="✓" />
    <StatBadge label="琴档覆盖率" value={totals.coverage} percent={totals.coverage} showPercent tone="brass" icon="%" />
  </div>

  <FilterBar
    filters={$reminderFilters}
    selects={[
      {
        key: 'states',
        label: '周期状态',
        options: [
          { label: '正常', value: '正常' },
          { label: '临近', value: '临近' },
          { label: '超期', value: '超期' }
        ]
      },
      {
        key: 'venues',
        label: '场所',
        options: ['家庭', '琴房', '音乐厅', '学校'].map((item) => ({ label: item, value: item }))
      }
    ]}
    keywordPlaceholder="搜索钢琴 / 状态…"
    onchange={applyFilters}
    onreset={() => {
      resetReminderFilters();
      void push('/reminders');
    }}
  />

  {#if filtered.length === 0}
    <EmptyPanel
      title="暂无周期提醒"
      description="为钢琴建立调律周期，系统会按上次调律日期推算下次建议日期。"
      showCreate={$pianos.length > 0}
      createText="新建周期提醒"
      oncreate={openCreate}
    />
  {:else}
    <div class="card overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="border-b border-stone-200 text-left text-xs text-stone-500">
          <tr>
            <th class="py-2">钢琴</th>
            <th class="py-2">场所</th>
            <th class="py-2">周期</th>
            <th class="py-2">上次调律</th>
            <th class="py-2">下次建议</th>
            <th class="py-2">剩余天数</th>
            <th class="py-2">状态</th>
            <th class="py-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as reminder (reminder.id)}
            {@const days = daysToDue(reminder.nextDueDate)}
            <tr class="border-b border-stone-100 {reminder.state === '超期' ? 'bg-rose-50/70' : ''}">
              <td class="py-2">{pianoLabel(reminder.pianoId)}</td>
              <td class="py-2">{pianoOf(reminder.pianoId)?.venue ?? '—'}</td>
              <td class="py-2">{reminder.cycleMonths} 个月</td>
              <td class="py-2">{reminder.lastTuningDate || '—'}</td>
              <td class="py-2">{reminder.nextDueDate || '—'}</td>
              <td class="py-2 tabular-nums {days < 0 ? 'font-semibold text-rose-700' : ''}">{days} 天</td>
              <td class="py-2">
                <span
                  class="rounded-full px-2 py-0.5 text-xs {reminder.state === '超期'
                    ? 'bg-rose-100 text-rose-700'
                    : reminder.state === '临近'
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-emerald-100 text-emerald-700'}">{reminder.state}</span
                >
              </td>
              <td class="py-2">
                <button type="button" class="btn mr-2" onclick={() => openEdit(reminder)}>编辑</button>
                <button type="button" class="btn-danger" onclick={() => remove(reminder)}>删除</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <div class="grid gap-4 lg:grid-cols-2">
    <div class="card">
      <div class="card-title mb-3">
        <span>钢琴档案导出</span>
        <span class="muted">单琴 JSON 归档</span>
      </div>
      <select class="field mb-3" bind:value={archivePianoId} onchange={previewArchive}>
        <option value="">请选择钢琴</option>
        {#each $pianos as piano (piano.id)}
          <option value={piano.id}>{piano.brand} {piano.model}</option>
        {/each}
      </select>
      <div class="mb-3 flex gap-2">
        <button type="button" class="btn" onclick={previewArchive}>生成预览</button>
        <button type="button" class="btn-primary" onclick={exportArchive}>下载档案</button>
      </div>
      <textarea class="field h-48 font-mono text-xs" readonly placeholder="档案预览会显示在这里" value={archivePreview}></textarea>
    </div>

    <div class="card">
      <div class="card-title mb-3">
        <span>本地结构版本</span>
        <span class="muted">IndexedDB · {DB_NAME}</span>
      </div>
      <div class="grid grid-cols-2 gap-2 text-xs text-stone-600">
        <div class="rounded-lg bg-stone-50 px-3 py-2">库名：{DB_NAME}</div>
        <div class="rounded-lg bg-stone-50 px-3 py-2">结构版本：v{DB_SCHEMA_VERSION}</div>
        <div class="rounded-lg bg-stone-50 px-3 py-2">钢琴 / 调律：{counts.pianos ?? 0} / {counts.tunings ?? 0}</div>
        <div class="rounded-lg bg-stone-50 px-3 py-2">维修 / 环境：{counts.voicings ?? 0} / {counts.environments ?? 0}</div>
        <div class="rounded-lg bg-stone-50 px-3 py-2">提醒：{counts.reminders ?? 0}</div>
        <div class="rounded-lg bg-stone-50 px-3 py-2">超期琴：{totals.overdue} 台</div>
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" class="btn" onclick={() => void refreshCounts()}>刷新统计</button>
        <button type="button" class="btn-danger" onclick={resetDemo}>重置演示数据</button>
      </div>
    </div>
  </div>
</div>

{#if dialogOpen}
  <div class="modal-mask">
    <button
      type="button"
      class="absolute inset-0 cursor-default"
      aria-label="关闭弹窗"
      onclick={() => (dialogOpen = false)}
    ></button>
    <div class="modal-panel relative" role="dialog" aria-modal="true">
      <h3 class="mb-4 text-base font-semibold">{editingId ? '编辑周期提醒' : '新建周期提醒'}</h3>
      {#if formError}
        <div class="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{formError}</div>
      {/if}
      <div class="grid gap-3 md:grid-cols-2">
        <div class="md:col-span-2">
          <span class="label">钢琴</span>
          <select class="field" bind:value={form.pianoId} onchange={onPianoChange}>
            {#each $pianos as piano (piano.id)}
              <option value={piano.id}>{piano.brand} {piano.model}</option>
            {/each}
          </select>
        </div>
        <div>
          <span class="label">建议周期（月）</span>
          <input class="field" type="number" min="1" max="36" bind:value={form.cycleMonths} oninput={recalc} />
        </div>
        <div>
          <span class="label">上次调律日期</span>
          <input class="field" type="date" bind:value={form.lastTuningDate} onchange={recalc} />
        </div>
        <div>
          <span class="label">下次建议日期（自动推算）</span>
          <input class="field bg-stone-50" readonly value={form.nextDueDate} />
        </div>
        <div>
          <span class="label">周期状态（自动判定）</span>
          <input class="field bg-stone-50" readonly value={form.state} />
        </div>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn" onclick={() => (dialogOpen = false)}>取消</button>
        <button type="button" class="btn-primary" onclick={submit}>保存</button>
      </div>
    </div>
  </div>
{/if}

{#if importOpen}
  <div class="modal-mask">
    <button
      type="button"
      class="absolute inset-0 cursor-default"
      aria-label="关闭弹窗"
      onclick={closeImport}
    ></button>
    <div class="modal-panel relative" role="dialog" aria-modal="true">
      <h3 class="mb-3 text-base font-semibold">合并备份到本地库</h3>
      {#if importError}
        <div class="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{importError}</div>
      {/if}
      {#if mergeReport}
        <div class="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          合档完成：全部改动已写入本地库，调律偏差与复调标记、周期提醒剩余天数、环境超标天数已一并刷新。
        </div>
        <table class="w-full text-sm">
          <thead class="border-b border-stone-200 text-left text-xs text-stone-500">
            <tr>
              <th class="py-1">档案</th>
              <th class="py-1">新增</th>
              <th class="py-1">覆盖</th>
              <th class="py-1">挂起</th>
              <th class="py-1">未变</th>
            </tr>
          </thead>
          <tbody>
            {#each reportRows(mergeReport) as [label, counts]}
              <tr class="border-b border-stone-100">
                <td class="py-1">{label}</td>
                <td class="py-1 tabular-nums text-emerald-700">{counts.added}</td>
                <td class="py-1 tabular-nums text-amber-700">{counts.overwritten}</td>
                <td class="py-1 tabular-nums {counts.suspended > 0 ? 'font-semibold text-rose-700' : ''}">{counts.suspended}</td>
                <td class="py-1 tabular-nums text-stone-500">{counts.unchanged}</td>
              </tr>
            {/each}
            <tr class="font-semibold">
              <td class="py-1">合计</td>
              <td class="py-1 tabular-nums text-emerald-700">{mergeReport.total.added}</td>
              <td class="py-1 tabular-nums text-amber-700">{mergeReport.total.overwritten}</td>
              <td class="py-1 tabular-nums {mergeReport.total.suspended > 0 ? 'text-rose-700' : ''}">{mergeReport.total.suspended}</td>
              <td class="py-1 tabular-nums text-stone-500">{mergeReport.total.unchanged}</td>
            </tr>
          </tbody>
        </table>
        <p class="mt-2 text-xs text-stone-500">
          派生字段重算：调律 {mergeReport.recalculated.tunings} 条 · 提醒 {mergeReport.recalculated.reminders} 条 · 环境 {mergeReport.recalculated.environments} 条
        </p>
        {#if mergeReport.total.suspended > 0}
          <div class="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
            以下子记录找不到对应钢琴档案，已挂起未写库：{suspendedSummary(mergeReport)}
          </div>
        {/if}
        <div class="mt-4 flex justify-end">
          <button type="button" class="btn-primary" onclick={closeImport}>完成</button>
        </div>
      {:else}
        <p class="mb-3 text-xs text-stone-500">
          按编号逐条对齐五类档案：同一条取时间戳较新的版本，主库缺少的照搬过来，找不到钢琴档案的子记录会挂起不写库；合档要么全部完成、要么撤回。旧备份缺少时间戳的行按较旧处理，不会覆盖主库新录的内容。
        </p>
        <textarea class="field h-48 font-mono text-xs" bind:value={importText} placeholder="粘贴导出的 JSON 备份内容"></textarea>
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" class="btn" onclick={closeImport}>取消</button>
          <button type="button" class="btn-primary" onclick={doMerge}>确认合档</button>
        </div>
      {/if}
    </div>
  </div>
{/if}
