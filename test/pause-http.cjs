'use strict';

/**
 * 命名演练副本暂停/恢复 HTTP 集成测试：
 *   临时库启动真实服务 → 创建命名副本 → 验证：
 *   [1] 权限（仅管理员）与原站场不可暂停
 *   [2] 暂停后手工业务变更全拒绝（排路/走行/等待/取消/计划/封锁/交接/编辑/重置），
 *       只读预检、GET、会话切换照常；管理台/值班台状态带暂停人与时间
 *   [3] 原站场在副本暂停期间照常运行；其他副本也照常
 *   [4] 值班员退出仍撤销其等待申请但不兑现后项
 *   [5] 延时取消剩余等待冻结：暂停期间到期不解除，恢复后续计时再解除
 *   [6] 暂停前已到期的取消：恢复后立即按原规则复核
 *   [7] 定时走行计划下一步冻结，恢复后续走；逾期步恢复立即注入
 *   [8] 重复暂停/恢复幂等不重复调整时间
 *   [9] 暂停跨服务重启有效，启动扫描跳过；恢复后立即复核
 *
 * 运行：node test/pause-http.cjs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3923;
const DB_PATH = process.env.SMOKE_DB_PAUSE || path.join(__dirname, '..', 'data', 'pause-test.db');
const YARD_DB = (id) => path.join(
  path.dirname(DB_PATH),
  path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards',
  `yard-${id}.db`
);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) throw new Error(name + (extra ? `（${JSON.stringify(extra)}）` : ''));
  console.log('  ✓', name);
  passed++;
}
function eq(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log('  ✓', name);
  passed++;
}

let server = null;
function startServer(keepDb = false) {
  return new Promise((resolve, reject) => {
    if (!keepDb) {
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
      }
      fs.rmSync(path.join(path.dirname(DB_PATH),
        path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards'),
      { recursive: true, force: true });
    }
    server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH, SEED_DEMO: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('服务启动超时: ' + out)), 10000);
    server.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('已启动')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (d) => { out += d.toString(); });
    server.on('exit', (code) => { if (code !== 0) reject(new Error('服务异常退出: ' + out)); });
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('exit', () => { server = null; resolve(); });
    server.kill('SIGTERM');
    setTimeout(() => { try { server.kill('SIGKILL'); } catch (_) {} }, 3000);
  });
}

async function api(pathName, { token, method = 'GET', body } = {}) {
  const urlPath = pathName.startsWith('/api/') || !pathName.startsWith('/')
    ? pathName : '/api' + pathName;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const resp = await fetch(BASE + urlPath, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await resp.json(); } catch (_) {}
  return { status: resp.status, data };
}

async function login(role, nameOrPwd) {
  const body = role === 'admin' ? { password: nameOrPwd || 'admin123' } : { name: nameOrPwd };
  const { status, data } = await api(`/api/auth/login/${role}`, { method: 'POST', body });
  if (status !== 200) throw new Error('登录失败: ' + data.error);
  return data.token;
}

const chooseYard = (token, yardId) =>
  api('/api/auth/yard', { token, method: 'PUT', body: { yardId } });
const getState = async (token) => (await api('/api/state', { token })).data.state;
const pauseYard = (token, id) => api(`/api/admin/yards/${id}/pause`, { token, method: 'POST' });
const resumeYard = (token, id) => api(`/api/admin/yards/${id}/resume`, { token, method: 'POST' });

async function openR1(token) {
  const r = await api('/api/routes/R1/open', {
    token, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  if (r.status !== 200) throw new Error('开放 R1 失败: ' + JSON.stringify(r.data));
  return r.data.instance.id;
}

async function waitInstanceGone(token, id, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await getState(token);
    if (!st.openInstances.some((x) => x.id === id)) return st;
    if (Date.now() > deadline) throw new Error(`实例 #${id} 在 ${timeoutMs}ms 内未解除`);
    await sleep(120);
  }
}

async function waitPlanStatus(token, id, status, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await api(`/api/movement-plans/${id}`, { token });
    if (r.data.plan && r.data.plan.status === status) return r.data.plan;
    if (Date.now() > deadline) throw new Error(`计划 #${id} 未在 ${timeoutMs}ms 内变为 ${status}`);
    await sleep(120);
  }
}

function yardDbRaw(id) {
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3');
  return new Database(YARD_DB(id));
}

async function main() {
  await startServer();
  const admin = await login('admin');
  const jia = await login('dispatcher', '值班员甲');
  const yi = await login('dispatcher', '值班员乙');

  console.log('\n[1] 权限与原站场限制');
  let r = await api('/api/admin/yards/1/pause', { method: 'POST' });
  eq('未登录暂停 401', r.status, 401);
  r = await pauseYard(jia, 1);
  eq('值班员暂停 403', r.status, 403);
  r = await pauseYard(admin, 1);
  eq('原站场暂停 409', r.status, 409);
  eq('错误码 YARD_ORIGINAL_NOT_PAUSABLE', r.data.code, 'YARD_ORIGINAL_NOT_PAUSABLE');
  r = await resumeYard(admin, 1);
  eq('原站场恢复 409（未暂停）', r.status, 409);
  eq('错误码 YARD_NOT_PAUSED', r.data.code, 'YARD_NOT_PAUSED');
  r = await pauseYard(admin, 999);
  eq('未知副本暂停 404', r.status, 404);

  console.log('\n[2] 创建副本并暂停；状态/列表显示暂停人与时间');
  r = await api('/api/admin/yards', {
    token: admin, method: 'POST', body: { name: '暂停演练甲' }
  });
  eq('创建副本 201', r.status, 201);
  const Y1 = r.data.yard.id;
  const tPause = Date.now();
  r = await pauseYard(admin, Y1);
  eq('暂停副本 201', r.status, 201);
  eq('changed=true', r.data.changed, true);
  eq('暂停状态 paused', r.data.pause.status, 'paused');
  eq('暂停人', r.data.pause.pausedBy, '管理员');
  ok('暂停时刻合理', Math.abs(r.data.pause.pausedAt - tPause) < 5000, r.data.pause);
  eq('响应带副本名', r.data.yardName, '暂停演练甲');

  await chooseYard(jia, Y1);
  let st = await getState(jia);
  eq('值班台 state 带暂停状态', st.pause && st.pause.paused, true);
  eq('state 暂停人', st.pause.pausedBy, '管理员');
  ok('state 暂停时间文本', !!st.pause.pausedAtText, st.pause);
  r = await api('/api/auth/yards', { token: jia });
  const y1row = r.data.yards.find((y) => y.id === Y1);
  eq('站场列表暂停标记', y1row.paused, true);
  const yorig = r.data.yards.find((y) => y.id === 1);
  eq('原站场不暂停', yorig.paused, false);

  console.log('\n[3] 暂停期间手工业务变更全部拒绝（409 YARD_PAUSED），只读照常');
  const mutDenied = async (method, p, body) => {
    const rr = await api(p, { token: jia, method, body });
    eq(`${method} ${p} → 409`, rr.status, 409);
    eq(`${method} ${p} → YARD_PAUSED`, rr.data.code, 'YARD_PAUSED');
  };
  await mutDenied('POST', '/routes/R1/open', { switchPositions: { SW7: 'N', SW8: 'N' } });
  await mutDenied('POST', '/routes/R1/waiting', { switchPositions: { SW7: 'N', SW8: 'N' } });
  await mutDenied('POST', '/switches/SW7/move', { position: 'R' });
  await mutDenied('POST', '/sections/1/state', { action: 'occupy' });
  await mutDenied('POST', '/instances/999/events', { seq: 1, sectionId: '1', action: 'occupy' });
  await mutDenied('POST', '/instances/999/release', {});
  await mutDenied('POST', '/instances/999/cancel-delayed', {});
  await mutDenied('POST', '/instances/999/movement-plans', { steps: [] });
  await mutDenied('POST', '/waiting/1/cancel', {});
  await mutDenied('POST', '/handovers', {});
  await mutDenied('POST', '/handovers/1/sign', {});
  // 管理员侧的变更（封锁/重置/编辑）同样拒绝（管理员切换到该副本）
  await chooseYard(admin, Y1);
  await mutDeniedAdmin('/api/admin/blockades', { sectionId: '1', reason: '暂停期施工' });
  await mutDeniedAdmin('/api/admin/reset/state', {});
  await mutDeniedAdmin('/api/admin/reset/training', {});
  await mutDeniedAdmin('/api/admin/sections',
    { id: '99', label: 'x', x1: 0, y1: 0, x2: 1, y2: 1 });
  async function mutDeniedAdmin(p, body) {
    const rr = await api(p, { token: admin, method: 'POST', body });
    eq(`管理员 ${p} → 409`, rr.status, 409);
    eq(`管理员 ${p} → YARD_PAUSED`, rr.data.code, 'YARD_PAUSED');
  }
  // 保护时长设置（元数据）不拦截
  r = await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 60 }
  });
  eq('暂停中可改保护时长（元数据）', r.status, 200);
  // 创建副本（作用于原站场）不拦截
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '暂停中创建的副本' } });
  eq('暂停当前副本时仍可从原站场创建新副本', r.status, 201);
  const Y_OTHER = r.data.yard.id;

  // 只读：预检与 GET 照常
  r = await api('/routes/R1/check', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('暂停中预检 200（只读）', r.status, 200);
  r = await api('/state', { token: jia });
  eq('暂停中 /api/state 200', r.status, 200);
  r = await api('/waiting', { token: jia });
  eq('暂停中查询等待 200', r.status, 200);
  // 会话切换照常（切回原站场）
  r = await chooseYard(jia, 1);
  eq('暂停中切换站场 200', r.status, 200);

  console.log('\n[4] 原站场与其他副本在暂停期间照常运行');
  // 原站场：开放+走行+解除 全流程
  const iidO = await openR1(jia);
  await api(`/api/instances/${iidO}/events`, {
    token: jia, method: 'POST', body: { seq: 1, sectionId: '1', action: 'occupy' }
  });
  // 另一副本 Y_OTHER 也可操作
  r = await chooseYard(yi, Y_OTHER);
  eq('切到其他副本 200', r.status, 200);
  const iidOther = await openR1(yi);
  ok('其他副本暂停期间可开放进路', Number.isInteger(iidOther), iidOther);
  // 暂停副本 Y1 上仍无任何开放实例（手工开放被拒）
  r = await api('/api/admin/state', { token: admin }); // 管理员当前在 Y1
  eq('暂停副本无新实例（手工变更被拒）', r.data.state.openInstances.length, 0);

  console.log('\n[5] 值班员退出仍撤销等待申请，但不在暂停副本兑现后项');
  // 原站场制造一把锁，让乙在 Y1 的等待申请处于 waiting；再在 Y_OTHER 放 waiting
  const bing = await login('dispatcher', '值班员丙');
  await chooseYard(bing, Y1);
  r = await api('/routes/R1/waiting', {
    token: bing, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('暂停副本提交等待被拒（属手工变更）', r.status, 409);
  // 在原站场提交等待（会被 iidO 占用阻断而 waiting）
  await chooseYard(bing, 1);
  r = await api('/routes/R1/waiting', {
    token: bing, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('原站场提交等待 201', r.status, 201);
  const wId = r.data.waiting.id;
  eq('原站场等待处于 waiting', r.data.waiting.status, 'waiting');
  // 退出登录：各站场撤销其 waiting
  r = await api('/api/auth/logout', { token: bing, method: 'POST' });
  eq('退出登录 200', r.status, 200);
  const bingCheck = await login('dispatcher', '值班员丁'); // 用另一人查全员
  r = await api('/api/waiting?scope=all&status=cancelled', { token: bingCheck });
  ok('退出后本人等待已撤销', r.data.waiting.some((w) => w.id === wId), { wId });

  console.log('\n[6] 延时取消：暂停期间到期不解除；恢复后续计时解除（冻结剩余等待）');
  // 管理员回原站场，保护时长设为 2 秒；重置原站场清场
  await chooseYard(admin, 1);
  await api('/api/admin/reset/training', { token: admin, method: 'POST' });
  await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 2 }
  });
  const iidC = await openR1(jia);
  r = await api(`/api/instances/${iidC}/cancel-delayed`, { token: jia, method: 'POST' });
  const releaseAt = r.data.cancellation.releaseAt;
  // 复制为新副本（pending 取消沿用 releaseAt），暂停它
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '冻结取消副本' } });
  const YC = r.data.yard.id;
  await sleep(600); // 此时距 releaseAt 约 1.4s（仍未到期）
  r = await pauseYard(admin, YC);
  const pausedAt = r.data.pause.pausedAt;
  ok('暂停时取消尚未到期', releaseAt > pausedAt, { releaseAt, pausedAt });
  const remainAtPause = releaseAt - pausedAt;
  await sleep(2600); // 超过原 releaseAt，但暂停不得解除
  {
    const d = yardDbRaw(YC);
    const row = d.prepare(`SELECT status, release_at FROM cancellation_applications`).get();
    eq('暂停期间取消仍 pending', row.status, 'pending');
    eq('暂停期间 release_at 未被改写', row.release_at, releaseAt);
    d.close();
  }
  // 界面口径：暂停中取消带 frozen=true，剩余时间冻结（不随墙钟归零）
  {
    await chooseYard(jia, YC);
    const r1 = await api('/api/cancellations?scope=all&status=pending', { token: jia });
    const c = r1.data.cancellations[0];
    eq('暂停中取消 frozen=true', c.frozen, true);
    ok('暂停中剩余时间显示冻结值（>0）', c.remainingMs > 1000, c.remainingMs);
    ok('暂停中 overDue=false（按暂停时刻口径）', c.overDue === false, c.overDue);
    await chooseYard(jia, 1);
  }
  const tResume = Date.now();
  r = await resumeYard(admin, YC);
  eq('恢复 200', r.status, 200);
  ok('恢复平移时长≈暂停持续',
    Math.abs(r.data.frozenDeltaMs - (tResume - pausedAt)) < 600, { frozen: r.data.frozenDeltaMs });
  {
    const d = yardDbRaw(YC);
    const row = d.prepare(`SELECT status, release_at FROM cancellation_applications`).get();
    ok('恢复后 release_at 后移且剩余时间保持',
      Math.abs((row.release_at - Date.now()) - remainAtPause) < 600,
      { remain: row.release_at - Date.now(), remainAtPause });
    d.close();
  }
  // 恢复后约 remainAtPause（~1.4s）到期解除，再等 3 秒确认
  await sleep(3000);
  {
    const d = yardDbRaw(YC);
    const row = d.prepare(`SELECT status FROM cancellation_applications`).get();
    eq('恢复后续计时到期 → released', row.status, 'released');
    const inst = d.prepare(`SELECT status FROM route_instances`).get();
    eq('进路同步解除', inst.status, 'released');
    d.close();
  }

  console.log('\n[7] 暂停前已到期而未处理的取消：恢复后立即复核（不调整时间）');
  await chooseYard(admin, 1);
  await api('/api/admin/reset/training', { token: admin, method: 'POST' });
  await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 300 }
  });
  const iidD = await openR1(jia);
  r = await api(`/api/instances/${iidD}/cancel-delayed`, { token: jia, method: 'POST' });
  const cId = r.data.cancellation.id;
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '逾期取消副本' } });
  const YD = r.data.yard.id;
  // 复制来的取消还有约 300s；暂停后把库里 release_at 改到过去，
  // 构造"暂停前已到期而未处理"（模拟重启/时钟边界下到期未处理）
  r = await pauseYard(admin, YD);
  eq('暂停含未到期取消副本 201', r.status, 201);
  {
    const d = yardDbRaw(YD);
    d.prepare(`UPDATE cancellation_applications SET release_at=? WHERE id=?`)
      .run(Date.now() - 2000, cId);
    d.close();
  }
  await sleep(1200); // 暂停中即便到期也不处理
  {
    const d = yardDbRaw(YD);
    eq('暂停中已到期取消仍 pending',
      d.prepare(`SELECT status FROM cancellation_applications WHERE id=?`).get(cId).status, 'pending');
    d.close();
  }
  r = await resumeYard(admin, YD);
  // 恢复处理结果在响应 processed 中（已到期 → 立即核验解除）
  ok('恢复响应含立即解除的取消编号',
    r.data.processed.cancellations.released.includes(cId), r.data.processed);
  {
    const d = yardDbRaw(YD);
    eq('恢复后已到期取消立即 released',
      d.prepare(`SELECT status FROM cancellation_applications WHERE id=?`).get(cId).status, 'released');
    d.close();
  }
  // 恢复后保护时长改回小值供后续计划场景（不影响）
  await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 2 }
  });

  console.log('\n[8] 定时走行计划：下一步冻结，恢复后续走；暂停期间不注入事件');
  await chooseYard(admin, 1);
  await api('/api/admin/reset/training', { token: admin, method: 'POST' });
  const steps = ['1', '3', '5'].flatMap((sid) => [
    { sectionId: sid, action: 'occupy', waitSeconds: 1 },
    { sectionId: sid, action: 'clear', waitSeconds: 1 }
  ]);
  // 创建一个空的已清场副本（活动计划不随副本复制），在副本内开放+提交计划
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '冻结计划副本' } });
  const YP = r.data.yard.id;
  await chooseYard(jia, YP);
  const iidP2 = await openR1(jia);
  r = await api(`/api/instances/${iidP2}/movement-plans`, {
    token: jia, method: 'POST', body: { steps }
  });
  eq('副本提交计划 201', r.status, 201);
  const planId2 = r.data.plan.id;
  const due1 = r.data.plan.nextStep.dueAt;
  await sleep(300); // 第 1 步等待 1s；尚余约 0.7s 时暂停
  r = await pauseYard(admin, YP);
  const pAt = r.data.pause.pausedAt;
  ok('暂停时第1步未到期', due1 > pAt, { due1, pAt });
  await sleep(2000); // 到期时点被冻结
  {
    const d = yardDbRaw(YP);
    const nEvents = d.prepare(`SELECT COUNT(*) AS n FROM section_events`).get().n;
    eq('暂停期间计划未注入任何事件', nEvents, 0);
    const s1 = d.prepare(`SELECT due_at FROM movement_plan_steps WHERE plan_id=? AND step_order=1`).get(planId2);
    eq('暂停期间第1步 due_at 未改写', s1.due_at, due1);
    d.close();
  }
  // 界面口径：暂停中计划 frozen=true，下一步剩余时间冻结
  {
    const gp = await api(`/api/movement-plans/${planId2}`, { token: jia });
    eq('暂停中计划 frozen=true', gp.data.plan.frozen, true);
    ok('暂停中下一步剩余时间冻结（>0.3s）',
      gp.data.plan.nextStep.remainingMs > 300, gp.data.plan.nextStep.remainingMs);
  }
  r = await resumeYard(admin, YP);
  {
    const d = yardDbRaw(YP);
    const s1 = d.prepare(`SELECT due_at FROM movement_plan_steps WHERE plan_id=? AND step_order=1`).get(planId2);
    ok('恢复后第1步到期时刻后移（剩余约 0.7s）',
      s1.due_at > Date.now() + 300, { remain: s1.due_at - Date.now() });
    d.close();
  }
  const plan = await waitPlanStatus(jia, planId2, 'completed', 9000);
  eq('恢复后计划继续走完全程 completed', plan.status, 'completed');
  {
    const d = yardDbRaw(YP);
    eq('恢复后注入全部 6 个事件',
      d.prepare(`SELECT COUNT(*) AS n FROM section_events`).get().n, 6);
    eq('恢复后进路解除',
      d.prepare(`SELECT status FROM route_instances WHERE id=?`).get(iidP2).status, 'released');
    d.close();
  }

  console.log('\n[9] 逾期计划步骤：恢复后立即依序注入，不重复发事件');
  await chooseYard(admin, 1);
  await api('/api/admin/reset/training', { token: admin, method: 'POST' });
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '逾期计划副本' } });
  const YP3 = r.data.yard.id;
  // 在副本内开放并提交计划（活动计划不随副本复制，这里是新提交）
  await chooseYard(jia, YP3);
  const iidP4 = await openR1(jia);
  r = await api(`/api/instances/${iidP4}/movement-plans`, {
    token: jia, method: 'POST', body: { steps }
  });
  const planId4 = r.data.plan.id;
  r = await pauseYard(admin, YP3);
  eq('暂停逾期计划副本 201', r.status, 201);
  {
    // 把首步到期改到过去（暂停前已到期而未处理）
    const d = yardDbRaw(YP3);
    d.prepare(`UPDATE movement_plan_steps SET due_at=? WHERE plan_id=? AND step_order=1`)
      .run(Date.now() - 1500, planId4);
    d.close();
  }
  await sleep(700);
  {
    const d = yardDbRaw(YP3);
    eq('暂停期间逾期步骤未注入',
      d.prepare(`SELECT COUNT(*) AS n FROM section_events`).get().n, 0);
    d.close();
  }
  r = await resumeYard(admin, YP3);
  // 恢复立即依序处理：逾期第1步立即注入，第2步从恢复时刻起再等 1 秒……
  // 等待整体完成（6 步，后续每步 1s，约 5 秒）
  const plan4 = await waitPlanStatus(jia, planId4, 'completed', 10000);
  eq('逾期步骤恢复后依序补注入并完成', plan4.status, 'completed');
  {
    const d = yardDbRaw(YP3);
    // 不重复走行：每个序号恰好一条事件
    const rows = d.prepare(
      `SELECT seq, COUNT(*) AS n FROM section_events GROUP BY seq ORDER BY seq`
    ).all();
    eq('事件序号 1~6 各一条（无重复走行）', rows.length, 6);
    ok('每序号仅一条', rows.every((x) => x.n === 1), rows);
    d.close();
  }

  console.log('\n[10] 重复暂停/恢复语义');
  // YP3 已恢复；重复恢复 409
  r = await resumeYard(admin, YP3);
  eq('重复恢复 409', r.status, 409);
  eq('重复恢复 code', r.data.code, 'YARD_NOT_PAUSED');
  // 暂停 → 重复暂停 200 changed=false，pausedAt 不变
  r = await pauseYard(admin, YP3);
  eq('再次暂停 201', r.status, 201);
  const pa1 = r.data.pause.pausedAt;
  await sleep(300);
  r = await pauseYard(admin, YP3);
  eq('重复暂停 200', r.status, 200);
  eq('重复暂停 changed=false', r.data.changed, false);
  eq('重复暂停不重算 pausedAt', r.data.pause.pausedAt, pa1);
  await resumeYard(admin, YP3);

  console.log('\n[11] 暂停跨服务重启有效；启动扫描跳过暂停副本');
  // 原站场开放+取消（长保护期 300s），复制副本后暂停，重启，确认仍暂停且未处理
  await chooseYard(admin, 1);
  await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 300 }
  });
  await api('/api/admin/reset/training', { token: admin, method: 'POST' });
  await chooseYard(jia, 1);
  const iidR = await openR1(jia);
  r = await api(`/api/instances/${iidR}/cancel-delayed`, { token: jia, method: 'POST' });
  const cR = r.data.cancellation.id;
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '重启暂停副本' } });
  const YR = r.data.yard.id;
  r = await pauseYard(admin, YR);
  eq('暂停待重启副本', r.status, 201);
  await stopServer();
  await startServer(true);
  // 重启后站场列表仍标记暂停
  const admin2 = await login('admin');
  r = await api('/api/auth/yards', { token: admin2 });
  const yrRow = r.data.yards.find((y) => y.id === YR);
  eq('重启后副本仍标记暂停', yrRow.paused, true);
  {
    const d = yardDbRaw(YR);
    eq('重启后暂停记录仍在',
      d.prepare(`SELECT status FROM yard_pause WHERE id=1`).get().status, 'paused');
    eq('重启后取消仍 pending（扫描跳过）',
      d.prepare(`SELECT status FROM cancellation_applications WHERE id=?`).get(cR).status, 'pending');
    eq('重启后进路仍开放',
      d.prepare(`SELECT status FROM route_instances`).get().status, 'open');
    d.close();
  }
  // 重启期间把 release_at 改到过去：仍暂停 → 不处理；恢复后立即解除
  {
    const d = yardDbRaw(YR);
    d.prepare(`UPDATE cancellation_applications SET release_at=? WHERE id=?`)
      .run(Date.now() - 1000, cR);
    d.close();
  }
  await sleep(1200);
  {
    const d = yardDbRaw(YR);
    eq('重启后已到期但暂停中：仍 pending',
      d.prepare(`SELECT status FROM cancellation_applications WHERE id=?`).get(cR).status, 'pending');
    d.close();
  }
  r = await resumeYard(admin2, YR);
  eq('重启后恢复 200', r.status, 200);
  ok('恢复立即处理重启期间到期取消',
    r.data.processed.cancellations.released.includes(cR), r.data.processed);
  await waitInstanceGone(jia, iidR).catch(() => {}); // iidR 属于原站场；查副本自身实例
  {
    const d = yardDbRaw(YR);
    eq('恢复后副本内进路解除',
      d.prepare(`SELECT status FROM route_instances`).get().status, 'released');
    d.close();
  }

  console.log(`\n暂停/恢复全部 ${passed} 项断言通过 ✅`);
  await stopServer();
}

main().catch(async (e) => {
  console.error('\n❌ 测试失败:', e);
  await stopServer();
  process.exit(1);
});
