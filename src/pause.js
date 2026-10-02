'use strict';

/**
 * 命名演练副本的暂停 / 恢复。
 *
 * 语义（与需求一一对应）：
 *  - 仅管理员可暂停/恢复；只能暂停【命名演练副本】，原站场不可暂停（409）。
 *  - 暂停期间该副本：
 *      · 排路、走行、等待（提交/撤销）、延时取消、封锁、交接单（生成/签收）、
 *        站场编辑、推演重置等一切手工业务变更一律拒绝（409 YARD_PAUSED），
 *        只读查询（预检、各类 GET、/api/state）与会话站场切换照常；
 *      · 值班员退出登录仍按既有规则撤销其等待申请（不兑现任何后项——
 *        cancelByApplicant 在暂停库中只撤销不触发兑现扫描）；
 *      · 定时走行注入、延时取消到期处理、封锁待生效复核、等待自动兑现等自动
 *        推进全部跳过本副本（调度器按站场先查 isPaused），其他站场照常运行。
 *  - 暂停时冻结"活动走行计划下一步"（pending 且已排期的 due_at）与"待处理延时
 *    取消"（pending 的 release_at）的剩余等待：恢复事务内把这些时刻整体后移
 *    Δ=恢复时刻−暂停时刻，恢复后继续计时。后续计划步骤尚未排期（due_at NULL），
 *    仍按"上一步成功时刻 + 等待"计时，天然不受暂停影响，无需处理。
 *  - 暂停前已到期而未处理的事项：暂停期间扫描被跳过，恢复时时刻平移只作用于
 *    release_at/due_at 仍在暂停时刻之后的行；已到期（≤ paused_at）的行不平移，
 *    恢复后立即由与服务启动同一顺序的扫描按原规则复核。
 *  - 重复暂停不重复调整（幂等返回当前记录，created=false、Δ 不重复计入）；
 *    未暂停时恢复 409 YARD_NOT_PAUSED。
 *  - 暂停持久化在站场业务库的单行表 yard_pause，跨服务重启有效；恢复与到期
 *    扫描在同一 better-sqlite3 同步连接上串行执行，不可能重复走行或重复解除。
 */

const { getDb, withYard } = require('./db');
const yards = require('./yards');

function pauseRow() {
  return getDb().prepare(`SELECT * FROM yard_pause WHERE id=1`).get() || null;
}

/** 当前站场是否处于暂停中（业务模块/调度器据此短路自动推进） */
function isPaused() {
  const row = pauseRow();
  return !!(row && row.status === 'paused');
}

function rowToPause(row) {
  if (!row) return null;
  const paused = row.status === 'paused';
  const now = Date.now();
  return {
    status: row.status,                 // paused / resumed
    paused: paused,
    pausedBy: row.paused_by,
    pausedAt: row.paused_at,
    pausedAtText: row.paused_at
      ? new Date(row.paused_at).toLocaleString('zh-CN', { hour12: false }) : null,
    resumedBy: row.resumed_by,
    resumedAt: row.resumed_at,
    resumedAtText: row.resumed_at
      ? new Date(row.resumed_at).toLocaleString('zh-CN', { hour12: false }) : null,
    // 暂停中给出已持续毫秒（前端显示"已暂停 xx:xx"）；已恢复为 0
    pausedForMs: paused && row.paused_at ? Math.max(0, now - row.paused_at) : 0
  };
}

/** 当前站场暂停信息（无行/已恢复仅用于审计时也返回；未暂停时 paused=false） */
function getPause() {
  return rowToPause(pauseRow());
}

/** 活动暂停记录；未暂停返回 null（状态快照与列表只用这个） */
function activePause() {
  const row = pauseRow();
  return row && row.status === 'paused' ? rowToPause(row) : null;
}

/**
 * 暂停指定站场（命名演练副本）。在目标站场业务库上下文中执行。
 * @returns {{pause:Object, changed:boolean}} changed=false 表示重复暂停（幂等，不重算时间）
 */
function pauseYard(yardId, operator) {
  const yard = yards.yardRow(yardId);
  if (!yard || yard.status !== 'active') {
    const err = new Error(`未知演练副本 #${yardId}：该站场不存在`);
    err.status = 404;
    err.code = 'YARD_NOT_FOUND';
    throw err;
  }
  if (yardId === yards.ORIGINAL_YARD_ID) {
    const err = new Error('原站场为正式推演站场，不可暂停；仅命名演练副本可以暂停/恢复');
    err.status = 409;
    err.code = 'YARD_ORIGINAL_NOT_PAUSABLE';
    throw err;
  }
  return withYard(yardId, () => {
    const db = getDb();
    let changed = true;
    db.transaction(() => {
      const row = pauseRow();
      const now = Date.now();
      if (row && row.status === 'paused') {
        changed = false; // 重复暂停：原封不动返回，不重写 paused_at（Δ 不重复计入）
        return;
      }
      db.prepare(
        `INSERT INTO yard_pause(id,status,paused_by,paused_at,resumed_by,resumed_at)
         VALUES(1,'paused',?,?,NULL,NULL)
         ON CONFLICT(id) DO UPDATE SET status='paused',
               paused_by=excluded.paused_by, paused_at=excluded.paused_at,
               resumed_by=NULL, resumed_at=NULL`
      ).run(operator, now);
    })();
    console.log(`[pause] 站场 #${yardId}「${yard.name}」${changed ? '已暂停' : '重复暂停（幂等）'}（${operator}）`);
    return { pause: getPause(), changed };
  });
}

