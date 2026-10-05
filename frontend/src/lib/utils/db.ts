/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbpianotune-db，数据结构版本号 version(1) 与 upgrade() 迁移逻辑
 * - 钢琴 / 调律 / 整音维修 / 琴房环境 / 周期提醒 五张表分表存储
 * - 首次打开自动播种互相引用的演示数据（含超期琴与异常环境），保证每个页面打开都有内容
 */
import Dexie, { type Table } from 'dexie';
import type { Piano } from '$lib/types/piano';
import type { Tuning } from '$lib/types/tuning';
import type { Voicing } from '$lib/types/voicing';
import { isAbnormal, type Environment } from '$lib/types/environment';
import { addMonths, deriveReminderState, type Reminder } from '$lib/types/reminder';
import { nowIso } from './uuid';
import { deriveTuningMetrics } from './cents';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbpianotune-db';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 1;

/** 行结构修订号 */
export const ROW_REVISION = 1;

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type PianoRow = Piano & Revisioned;
export type TuningRow = Tuning & Revisioned;
export type VoicingRow = Voicing & Revisioned;
export type EnvironmentRow = Environment & Revisioned;
export type ReminderRow = Reminder & Revisioned;

class GbPianoTuneDatabase extends Dexie {
  pianos!: Table<PianoRow, string>;
  tunings!: Table<TuningRow, string>;
  voicings!: Table<VoicingRow, string>;
  environments!: Table<EnvironmentRow, string>;
  reminders!: Table<ReminderRow, string>;

  constructor() {
    super(DB_NAME);

    this.version(DB_SCHEMA_VERSION)
      .stores({
        pianos: 'id, brand, model, serialNo, type, venue, state, updatedAt',
        tunings: 'id, pianoId, date, technician, pitchRaised, updatedAt',
        voicings: 'id, pianoId, type, parts, state, date, updatedAt',
        environments: 'id, pianoId, date, device, abnormal, updatedAt',
        reminders: 'id, pianoId, state, nextDueDate, updatedAt'
      })
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['pianos', 'tunings', 'voicings', 'environments', 'reminders'];
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION;
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now();
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
            });
        }
      });
  }
}

