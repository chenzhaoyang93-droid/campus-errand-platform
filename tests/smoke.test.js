/**
 * 帮跑校园 · 核心链路冒烟测试（jsdom）
 * 覆盖：XSS 转义 / 表单校验 / 搜索 / 排序 / 状态机(接单→配送→送达→确认) / 微评价标签 /
 *       信用事件账本 / 占座倒计时与延长 / 取件码保险箱 / 顺路拼单 / 紧急接力 / 预约周期 /
 *       动态赏金建议 / 取消发布 / 刷新持久化 / 自接拦截
 * 运行：npm install jsdom && node tests/smoke.test.js
 */
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');

const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
function check(name, cond){ if(cond){pass++;console.log('PASS',name)} else {fail++;console.log('FAIL',name)} }

function newDom(savedRaw) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => console.log('PAGE ERROR:', e.detail && e.detail.message, e.detail && e.detail.stack && e.detail.stack.split('\n')[1]));
  vc.on('error', (...a) => console.log('PAGE console.error:', ...a));
  return new JSDOM(html, { runScripts:'dangerously', url:'http://localhost/', pretendToBeVisual:true, virtualConsole: vc,
    beforeParse(win){ if (savedRaw) win.localStorage.setItem('bangpao_campus_v3', savedRaw); } });
}