/**
 * 恢复指定站场：同一事务内冻结剩余时间后，立即按"服务启动"同一顺序复核本副本
 * （定时走行→延时取消→封锁复核→等待兑现）。暂停前已到期的事项不平移时刻，
 * 恢复后立即按原规则处理。
 * @returns {{pause:Object, processed:Object}}
 */
function resumeYard(yardId, operator) {
  const yard = yards.yardRow(yardId);
  if (!yard || yard.status !== 'active') {
    const err = new Error(`未知演练副本 #${yardId}：该站场不存在`);
    err.status = 404;
    err.code = 'YARD_NOT_FOUND';
    throw err;
  }
  return withYard(yardId, () => {
    const db = getDb();
    const frozen = db.transaction(() => {
      const row = pauseRow();
      if (!row || row.status !== 'paused') {
        const err = new Error(`演练副本「${yard.name}」当前未暂停，无需恢复（重复恢复不调整任何到期时间）`);
        err.status = 409;
        err.code = 'YARD_NOT_PAUSED';
        throw err;
      }
      const now = Date.now();
      const delta = now - row.paused_at; // 暂停持续毫秒（≥0）

      // 1) 待处理延时取消：仅平移"暂停时仍未到期"的 release_at；
      //    暂停前已到期（release_at <= paused_at）的保持原值 → 恢复后立即复核。
      const cancels = db.prepare(
        `UPDATE cancellation_applications SET release_at=release_at+?
          WHERE status='pending' AND release_at>?`
      ).run(delta, row.paused_at).changes;

      // 2) 活动走行计划下一步：仅"已排期且暂停时未到期"的 pending 步骤平移；
      //    已到期步骤（含逾期未处理）保持原 due_at → 恢复后立即依序注入；
      //    未排期步骤（due_at NULL，后续步）仍按上一步成功时刻计时，无需处理。
      const planSteps = db.prepare(
        `UPDATE movement_plan_steps SET due_at=due_at+?
          WHERE status='pending' AND due_at IS NOT NULL AND due_at>?`
      ).run(delta, row.paused_at).changes;

      db.prepare(
        `UPDATE yard_pause SET status='resumed', resumed_by=?, resumed_at=? WHERE id=1`
      ).run(operator, now);

      return { delta, cancels, planSteps };
    })();

    console.log(`[pause] 站场 #${yardId}「${yard.name}」已恢复（${operator}，暂停 ${frozen.delta}ms，` +
      `平移延时取消 ${frozen.cancels} 笔、计划步 ${frozen.planSteps} 步）`);

    // 恢复后立即复核，顺序与 server.js 启动流程严格一致（运动计划先于延时取消，
    // 封锁复核与等待兑现在后）；全部在本副本连接上同步执行，与 0.5s 定时扫描
    // 串行，不可能重复走行/重复解除（事件序号与唯一索引同样兜底）。
    const processed = runResumeSweeps('yard_resumed');
    return { pause: getPause(), processed, frozenDeltaMs: frozen.delta };
  });
}

/**
 * 恢复后（或测试需要时）按服务启动同一顺序跑一遍本副本的自动推进。
 * 调用方必须已处在该站场 withYard 上下文中，且 yard_pause 已不是 paused。
 */
function runResumeSweeps(trigger) {
  const movementPlan = require('./movement-plan');
  const cancellation = require('./cancellation');
  const blockade = require('./blockade');
  const waiting = require('./waiting');

  const plans = movementPlan.processDue(trigger);
  const cancels = cancellation.processDue(trigger);
  const blockadesActivated = blockade.refreshBlockadeStates(trigger);
  const swept = waiting.sweepFulfillments(trigger);
  return {
    movementPlans: plans,
    cancellations: cancels,
    blockadesActivated,
    waitingFulfilled: swept.fulfilled
  };
}

/**
 * 各站场暂停状态索引（站场列表/鉴权登录路径在主库连接上使用）：
 * @returns {Map<number,Object>} yardId -> 活动暂停信息
 */
function pauseMapAllYards() {
  const map = new Map();
  for (const y of yards.listYards()) {
    try {
      const p = withYard(y.id, () => activePause());
      if (p) map.set(y.id, p);
    } catch (_) {
      // 单个站场读取失败不阻塞列表
    }
  }
  return map;
}

module.exports = {
  isPaused,
  getPause,
  activePause,
  pauseYard,
  resumeYard,
  runResumeSweeps,
  pauseMapAllYards
};