export const db = new GbPianoTuneDatabase();

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open();
  if ((await db.pianos.count()) === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 钢琴 ------------------------------ */

export async function listPianos(): Promise<PianoRow[]> {
  const rows = await db.pianos.toArray();
  return rows.sort((a, b) => a.brand.localeCompare(b.brand, 'zh-Hans-CN') || a.model.localeCompare(b.model, 'zh-Hans-CN'));
}

export async function putPiano(row: PianoRow): Promise<void> {
  await db.pianos.put(row);
}

export async function updatePiano(id: string, patch: Partial<Piano>): Promise<void> {
  await db.pianos.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 删除钢琴：级联删除其调律 / 维修 / 环境 / 提醒 */
export async function removePiano(id: string): Promise<void> {
  await db.transaction('rw', [db.pianos, db.tunings, db.voicings, db.environments, db.reminders], async () => {
    await db.tunings.where('pianoId').equals(id).delete();
    await db.voicings.where('pianoId').equals(id).delete();
    await db.environments.where('pianoId').equals(id).delete();
    await db.reminders.where('pianoId').equals(id).delete();
    await db.pianos.delete(id);
  });
}

/* ------------------------------ 调律 ------------------------------ */

export async function listTunings(): Promise<TuningRow[]> {
  const rows = await db.tunings.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export async function putTuning(row: TuningRow): Promise<void> {
  await db.tunings.put(row);
}

export async function updateTuning(id: string, patch: Partial<Tuning>): Promise<void> {
  await db.tunings.update(id, { ...patch, updatedAt: Date.now() } as never);
}

export async function removeTuning(id: string): Promise<void> {
  await db.tunings.delete(id);
}

/* --------------------------- 整音与维修 --------------------------- */

export async function listVoicings(): Promise<VoicingRow[]> {
  const rows = await db.voicings.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export async function putVoicing(row: VoicingRow): Promise<void> {
  await db.voicings.put(row);
}

export async function updateVoicing(id: string, patch: Partial<Voicing>): Promise<void> {
  await db.voicings.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 完成维修：回写钢琴状态（全部完成则置为正常，否则置为待修） */
export async function completeVoicing(id: string): Promise<void> {
  await db.transaction('rw', [db.voicings, db.pianos], async () => {
    const voicing = await db.voicings.get(id);
    if (!voicing) throw new Error('维修记录不存在');
    await db.voicings.update(id, { state: '已完成', updatedAt: Date.now() } as never);
    const pending = await db.voicings
      .where('pianoId')
      .equals(voicing.pianoId)
      .filter((item) => item.state !== '已完成' && item.id !== id)
      .count();
    await db.pianos.update(voicing.pianoId, {
      state: pending === 0 ? '正常' : '待修',
      updatedAt: Date.now()
    } as never);
  });
}

/** 新建维修计划时把钢琴置为待修 */
export async function markPianoPending(pianoId: string): Promise<void> {
  await db.pianos.update(pianoId, { state: '待修', updatedAt: Date.now() } as never);
}

export async function removeVoicing(id: string): Promise<void> {
  await db.voicings.delete(id);
}

/* ---------------------------- 琴房环境 ---------------------------- */

export async function listEnvironments(): Promise<EnvironmentRow[]> {
  const rows = await db.environments.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export async function putEnvironment(row: EnvironmentRow): Promise<void> {
  await db.environments.put(row);
}

export async function updateEnvironment(id: string, patch: Partial<Environment>): Promise<void> {
  await db.environments.update(id, { ...patch, updatedAt: Date.now() } as never);
}

export async function removeEnvironment(id: string): Promise<void> {
  await db.environments.delete(id);
}

/* ---------------------------- 周期提醒 ---------------------------- */

export async function listReminders(): Promise<ReminderRow[]> {
  const rows = await db.reminders.toArray();
  return rows.sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
}

export async function putReminder(row: ReminderRow): Promise<void> {
  await db.reminders.put(row);
}

export async function updateReminder(id: string, patch: Partial<Reminder>): Promise<void> {
  await db.reminders.update(id, { ...patch, updatedAt: Date.now() } as never);
}

export async function removeReminder(id: string): Promise<void> {
  await db.reminders.delete(id);
}

/* --------------------------- 整库导出与合档 --------------------------- */

/** 备份中的一行：通常带修订号与时间戳，旧备份可能缺这些字段 */
export type SnapshotEntity<T> = T & Partial<Revisioned>;

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  pianos: SnapshotEntity<Piano>[];
  tunings: SnapshotEntity<Tuning>[];
  voicings: SnapshotEntity<Voicing>[];
  environments: SnapshotEntity<Environment>[];
  reminders: SnapshotEntity<Reminder>[];
}

/** 子记录表名（挂起明细用） */
export type ChildTableName = 'tunings' | 'voicings' | 'environments' | 'reminders';

/** 单表合档计数 */
export interface MergeTableCount {
  /** 主库没有、直接照搬的条数 */
  added: number;
  /** 同编号下备份版本更新、覆盖主库的条数 */
  updated: number;
  /** 找不到对应钢琴档案、挂起未写库的条数 */
  suspended: number;
}

/** 一条挂起记录的明细 */
export interface MergeSuspended {
  table: ChildTableName;
  id: string;
  pianoId: string;
  label: string;
  reason: string;
}

/** 合档结果计数 */
export interface MergeReport {
  pianos: MergeTableCount;
  tunings: MergeTableCount;
  voicings: MergeTableCount;
  environments: MergeTableCount;
  reminders: MergeTableCount;
  suspended: MergeSuspended[];
}

function emptyCount(): MergeTableCount {
  return { added: 0, updated: 0, suspended: 0 };
}

function stripRow<T extends Revisioned>(row: T): SnapshotEntity<Omit<T, keyof Revisioned>> {
  // 保留修订号与时间戳：合档时要靠 updatedAt 逐条比对新旧
  return { ...row };
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [pianos, tunings, voicings, environments, reminders] = await Promise.all([
    db.pianos.toArray(),
    db.tunings.toArray(),
    db.voicings.toArray(),
    db.environments.toArray(),
    db.reminders.toArray()
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    pianos: pianos.map(stripRow),
    tunings: tunings.map(stripRow),
    voicings: voicings.map(stripRow),
    environments: environments.map(stripRow),
    reminders: reminders.map(stripRow)
  };
}

/** 从若干候选业务日期字段（YYYY-MM-DD）取可解析的时间戳，都没有时返回 0 */
function dateToTime(row: object, keys: string[]): number {
  const data = row as Record<string, unknown>;
  for (const key of keys) {
    const value = data[key];
    if (typeof value !== 'string' || !value) continue;
    const time = new Date(`${value}T00:00:00`).getTime();
    if (!Number.isNaN(time)) return time;
  }
  return 0;
}

/** 参与版本比较的业务日期字段（旧备份缺时间戳时兜底） */
const CHILD_DATE_KEYS: Record<ChildTableName, string[]> = {
  tunings: ['date'],
  voicings: ['date'],
  environments: ['date'],
  reminders: ['nextDueDate', 'lastTuningDate']
};

/** 一行的版本时间：优先 updatedAt，旧备份缺时间戳时退回业务日期，再缺为 0 */
function rowVersionTime(row: object, dateKeys: string[]): number {
  const data = row as Record<string, unknown>;
  if (typeof data.updatedAt === 'number' && Number.isFinite(data.updatedAt)) return data.updatedAt;
  return dateToTime(row, dateKeys);
}

/** 把备份行补齐为持久化行；旧备份缺少时间戳 / 修订号时用兜底时间填充 */
function stamp<T extends object>(row: SnapshotEntity<T>, fallbackTime: number): T & Revisioned {
  const updatedAt =
    typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : fallbackTime;
  const createdAt =
    typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : updatedAt;
  const revision = typeof row.revision === 'number' ? row.revision : ROW_REVISION;
  return { ...row, revision, createdAt, updatedAt };
}

function requireField(value: unknown, field: string, table: string): asserts value is string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`「${table}」存在 ${field} 缺失或非法的行，已取消合档（主库未改动）`);
  }
}

function requireNumber(value: unknown, field: string, table: string): asserts value is number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`「${table}」存在 ${field} 缺失或非法的行，已取消合档（主库未改动）`);
  }
}