(async()=>{
  let dom = newDom();
  let w = dom.window, d = w.document;
  const S = () => w.eval('S');
  const credit = () => w.eval('creditScore()');
  check('种子: 信用分由事件聚合为 108', credit()===108);

  // === 1. XSS 转义发布 ===
  const payload = '<b id="injected-title">粗体标题</b>';
  d.getElementById('fTitle').value = payload;
  d.getElementById('fReward').value = '5';
  d.getElementById('fSecret').value = '6-2-9999';
  w.submitTask();
  await sleep(900);
  check('XSS: 不生成注入 DOM', !d.getElementById('injected-title'));
  check('XSS: 标题按文本转义显示', d.getElementById('taskList').textContent.includes(payload));
  check('发布: 新任务进入广场(7条)', d.querySelectorAll('#taskList .task').length === 7);
  check('发布: 取件码进入保险箱', !!S().secrets[S().posted[0].id]);

  // === 2. 表单校验 ===
  d.getElementById('fTitle').value=''; d.getElementById('fReward').value='';
  w.submitTask();
  await sleep(100);
  check('校验: 空标题行内报错', d.getElementById('errTitle').classList.contains('show'));
  check('校验: 空赏金行内报错', d.getElementById('errReward').classList.contains('show'));

  // === 3. 搜索 ===
  const si = d.getElementById('searchInput');
  si.value='麻辣烫'; si.dispatchEvent(new w.Event('input',{bubbles:true}));
  check('搜索: 命中 1 条', d.querySelectorAll('#taskList .task').length===1);
  si.value='zzz不存在zzz'; si.dispatchEvent(new w.Event('input',{bubbles:true}));
  check('搜索: 空结果提示', !!d.querySelector('#taskList .empty'));
  d.getElementById('searchClear').click();
  check('搜索: 清除后恢复 7 条', d.querySelectorAll('#taskList .task').length===7);

  // === 4. 排序 ===
  d.querySelector('.sort-btn[data-sort="reward"]').click();
  const rewards = [...d.querySelectorAll('#taskList .t-reward')].map(e=>parseFloat(e.textContent.replace('¥','')));
  check('排序: 赏金降序', rewards.every((v,i,a)=>i===0||a[i-1]>=v));
  d.querySelector('.sort-btn[data-sort="latest"]').click();
  check('排序: 最新第一条是新发布', d.querySelector('#taskList .task').textContent.includes(payload));
  d.querySelector('.sort-btn[data-sort="rec"]').click();

  // === 5. 动态赏金建议 ===
  w.goPublish('buy');
  d.getElementById('fDest').value='图书馆';
  d.getElementById('fDest').dispatchEvent(new w.Event('input',{bubbles:true}));
  check('赏金建议: 显示建议区间', d.getElementById('priceTip').classList.contains('show') && d.getElementById('priceTip').textContent.includes('建议'));
  d.getElementById('fReward').value='1';
  d.getElementById('fReward').dispatchEvent(new w.Event('input',{bubbles:true}));
  check('赏金建议: 低价判定', d.getElementById('priceTip').textContent.includes('偏低'));

  // === 6. 状态机: 接单→配送→送达→确认 → 微评价 ===
  const creditBefore = credit();
  w.eval('S').ui.cat='all';
  const tid = 2; /* 麻辣烫 */
  w.openTask(tid);
  w.acceptTask(tid);
  await sleep(1100);
  check('接单: 状态 doing', S().taken.find(o=>o.id===tid).status==='doing');
  w.startDeliver(tid);
  check('配送: 状态 delivering', S().taken.find(o=>o.id===tid).status==='delivering');
  w.deliverOrder(tid);
  check('送达: 状态 wait_confirm', S().taken.find(o=>o.id===tid).status==='wait_confirm');
  w.confirmOrder(tid);
  check('确认: 状态 done', S().taken.find(o=>o.id===tid).status==='done');
  check('信用事件: 完成 +2 且准时 +1 → +3', credit() === creditBefore+3);
  check('订单事件: 已写入账本', S().orderEvents.some(e=>e.orderId===tid && e.type==='order_done'));
  /* 微评价标签 */
  d.querySelector('#reviewChips .tag-chip[data-i="4"]').click(); /* 准时 +1 */
  d.querySelector('#reviewChips .tag-chip[data-i="1"]').click(); /* 沟通 +0.5 */
  check('微评价: 可选标签并提交', !d.getElementById('reviewSubmit').disabled);
  d.getElementById('reviewSubmit').click();
  check('微评价: 信用 +1.5', credit() === creditBefore+4.5);
  check('统计: 已完成接单 24', d.getElementById('statCompleted').textContent==='24');

  // === 7. 占座倒计时 / 延长 / 凭证 ===
  w.acceptTask(3); /* 图书馆占座 */
  await sleep(100);
  const seatOrder = S().taken.find(o=>o.id===3);
  check('占座: 接单即启动倒计时', seatOrder.seat && seatOrder.seat.status==='active' && seatOrder.seat.holdUntil > Date.now());
  w.seatProof(3);
  check('占座: 凭证上传写事件', S().orderEvents.some(e=>e.orderId===3 && e.type==='seat_proof'));
  const before = seatOrder.seat.holdUntil;
  w.extendSeat(3);
  check('占座: 延长 10 分钟', S().taken.find(o=>o.id===3).seat.holdUntil === before + 10*60*1000);
  check('占座: 延长写入信用记录(Δ0)', S().creditEvents.some(e=>e.type==='seat_extension' && e.delta===0));
  check('占座: 只能延长一次', S().taken.find(o=>o.id===3).seat.ext === 1);
  w.confirmArrive(3);
  check('占座: 到达确认完成', S().taken.find(o=>o.id===3).status==='done');
  d.querySelector('#reviewChips .tag-chip[data-i="0"]').click();
  d.getElementById('reviewSubmit').click();

  // === 8. 取件码保险箱 ===
  w.acceptTask(1); /* 菜鸟驿站，有取件码 */
  await sleep(100);
  const secOrder = S().taken.find(o=>o.id===1);
  check('保险箱: 接单订单关联密件', secOrder.secretTaskId===1);
  w.viewSecret(1);
  check('保险箱: 展示取件码与 30s 倒计时', d.querySelector('.s-code') && d.querySelector('.s-code').textContent==='6-2-3018' && d.getElementById('secretCd').textContent.includes('30'));
  check('保险箱: 访问次数与日志', S().secrets[1].access===1 && S().secrets[1].logs.length===1);
  w.closeSecret();

  // === 9. 顺路拼单 ===
  /* 5 loc=紫荆公寓(宿舍区), 6 dest=紫荆公寓 5 号楼(宿舍区) → 顺路 */
  w.openTask(5);
  const alongHtml = d.getElementById('sheetBody').innerHTML;
  check('拼单: 详情出现顺路推荐', alongHtml.includes('顺路可再接'));
  const takenBefore = S().taken.length;
  w.eval('acceptGroup(5,6)');
  await sleep(100);
  check('拼单: 两单同时接下', S().taken.length === takenBefore+2 && S().taken.filter(o=>o.groupId).length===2);
  check('拼单: 广场移除两单', !S().tasks.find(t=>t.id===5) && !S().tasks.find(t=>t.id===6));
  check('拼单: OrderGroup 已创建', S().groups.length===1 && S().groups[0].taskIds.length===2);

  // === 10. 紧急接力发布 ===
  w.goPublish('express');
  d.getElementById('fTitle').value='急诊取药，急！';
  d.getElementById('fReward').value='12';
  d.getElementById('fDeadline').value='1 小时内';
  d.getElementById('fDeadline').dispatchEvent(new w.Event('change',{bubbles:true}));
  check('接力: 1 小时时限出现接力选项', d.getElementById('relayCheck').classList.contains('show'));
  d.getElementById('fRelay').checked = true;
  w.submitTask();
  await sleep(1300);
  const relayOrder = S().posted.find(p=>p.title==='急诊取药，急！');
  check('接力: 任务带广播标记', !!relayOrder.relay);
  w.simulateRunner(relayOrder.id);
  check('接力: 模拟跑手接单停止广播', S().posted.find(p=>p.id===relayOrder.id).status==='doing');
  check('接力: 停止广播写事件', S().orderEvents.some(e=>e.orderId===relayOrder.id && e.type==='broadcast_stopped'));
  w.simulateRunnerDeliver(relayOrder.id);
  w.publisherConfirm(relayOrder.id);
  check('接力: 发布者确认结算', S().posted.find(p=>p.id===relayOrder.id).status==='done');

  // === 11. 预约/周期任务 ===
  w.goPublish('buy');
  d.querySelector('.mode-btn[data-mode="weekly"]').click();
  d.getElementById('fTitle').value='每周三带咖啡';
  d.getElementById('fReward').value='4';
  w.submitTask();
  await sleep(1400);
  const sch = S().posted.find(p=>p.title==='每周三带咖啡');
  check('周期: 排期任务创建', sch && sch.status==='scheduled');
  w.triggerSchedule(sch.id);
  check('周期: 触发后上架广场', S().tasks.some(t=>t.title==='每周三带咖啡') && S().posted.find(p=>p.title==='每周三带咖啡' && p.status==='open'));

  // === 12. 取消发布 ===
  w.doCancelPosted(101);
  check('取消: 状态已取消', S().posted.find(p=>p.id===101).status==='cancelled');

  // === 13. 持久化 ===
  const savedRaw = w.localStorage.getItem('bangpao_campus_v3');
  check('持久化: 已写入', !!savedRaw);
  dom.window.close();
  const dom2 = newDom(savedRaw);
  await sleep(100);
  const w2 = dom2.window;
  check('刷新: 信用分恢复', w2.eval('creditScore()')===credit());
  check('刷新: 拼单组恢复', w2.eval('S').groups.length===1);
  check('刷新: 占座订单恢复', w2.eval('S').taken.find(o=>o.id===3).status==='done');
  check('刷新: 保险箱访问次数恢复', w2.eval('S').secrets[1].access===1);

  // === 14. 自接拦截 ===
  const myTask = w2.eval('S').tasks.find(t=>t.mine);
  w2.openTask(myTask.id);
  const btn = w2.document.querySelector('#sheetActions .primary');
  check('自接拦截: 按钮禁用', btn.disabled===true);
  w2.eval(`acceptTask(${myTask.id})`);
  check('自接拦截: 任务未被接走', !!w2.eval('S').tasks.find(t=>t.id===myTask.id));

  console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERROR',e);process.exit(1)});
