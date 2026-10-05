/**
 * 整库备份合档（merge）
 * 场景：琴行主库与上门笔记本分头记录，笔记本离线带回的备份需要并入主库，而不是整片覆盖。
 * 规则：
 * - 五类档案（钢琴 / 调律 / 维修 / 环境 / 提醒）按编号（id）逐条对齐；
 * - 同一条记录取 updatedAt 较晚的版本；旧备份缺少时间戳的行按 0 处理（只能新增，不会覆盖主库）；
 * - 主库缺少的记录照搬过来；
 * - 子记录（调律 / 维修 / 环境 / 提醒）找不到对应钢琴档案时挂起，不写库；
 * - 整个合档在一个 Dexie 事务内完成：要么全部写入，要么全部撤回；
 * - 合档后重算派生字段：调律的平均/最大偏差与复调标记（按各记录的基准音高与音区音分）、
 *   提醒的周期状态（剩余天数随之刷新）、环境记录的超标标记（超标天数随之刷新）。
 */
import { isAbnormal } from '$lib/types/environment';
import { deriveReminderState } from '$lib/types/reminder';
import { needsRepitch } from './cents';
import {
  DB_NAME,
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  db,
  type DatabaseSnapshot,
  type EnvironmentRow,
  type ReminderRow,
  type Revisioned,
  type SnapshotRow,
  type TuningRow
} from './db';

/** 单类档案的合档统计 */
export interface MergeCounts {
  /** 主库缺少、照搬过来的条数 */
  added: number;
  /** 备份版本更新、覆盖主库的条数 */
  overwritten: number;
  /** 找不到对应钢琴档案、挂起未写库的条数 */
  suspended: number;
  /** 主库已是最新、未改动的条数 */
  unchanged: number;
}

/** 合档结果报告 */
export interface MergeReport {
  pianos: MergeCounts;
  tunings: MergeCounts;
  voicings: MergeCounts;
  environments: MergeCounts;
  reminders: MergeCounts;
  /** 五类合计 */
  total: MergeCounts;
  /** 挂起记录的编号（按表分组，便于追查） */
  suspendedIds: Record<'tunings' | 'voicings' | 'environments' | 'reminders', string[]>;
  /** 合档后重算派生字段时被修正的行数 */
  recalculated: { tunings: number; reminders: number; environments: number };
}

const TABLE_LABELS: Array<[keyof Omit<DatabaseSnapshot, 'name' | 'schemaVersion' | 'exportedAt'>, string]> = [
  ['pianos', '钢琴'],
  ['tunings', '调律'],
  ['voicings', '维修'],
  ['environments', '环境'],
  ['reminders', '提醒']
];

/** 校验并解析整库备份 JSON；行可以缺少时间戳（旧备份），但必须带编号，失败时抛出可读错误 */
export function parseSnapshot(text: string): DatabaseSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文本');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('备份根节点必须是对象');
  }
  const candidate = parsed as Partial<DatabaseSnapshot>;
  if (!Array.isArray(candidate.pianos)) {
    throw new Error('缺少 pianos 数组字段，不是本应用的整库备份文件');
  }
  for (const [key, label] of TABLE_LABELS) {
    const rows = candidate[key] ?? [];
    if (!Array.isArray(rows)) throw new Error(`${key} 必须是数组`);
    rows.forEach((row, index) => {
      if (typeof row !== 'object' || row === null || typeof (row as { id?: unknown }).id !== 'string') {
        throw new Error(`${label}档案第 ${index + 1} 条缺少编号（id），无法按编号对齐`);
      }
    });
  }
  return {
    name: typeof candidate.name === 'string' ? candidate.name : DB_NAME,
    schemaVersion: typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : DB_SCHEMA_VERSION,
    exportedAt: typeof candidate.exportedAt === 'string' ? candidate.exportedAt : '',
    pianos: candidate.pianos,
    tunings: candidate.tunings ?? [],
    voicings: candidate.voicings ?? [],
    environments: candidate.environments ?? [],
    reminders: candidate.reminders ?? []
  };
}