/** 合档前行级校验：任一数据不合法都抛错，由事务保证整批撤回 */
function assertSnapshotRows(snapshot: DatabaseSnapshot): void {
  for (const row of snapshot.pianos) {
    requireField(row?.id, 'id', 'pianos');
  }
  for (const row of snapshot.tunings) {
    requireField(row?.id, 'id', 'tunings');
    requireField(row.pianoId, 'pianoId', 'tunings');
    requireField(row.date, 'date', 'tunings');
    requireNumber(row.basePitchHz, 'basePitchHz', 'tunings');
    const zones = (row as unknown as { zones?: unknown }).zones as
      | { bass?: unknown; mid?: unknown; treble?: unknown }
      | undefined;
    requireNumber(zones?.bass, 'zones.bass', 'tunings');
    requireNumber(zones?.mid, 'zones.mid', 'tunings');
    requireNumber(zones?.treble, 'zones.treble', 'tunings');
  }
  for (const row of snapshot.voicings) {
    requireField(row?.id, 'id', 'voicings');
    requireField(row.pianoId, 'pianoId', 'voicings');
  }
  for (const row of snapshot.environments) {
    requireField(row?.id, 'id', 'environments');
    requireField(row.pianoId, 'pianoId', 'environments');
    requireNumber(row.tempC, 'tempC', 'environments');
    requireNumber(row.humidityPct, 'humidityPct', 'environments');
  }
  for (const row of snapshot.reminders) {
    requireField(row?.id, 'id', 'reminders');
    requireField(row.pianoId, 'pianoId', 'reminders');
    requireNumber(row.cycleMonths, 'cycleMonths', 'reminders');
  }
}

