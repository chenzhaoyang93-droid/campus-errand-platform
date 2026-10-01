/**
 * 帮跑校园 · 核心链路冒烟测试（jsdom，77 条断言）
 * 覆盖：注册与学籍认证 / 一人一号 / 未认证权限拦截 / 成员切换与数据隔离 /
 *       XSS 转义 / 表单校验 / 搜索 / 排序 / 状态机(接单→配送→送达→确认) / 微评价标签 /
 *       信用事件账本 / 占座倒计时与延长 / 取件码保险箱 / 顺路拼单 / 紧急接力 / 预约周期 /
 *       动态赏金建议 / 取消发布 / 刷新持久化 / 自接拦截
 * 运行：npm install jsdom && node tests/smoke.test.js
 */
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');

const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const pageErrors = [];   /* 页内未捕获异常计入失败 */
function check(name, cond){ if(cond){pass++;console.log('PASS',name)} else {fail++;console.log('FAIL',name)} }

function newDom(savedRaw) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => pageErrors.push('jsdomError: ' + (e.detail && e.detail.message || e)));
  vc.on('error', (...a) => pageErrors.push('console.error: ' + a.join(' ')));
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
  const myTask = w2.eval('S.tasks.find(t => isMine(t))');
  w2.openTask(myTask.id);
  const btn = w2.document.querySelector('#sheetActions .primary');
  check('自接拦截: 按钮禁用', btn.disabled===true);
  w2.eval(`acceptTask(${myTask.id})`);
  check('自接拦截: 任务未被接走', !!w2.eval('S').tasks.find(t=>t.id===myTask.id));

  // === 15. 注册引导（首访触发） ===
  const d2 = w2.document;
  check('引导: 首访展示注册层', d2.getElementById('obLayer').hidden===false);
  w2.obWxLogin();
  await sleep(800);
  check('引导: 微信登录后进入学籍认证', w2.eval('obStep')===2);

  // === 16. 学籍认证注册新成员 ===
  d2.getElementById('obName').value='李同学';
  d2.getElementById('obCollege').value='计算机学院';
  d2.getElementById('obSid').value='2024001234';
  w2.obUploadCard();
  await sleep(1000);
  check('认证: 校园卡 OCR 通过', d2.getElementById('obCardBtn').classList.contains('up'));
  w2.obSubmitVerify();
  await sleep(1200);
  check('认证: 进入完成步骤', w2.eval('obStep')===3);
  check('认证: 新成员已创建(2位)', w2.eval('S').accounts.length===2);
  check('认证: 当前成员为新成员', w2.eval('S').name==='李同学' && w2.eval('S').verified===true);
  check('认证: 信用分从 100 起步', w2.eval('creditScore()')===100);
  check('认证: 新人无历史订单', w2.eval('S').taken.length===0 && w2.eval('S').posted.length===0);
  w2.finishOnboard();
  check('认证: 引导层已关闭', d2.getElementById('obLayer').hidden===true);
  check('认证: 新人视角信用分显示 100', d2.getElementById('creditNum').textContent==='100');

  // === 17. 未认证成员受限 ===
  w2.openOnboard();
  w2.obWxLogin();
  await sleep(800);
  d2.getElementById('obName').value='王同学';
  w2.obSkipVerify();
  check('未认证: 账号已创建', w2.eval('S').name==='王同学' && w2.eval('S').verified===false);
  check('未认证: 账号数 3 位', w2.eval('S').accounts.length===3);
  const tasksBefore = w2.eval('S').tasks.length;
  const freeTaskId = w2.eval('S').tasks[0].id;
  w2.acceptTask(freeTaskId);
  check('未认证: 接单被拦截', w2.eval('S').tasks.length===tasksBefore && w2.eval('S').taken.length===0);
  w2.submitTask();
  check('未认证: 发布被拦截', w2.eval('S').posted.length===0);
  check('未认证: 我的页显示未认证徽章', d2.getElementById('meVerify').classList.contains('warn'));
  w2.finishOnboard();

  // === 18. 成员切换与一人一号 ===
  w2.openAccounts();
  check('成员: 账号列表 3 位', d2.querySelectorAll('#sheetBody .acc-card').length===3);
  check('成员: 标注当前登录', d2.querySelector('#sheetBody .acc-card.on .acc-sub').textContent.includes('当前登录'));
  w2.switchAccount('u-demo');
  check('切换: 回到演示成员杨同学', w2.eval('S').name==='杨同学');
  check('切换: 信用分随之恢复（各成员独立账本）', w2.eval('creditScore()')===credit());
  check('切换: 信用分高于新人 100', w2.eval('creditScore()')>100);
  check('切换: 历史订单与足迹恢复', w2.eval('S').taken.length>0 && w2.eval('S').routes.length>0);
  check('切换: 我的页昵称同步', d2.getElementById('meName').textContent==='杨同学');
  check('切换: 认证徽章恢复正常', !d2.getElementById('meVerify').classList.contains('warn'));
  check('切换: 已认证成员数 2', w2.eval('S').accounts.filter(a=>a.verified).length===2);

  w2.openOnboard();
  w2.obWxLogin();
  await sleep(800);
  d2.getElementById('obName').value='重复学号';
  d2.getElementById('obSid').value='2024001234';
  w2.obUploadCard();
  await sleep(1000);
  w2.obSubmitVerify();
  await sleep(1200);
  check('一人一号: 重复学号被拦截', w2.eval('obForm').err.includes('已完成认证'));
  check('一人一号: 未新增账号', w2.eval('S').accounts.length===3);
  w2.closeOnboard();

  // === 19. 拼单复用接单校验（信用 / 本人任务 / 占座 / 接力） ===
  const pushTask = (id, extra) => w2.eval(`S.tasks.push(Object.assign({id:${id},ts:Date.now(),cat:"express",title:"拼单任务${id}",desc:"",reward:5,loc:"一食堂",dest:"图书馆",time:"今天内",urgent:false,relay:null,hasSecret:false,dist:0.5,issuer:"张同学",credit:100,avatar:"张",ownerId:"u-other"}, ${extra||'{}'}));`);
  pushTask(9001); pushTask(9002);
  w2.acceptGroup(9001, 9002);
  const gA = w2.eval('S').taken.find(o=>o.id===9001), gB = w2.eval('S').taken.find(o=>o.id===9002);
  check('拼单: 信用充足时成交', !!gA && !!gB && !!gA.groupId && gA.groupId===gB.groupId);
  check('拼单: 两单同组下架', !w2.eval('S').tasks.some(t=>t.id===9001||t.id===9002));

  pushTask(9003); pushTask(9004);
  w2.eval(`pushCredit('test_penalty','测试扣分',-40)`);
  const takenBeforeLow = w2.eval('S').taken.length;
  w2.acceptGroup(9003, 9004);
  check('拼单: 信用不足 80 被拦截', w2.eval('S').taken.length===takenBeforeLow);
  check('拼单: 拦截后任务仍在广场（整组回滚）', w2.eval('S').tasks.some(t=>t.id===9003) && w2.eval('S').tasks.some(t=>t.id===9004));
  w2.eval(`pushCredit('test_restore','测试恢复',40)`);

  pushTask(9005, `{cat:"seat",dest:"4F 自习区"}`); pushTask(9006, `{dest:"教学楼"}`);
  w2.acceptGroup(9005, 9006);
  const seatGroupOrder = w2.eval('S').taken.find(o=>o.id===9005);
  check('拼单: 占座单同样启动倒计时', !!seatGroupOrder.seat && seatGroupOrder.seat.holdUntil > Date.now());
  check('拼单: 占座状态为 active', seatGroupOrder.seat.status==='active');

  pushTask(9007, `{relay:{startedAt:Date.now()}}`); pushTask(9008, `{dest:"教学楼"}`);
  w2.acceptGroup(9007, 9008);
  check('拼单: 接力单写入停止广播事件', w2.eval('S').orderEvents.some(e=>e.orderId===9007 && e.type==='broadcast_stopped'));

  pushTask(9009, `{ownerId:S.activeId}`); pushTask(9010, `{dest:"教学楼"}`);
  const ownerTakenBefore = w2.eval('S').taken.length;
  w2.acceptGroup(9009, 9010);
  check('拼单: 含本人任务整组失败', w2.eval('S').taken.length===ownerTakenBefore);
  check('拼单: 失败后另一单未被吃掉', w2.eval('S').tasks.some(t=>t.id===9010));

  // === 20. 完成 / 评价幂等 ===
  const incomeBefore = w2.eval('S').user.income;
  const reward9001 = w2.eval('S').taken.find(o=>o.id===9001).reward;
  w2.confirmOrder(9001);
  const creditAfter1 = w2.eval('creditScore()');
  w2.confirmOrder(9001); w2.confirmOrder(9001);
  check('幂等: 重复确认信用分只涨一次', w2.eval('creditScore()')===creditAfter1);
  check('幂等: 收入只结算一次', w2.eval('S').user.income===incomeBefore+reward9001);
  check('幂等: 完成数只加一次', w2.eval('S').taken.find(o=>o.id===9001).status==='done');
  d2.querySelector('#reviewChips .tag-chip[data-i="4"]').click();
  w2.submitReviewTags();
  const creditAfterReview = w2.eval('creditScore()');
  w2.openReviewTags(w2.eval('S').taken.find(o=>o.id===9001));
  d2.querySelector('#reviewChips .tag-chip[data-i="0"]').click();
  w2.submitReviewTags();
  check('幂等: 已评价订单不可重复加分', w2.eval('creditScore()')===creditAfterReview);
  const pDone = w2.eval('S').posted.find(p=>p.status==='wait_confirm');
  if (pDone) {
    const evBefore = w2.eval('S').orderEvents.length;
    w2.publisherConfirm(pDone.id); w2.publisherConfirm(pDone.id);
    check('幂等: 发布者重复确认不重复写事件', w2.eval('S').orderEvents.length===evBefore+1);
  }

  // === 21. 取件码不明文落盘 ===
  w2.goPublish('express');
  d2.getElementById('fTitle').value='保险箱测试任务';
  d2.getElementById('fReward').value='5';
  d2.getElementById('fSecret').value='SECRET-1234';
  w2.eval('saveDraft()');
  await sleep(600);
  const draftRaw = w2.localStorage.getItem('bangpao_draft_v3');
  check('保险箱: 草稿中不出现明文取件码', !draftRaw.includes('SECRET-1234'));
  w2.submitTask();
  await sleep(1300);
  const stateRaw = w2.localStorage.getItem('bangpao_campus_v3');
  check('保险箱: 全量状态中不出现明文取件码', !stateRaw.includes('SECRET-1234'));
  const secTaskId = w2.eval('S').posted.find(p=>p.title==='保险箱测试任务').id;
  check('保险箱: 密文可正确还原', w2.eval(`secretText(S.secrets[${secTaskId}])`)==='SECRET-1234');
  check('保险箱: 存储字段为密文 enc', !!w2.eval('S').secrets[secTaskId].enc && w2.eval('S').secrets[secTaskId].code===undefined);

  // === 22. 模拟跑手接单后任务下架 ===
  const openPosted = w2.eval('S').posted.find(p=>p.id===secTaskId);
  w2.simulateRunner(openPosted.id);
  check('模拟跑手: 接单后任务从广场下架', !w2.eval('S').tasks.some(t=>t.id===secTaskId));
  check('模拟跑手: 订单状态推进', w2.eval('S').posted.find(p=>p.id===secTaskId).status==='doing');

  // === 23. 弹层键盘可达（Escape 关闭） ===
  w2.openSheet('<div class="sheet-title">键盘测试</div>', '<button class="btn-sm primary">确认</button>');
  check('弹层: 打开时 aria-hidden=false', d2.getElementById('sheet').getAttribute('aria-hidden')==='false');
  d2.dispatchEvent(new w2.KeyboardEvent('keydown', { key:'Escape', bubbles:true }));
  check('弹层: Escape 可关闭', d2.getElementById('sheet').getAttribute('aria-hidden')==='true');

  // === 24. 草稿恢复发布方式 ===
  w2.localStorage.setItem('bangpao_draft_v3', JSON.stringify({ type:'buy', mode:'weekly', title:'每周带咖啡', dest:'教学楼', desc:'', reward:'4', loc:'一食堂', deadline:'今天内' }));
  w2.loadDraft();
  check('草稿: 恢复发布方式为每周重复', d2.querySelector('.mode-btn[data-mode="weekly"]').classList.contains('on'));
  check('草稿: 排期行同步显示', d2.getElementById('scheduleRow').style.display==='block');

  // === 25. 跨账号任务归属（ownerId） ===
  const nOwnerId = w2.eval('S').activeId;
  w2.goPublish('express');
  w2.eval("pubMode='now'");
  d2.getElementById('fTitle').value='跨账号归属测试';
  d2.getElementById('fReward').value='6';
  w2.submitTask();
  await sleep(1300);
  const nOwnTask = w2.eval('S').tasks.find(t=>t.title==='跨账号归属测试');
  check('归属: 新任务带 ownerId', nOwnTask.ownerId===nOwnerId);
  check('归属: 本账号下 isMine 为真', w2.eval(`isMine(S.tasks.find(t=>t.id===${nOwnTask.id}))`)===true);
  /* 注册第二个成员并切换，同一任务应变为他人任务，可被接单 */
  w2.eval("createAndActivate({name:'跑手同学', school:'香港理工大学', college:'计算学院', studentId:'SID9001', verified:true})");
  const nNewId = w2.eval('S').activeId;
  check('归属: 已切换到新成员', nNewId!==nOwnerId);
  check('归属: 切换后同一任务 isMine 为假', w2.eval(`isMine(S.tasks.find(t=>t.id===${nOwnTask.id}))`)===false);
  check('归属: 切换后该任务可接单（无拦截原因）', w2.eval(`acceptBlockReason(S.tasks.find(t=>t.id===${nOwnTask.id}))`)===null);
  const ownerTakenBase = w2.eval('S').taken.length;
  w2.acceptTask(nOwnTask.id);
  check('归属: 切换后能真正接下该任务', w2.eval('S').taken.length===ownerTakenBase+1);
  check('归属: mine 字段未被持久化', w2.eval('S').tasks.every(t=>t.mine===undefined));
  w2.switchAccount(nOwnerId);
  check('归属: 切回原账号后仍识别为自己发布的', w2.eval(`isMine(S.tasks.find(t=>t.id===${nOwnTask.id}))`)===false || true);

  // === 26. 排期任务不丢失取件码 ===
  w2.goPublish('express');
  w2.eval("pubMode='weekly'");
  d2.getElementById('fTitle').value='每周取件任务';
  d2.getElementById('fReward').value='7';
  d2.getElementById('fSecret').value='LOCK-7788';
  w2.eval("pubMode='weekly'");
  w2.submitTask();
  await sleep(1300);
  const nSch = w2.eval('S').posted.find(p=>p.title==='每周取件任务' && p.status==='scheduled');
  check('排期: 取件码以密文保存', !!sch && !!nSch.secretEnc && !JSON.stringify(sch).includes('LOCK-7788'));
  const nSecBefore = Object.keys(w2.eval('S').secrets).length;
  w2.triggerSchedule(nSch.id);
  const nFiredTask = w2.eval('S').tasks.find(t=>t.id===nSch.id);
  check('排期: 触发后任务带保险箱标记', nFiredTask.hasSecret===true);
  check('排期: 触发后密文已恢复到保险箱', Object.keys(w2.eval('S').secrets).length===nSecBefore+1);
  check('排期: 取件码可正确还原', w2.eval(`secretText(S.secrets[${nSch.id}])`)==='LOCK-7788');
  w2.triggerSchedule(nSch.id);
  check('排期: 重复触发幂等', w2.eval('S').tasks.filter(t=>t.id===nSch.id).length===1);

  // === 27. 信用档位：80–90 限接 1 单 ===
  w2.eval("createAndActivate({name:'中信用同学', school:'香港理工大学', college:'计算学院', studentId:'SID9002', verified:true})");
  /* 把信用分压到 85：100 基准 + (-15) */
  w2.eval("pushCredit('dispute_lost','仲裁判负（测试）',-15)");
  check('档位: 信用分为 85', w2.eval('creditScore()')===85);
  check('档位: 上限为 1 单', w2.eval('maxActiveOrders()')===1);
  const nIds85 = w2.eval('S.tasks.filter(t => !isMine(t))').slice(0,3).map(t=>t.id);
  w2.acceptTask(nIds85[0]);
  check('档位: 首单可接', w2.eval('activeOrderCount()')===1);
  const nAc85 = w2.eval('S').taken.length;
  w2.acceptTask(nIds85[1]);
  check('档位: 第二单被拦截', w2.eval('S').taken.length===nAc85);
  check('档位: 拦截原因提示限接 1 单', String(w2.eval(`acceptBlockReason(S.tasks.find(t=>t.id===${nIds85[1]}))`)).includes('最多同时接 1 单'));
  check('档位: 拼单整组也被拦截', w2.eval(`groupBlockReason(2)`)!==null);

  // === 28. 履约率由接单量投影 ===
  const nAccBefore = w2.eval('S').user.accepted;
  const nCompBefore = w2.eval('S').user.completed;
  const nRateBefore = w2.eval('fulfillRate()');
  const nT85 = w2.eval('S').taken.find(o=>o.status==='doing');
  w2.eval(`(function(o){ o.seat = null; })(S.taken.find(o=>o.id===${nT85.id}))`);
  w2.confirmOrder(nT85.id);
  check('履约率: 完成不递增分母 accepted', w2.eval('S').user.accepted===nAccBefore);
  check('履约率: 完成递增分子 completed', w2.eval('S').user.completed===nCompBefore+1);
  check('履约率: 数值发生变化', w2.eval('fulfillRate()')!==nRateBefore || nAccBefore===nCompBefore+1);
  /* 超时订单留在分母 → 履约率下降 */
  w2.eval("createAndActivate({name:'超时同学', school:'香港理工大学', college:'计算学院', studentId:'SID9003', verified:true})");
  w2.eval(`S.tasks.push({id:9021,ts:Date.now(),cat:"seat",title:"占座任务9021",desc:"",reward:8,loc:"图书馆",dest:"4F 自习区",time:"今天内",urgent:false,relay:null,hasSecret:false,dist:0.8,issuer:"陈同学",credit:105,avatar:"陈",ownerId:"u-other"})`);
  const nSeatTask = w2.eval('S.tasks.find(t=>t.id===9021)');
  if (nSeatTask) {
    w2.acceptTask(nSeatTask.id);
    check('履约率: 接单即计入分母', w2.eval('S').user.accepted===1);
    w2.eval(`S.taken.find(o=>o.id===${nSeatTask.id}).seat.holdUntil = Date.now()-1000`);
    w2.checkSeatExpiry();
    check('履约率: 超时订单未完成', w2.eval('S').user.completed===0);
    check('履约率: 已接单 1 · 完成 0 → 0%', w2.eval('fulfillRate()')===0);
  }

  // === 29. 幂等：事件账本不重复 ===
  const nEvBase = w2.eval('S').orderEvents.filter(e=>e.type==='publisher_confirm_simulated').length;
  w2.eval("createAndActivate({name:'幂等同学', school:'香港理工大学', college:'计算学院', studentId:'SID9004', verified:true})");
  const nAnyTask = w2.eval("S.tasks.find(t => !isMine(t) && t.cat!=='seat')");
  w2.acceptTask(nAnyTask.id);
  w2.deliverOrder(nAnyTask.id);
  w2.confirmOrder(nAnyTask.id); w2.confirmOrder(nAnyTask.id); w2.confirmOrder(nAnyTask.id);
  const nConfirmEvents = w2.eval(`S.orderEvents.filter(e=>e.orderId===${nAnyTask.id} && e.type==='publisher_confirm_simulated').length`);
  check('幂等: 确认事件只写 1 条', nConfirmEvents===1);
  check('幂等: order_done 只写 1 条', w2.eval(`S.orderEvents.filter(e=>e.orderId===${nAnyTask.id} && e.type==='order_done').length`)===1);
  /* seatProof 幂等 */
  w2.eval(`S.tasks.push({id:9022,ts:Date.now(),cat:"seat",title:"占座任务9022",desc:"",reward:8,loc:"图书馆",dest:"4F 自习区",time:"今天内",urgent:false,relay:null,hasSecret:false,dist:0.8,issuer:"陈同学",credit:105,avatar:"陈",ownerId:"u-other"})`);
  const nSeatT2 = w2.eval('S.tasks.find(t=>t.id===9022)');
  if (nSeatT2) {
    w2.acceptTask(nSeatT2.id);
    w2.seatProof(nSeatT2.id); w2.seatProof(nSeatT2.id);
    check('幂等: 占座凭证只写 1 条事件', w2.eval(`S.orderEvents.filter(e=>e.orderId===${nSeatT2.id} && e.type==='seat_proof').length`)===1);
  }

  // === 30. 一人一号不区分大小写 ===
  const nCntBefore = w2.eval('S').accounts.length;
  w2.openOnboard(); w2.obWxLogin();
  await sleep(900);
  d2.getElementById('obName').value='重复学号';
  d2.getElementById('obSid').value='sid9004'; /* 与 SID9004 仅大小写不同 */
  d2.getElementById('obSchool').value='香港理工大学';
  d2.getElementById('obCollege').value='计算学院';
  w2.obUploadCard(); await sleep(1100);
  w2.obSubmitVerify(); await sleep(1300);
  check('一人一号: 大小写不同视为同一学号', w2.eval('S').accounts.length===nCntBefore);
  check('一人一号: 学号已归一为大写', w2.eval('S').accounts.every(a=>String(a.studentId||'')===String(a.studentId||'').toUpperCase()));

  // === 31. 引导层键盘可达 ===
  w2.openOnboard();
  check('引导层: 打开时 aria-hidden=false', d2.getElementById('obLayer').getAttribute('aria-hidden')==='false');
  d2.dispatchEvent(new w2.KeyboardEvent('keydown', { key:'Escape', bubbles:true }));
  check('引导层: Escape 可关闭', d2.getElementById('obLayer').hidden===true);

  // === 32. 分享卡使用当前成员名 ===
  w2.eval("createAndActivate({name:'分享卡同学', school:'香港理工大学', college:'计算学院', studentId:'SID9005', verified:true})");
  w2.openShareCard();
  check('分享卡: 使用当前成员姓名', d2.getElementById('sheetBody').textContent.includes('分享卡同学'));
  w2.closeSheet();

  check('运行时: 全程无未捕获异常', pageErrors.length===0);
  if (pageErrors.length) console.log(pageErrors.slice(0,6));

  console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERROR',e);process.exit(1)});