function emptyCounts(): MergeCounts {
  return { added: 0, overwritten: 0, suspended: 0, unchanged: 0 };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 行的比较时间戳：旧备份缺时间戳按 0 处理（视为最旧） */
function rowTs(row: { updatedAt?: number }): number {
  return finiteNumber(row.updatedAt) ?? 0;
}

/** 备份内同编号去重：保留时间戳较新的一条（并列取靠后出现的） */
function dedupeById<T extends { id: string }>(rows: Array<SnapshotRow<T>>): Array<SnapshotRow<T>> {
  const map = new Map<string, SnapshotRow<T>>();
  for (const row of rows) {
    const prev = map.get(row.id);
    if (!prev || rowTs(row) >= rowTs(prev)) map.set(row.id, row);
  }
  return [...map.values()];
}

/** 补齐行修订号与时间戳；旧备份缺时间戳时用回退值（新增为当前时间，覆盖为原行创建时间） */
function toRow<T extends { id: string }>(incoming: SnapshotRow<T>, fallbackCreatedAt: number): T & Revisioned {
  const createdAt = finiteNumber(incoming.createdAt) ?? fallbackCreatedAt;
  const updatedAt = finiteNumber(incoming.updatedAt) ?? createdAt;
  const revision = finiteNumber(incoming.revision) ?? ROW_REVISION;
  return { ...incoming, revision, createdAt, updatedAt };
}

/**
 * 对齐一张表：主库缺的照搬、同编号取时间戳较新版本、父档案缺失的挂起。
 * 返回需要写入的行；统计累进 counts / suspendedIds。
 */
function mergeRows<T extends { id: string }>(
  existingRows: Array<T & Revisioned>,
  incomingRows: Array<SnapshotRow<T>>,
  hasParent: ((row: SnapshotRow<T>) => boolean) | null,
  counts: MergeCounts,
  suspendedIds: string[] | null,
  now: number
): Array<T & Revisioned> {
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const writes: Array<T & Revisioned> = [];
  for (const incoming of dedupeById(incomingRows)) {
    if (hasParent && !hasParent(incoming)) {
      counts.suspended += 1;
      suspendedIds?.push(incoming.id);
      continue;
    }
    const existing = existingById.get(incoming.id);
    if (!existing) {
      counts.added += 1;
      writes.push(toRow(incoming, now));
    } else if (rowTs(incoming) > rowTs(existing)) {
      counts.overwritten += 1;
      writes.push(toRow(incoming, finiteNumber(existing.createdAt) ?? now));
    } else {
      counts.unchanged += 1;
    }
  }
  return writes;
}

/** 按每条调律记录的基准音高与各音区音分，重算平均/最大偏差与复调标记（保留原时间戳，不影响再次合档的新旧比较） */
async function recalcTunings(): Promise<number> {
  const rows = await db.tunings.toArray();
  const fixes: TuningRow[] = [];
  for (const row of rows) {
    const values = [row.zones?.bass, row.zones?.mid, row.zones?.treble];
    if (values.some((value) => finiteNumber(value) === null)) continue;
    const cents = values as number[];
    const avg = Number((cents.reduce((sum, value) => sum + value, 0) / cents.length).toFixed(1));
    const max = Number(cents.reduce((worst, value) => (Math.abs(value) > Math.abs(worst) ? value : worst), cents[0]).toFixed(1));
    const pitchRaised = needsRepitch(avg, max);
    if (row.avgDeviationCents !== avg || row.maxDeviationCents !== max || row.pitchRaised !== pitchRaised) {
      fixes.push({ ...row, avgDeviationCents: avg, maxDeviationCents: max, pitchRaised });
    }
  }
  if (fixes.length > 0) await db.tunings.bulkPut(fixes);
  return fixes.length;
}

/** 按下次建议日期重算周期状态（剩余天数随状态一并刷新，保留原时间戳） */
async function recalcReminders(): Promise<number> {
  const rows = await db.reminders.toArray();
  const fixes: ReminderRow[] = [];
  for (const row of rows) {
    const state = deriveReminderState(row.nextDueDate);
    if (row.state !== state) fixes.push({ ...row, state });
  }
  if (fixes.length > 0) await db.reminders.bulkPut(fixes);
  return fixes.length;
}

/** 按建议温湿度区间重算超标标记（超标天数随之刷新，保留原时间戳） */
async function recalcEnvironments(): Promise<number> {
  const rows = await db.environments.toArray();
  const fixes: EnvironmentRow[] = [];
  for (const row of rows) {
    const abnormal = isAbnormal(row.tempC, row.humidityPct);
    if (row.abnormal !== abnormal) fixes.push({ ...row, abnormal });
  }
  if (fixes.length > 0) await db.environments.bulkPut(fixes);
  return fixes.length;
}

/**
 * 把整库备份合并进本地库：单事务执行，任一环节失败全部撤回。
 * 返回新增 / 覆盖 / 挂起（及未变）条数与派生字段重算结果。
 */
export async function mergeSnapshot(snapshot: DatabaseSnapshot): Promise<MergeReport> {
  return db.transaction('rw', [db.pianos, db.tunings, db.voicings, db.environments, db.reminders], async () => {
    const now = Date.now();
    const report: MergeReport = {
      pianos: emptyCounts(),
      tunings: emptyCounts(),
      voicings: emptyCounts(),
      environments: emptyCounts(),
      reminders: emptyCounts(),
      total: emptyCounts(),
      suspendedIds: { tunings: [], voicings: [], environments: [], reminders: [] },
      recalculated: { tunings: 0, reminders: 0, environments: 0 }
    };

    const [existingPianos, existingTunings, existingVoicings, existingEnvironments, existingReminders] = await Promise.all([
      db.pianos.toArray(),
      db.tunings.toArray(),
      db.voicings.toArray(),
      db.environments.toArray(),
      db.reminders.toArray()
    ]);

    // 1. 钢琴档案：父表，逐条对齐（不存在挂起）
    await db.pianos.bulkPut(mergeRows(existingPianos, snapshot.pianos, null, report.pianos, null, now));

    // 合并后的钢琴编号集合 = 主库现有 + 备份带来的全部钢琴（备份钢琴只会新增或已存在）
    const pianoIds = new Set(existingPianos.map((row) => row.id));
    for (const row of snapshot.pianos) pianoIds.add(row.id);
    const hasPiano = (row: { pianoId?: string }): boolean => typeof row.pianoId === 'string' && pianoIds.has(row.pianoId);

    // 2. 四张子表：找不到对应钢琴档案的挂起不写库
    await db.tunings.bulkPut(mergeRows(existingTunings, snapshot.tunings, hasPiano, report.tunings, report.suspendedIds.tunings, now));
    await db.voicings.bulkPut(mergeRows(existingVoicings, snapshot.voicings, hasPiano, report.voicings, report.suspendedIds.voicings, now));
    await db.environments.bulkPut(
      mergeRows(existingEnvironments, snapshot.environments, hasPiano, report.environments, report.suspendedIds.environments, now)
    );
    await db.reminders.bulkPut(mergeRows(existingReminders, snapshot.reminders, hasPiano, report.reminders, report.suspendedIds.reminders, now));

    // 3. 重算派生字段：调律偏差与复调标记、周期状态（剩余天数）、环境超标标记（超标天数）
    report.recalculated.tunings = await recalcTunings();
    report.recalculated.reminders = await recalcReminders();
    report.recalculated.environments = await recalcEnvironments();

    // 4. 合计
    for (const counts of [report.pianos, report.tunings, report.voicings, report.environments, report.reminders]) {
      report.total.added += counts.added;
      report.total.overwritten += counts.overwritten;
      report.total.suspended += counts.suspended;
      report.total.unchanged += counts.unchanged;
    }
    return report;
  });
}