type ChildEntity = { id: string; pianoId: string; date?: string };

/** 逐编号对齐一张子记录表：同 id 取时间戳晚者，父钢琴不存在则挂起不写库 */
async function mergeChildTable<T extends ChildEntity>(
  table: Table<T & Revisioned, string>,
  incoming: Array<SnapshotEntity<T>>,
  pianoIds: Set<string>,
  counter: MergeTableCount,
  reportSuspended: MergeSuspended[],
  meta: { name: ChildTableName; label: string }
): Promise<void> {
  const locals = await table.toArray();
  const puts: Array<T & Revisioned> = [];
  const dateKeys = CHILD_DATE_KEYS[meta.name];
  for (const raw of incoming) {
    if (!pianoIds.has(raw.pianoId)) {
      counter.suspended += 1;
      reportSuspended.push({
        table: meta.name,
        id: raw.id,
        pianoId: raw.pianoId,
        label: `${meta.label}${raw.date ? ` ${raw.date}` : ''}（${raw.id}）`,
        reason: `找不到对应的钢琴档案（${raw.pianoId}），已挂起`
      });
      continue;
    }
    const existing = locals.find((item) => item.id === raw.id);
    const incomingTime = rowVersionTime(raw, dateKeys);
    if (!existing) {
      counter.added += 1;
      puts.push(stamp(raw, dateToTime(raw, dateKeys) || Date.now()));
    } else if (incomingTime > rowVersionTime(existing, dateKeys)) {
      counter.updated += 1;
      const next = stamp(raw, dateToTime(raw, dateKeys) || existing.updatedAt);
      next.createdAt = Math.min(existing.createdAt, next.createdAt);
      puts.push(next);
    }
  }
  await table.bulkPut(puts);
}

/**
 * 合档后重算全部派生数据：
 * - 调律：按基准音高与三音区音分重算平均 / 最大偏差与复调标记
 * - 环境：按温湿度重算超标标记（超标天数随之刷新）
 * - 提醒：按每台琴最新调律日期重算上次调律 / 下次建议日期与周期状态（剩余天数随之刷新）
 *
 * 直接写各表：在事务回调内 await 调用时自动并入当前事务（合档失败会随之一并撤回），
 * 在事务外单独调用时由 Dexie 自动提交。
 */
export async function recomputeDerivedData(): Promise<void> {
  const tunings = await db.tunings.toArray();
  const tuningFixes: TuningRow[] = [];
  const latestTuningDate = new Map<string, string>();
  for (const row of tunings) {
    const metrics = deriveTuningMetrics(row.zones);
    if (
      row.avgDeviationCents !== metrics.avgDeviationCents ||
      row.maxDeviationCents !== metrics.maxDeviationCents ||
      row.pitchRaised !== metrics.pitchRaised
    ) {
      tuningFixes.push({ ...row, ...metrics });
    }
    const current = latestTuningDate.get(row.pianoId);
    if (!current || row.date > current) latestTuningDate.set(row.pianoId, row.date);
  }
  await db.tunings.bulkPut(tuningFixes);

  const environments = await db.environments.toArray();
  const environmentFixes: EnvironmentRow[] = [];
  for (const row of environments) {
    const abnormal = isAbnormal(row.tempC, row.humidityPct);
    if (abnormal !== row.abnormal) environmentFixes.push({ ...row, abnormal });
  }
  await db.environments.bulkPut(environmentFixes);

  const reminders = await db.reminders.toArray();
  const reminderFixes: ReminderRow[] = [];
  for (const row of reminders) {
    const lastTuningDate = latestTuningDate.get(row.pianoId) ?? row.lastTuningDate;
    const nextDueDate = lastTuningDate ? addMonths(lastTuningDate, row.cycleMonths) : row.nextDueDate;
    const state = deriveReminderState(nextDueDate);
    if (
      lastTuningDate !== row.lastTuningDate ||
      nextDueDate !== row.nextDueDate ||
      state !== row.state
    ) {
      reminderFixes.push({ ...row, lastTuningDate, nextDueDate, state });
    }
  }
  await db.reminders.bulkPut(reminderFixes);
}

/**
 * 把笔记本带回的离线备份按编号逐条合并进主库（单事务，要么全部完成要么整体撤回）：
 * 同一编号取 updatedAt 较晚的版本；主库缺的照搬；子记录找不到钢琴档案先挂起不写库。
 * 旧备份缺少时间戳的行用业务日期兜底，仍可参与合并。合完统一重算派生指标。
 */
export async function mergeSnapshot(snapshot: DatabaseSnapshot): Promise<MergeReport> {
  assertSnapshotRows(snapshot);
  const report: MergeReport = {
    pianos: emptyCount(),
    tunings: emptyCount(),
    voicings: emptyCount(),
    environments: emptyCount(),
    reminders: emptyCount(),
    suspended: []
  };

  await db.transaction('rw', [db.pianos, db.tunings, db.voicings, db.environments, db.reminders], async () => {
    // 1. 先合钢琴档案（子记录的父引用前提）
    const localPianos = await db.pianos.toArray();
    const pianoPuts: PianoRow[] = [];
    for (const raw of snapshot.pianos) {
      const existing = localPianos.find((item) => item.id === raw.id);
      // 钢琴没有业务日期字段：旧备份缺时间戳时版本时间为 0，不会覆盖主库已有记录
      const incomingTime = rowVersionTime(raw, []);
      if (!existing) {
        report.pianos.added += 1;
        pianoPuts.push(stamp(raw, Date.now()));
      } else if (incomingTime > rowVersionTime(existing, [])) {
        report.pianos.updated += 1;
        const next = stamp(raw, existing.updatedAt);
        next.createdAt = Math.min(existing.createdAt, next.createdAt);
        pianoPuts.push(next);
      }
    }
    await db.pianos.bulkPut(pianoPuts);
    const pianoIds = new Set(await db.pianos.orderBy('id').primaryKeys());

    // 2. 四类子记录按编号对齐，父档案缺失的挂起
    await mergeChildTable(db.tunings, snapshot.tunings, pianoIds, report.tunings, report.suspended, {
      name: 'tunings',
      label: '调律记录'
    });
    await mergeChildTable(db.voicings, snapshot.voicings, pianoIds, report.voicings, report.suspended, {
      name: 'voicings',
      label: '整音维修'
    });
    await mergeChildTable(
      db.environments,
      snapshot.environments,
      pianoIds,
      report.environments,
      report.suspended,
      { name: 'environments', label: '琴房环境' }
    );
    await mergeChildTable(db.reminders, snapshot.reminders, pianoIds, report.reminders, report.suspended, {
      name: 'reminders',
      label: '周期提醒'
    });

    // 3. 重算调律偏差 / 复调标记、温湿度超标与周期提醒（本函数并入当前事务，失败整体撤回）
    await recomputeDerivedData();
  });

  return report;
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.pianos, db.tunings, db.voicings, db.environments, db.reminders], async () => {
    await Promise.all([
      db.pianos.clear(),
      db.tunings.clear(),
      db.voicings.clear(),
      db.environments.clear(),
      db.reminders.clear()
    ]);
  });
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [pianos, tunings, voicings, environments, reminders] = await Promise.all([
    db.pianos.count(),
    db.tunings.count(),
    db.voicings.count(),
    db.environments.count(),
    db.reminders.count()
  ]);
  return { pianos, tunings, voicings, environments, reminders };
}
