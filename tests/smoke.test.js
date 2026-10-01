/**
 * 帮跑校园 · 核心链路冒烟测试（jsdom，30 条断言）
 * 覆盖：XSS 转义 / 表单校验 / 搜索 / 排序 / 接单→送达→确认→评价→信用变化 / 取消发布 / 刷新持久化 / 自接拦截
 * 运行：npm install jsdom && node tests/smoke.test.js
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');

function newDom() {
  return new JSDOM(html, { runScripts:'dangerously', url:'http://localhost/', pretendToBeVisual:true });
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
function check(name, cond){ if(cond){pass++;console.log('PASS',name)} else {fail++;console.log('FAIL',name)} }

(async()=>{
  // === 用例1: XSS 转义发布 ===
  let dom = newDom();
  let w = dom.window, d = w.document;
  const payload = '<b id="injected-title">粗体标题</b>';
  d.getElementById('fTitle').value = payload;
  d.getElementById('fReward').value = '5';
  w.submitTask();
  await sleep(900);
  check('XSS: 不生成注入 DOM', !d.getElementById('injected-title'));
  check('XSS: 标题按文本转义显示', d.getElementById('taskList').textContent.includes(payload));
  check('发布: 新任务进入广场(7条)', d.querySelectorAll('#taskList .task').length === 7);

  // === 用例2: 表单校验 ===
  d.getElementById('fTitle').value=''; d.getElementById('fReward').value='';
  w.submitTask();
  await sleep(100);
  check('校验: 空标题行内报错', d.getElementById('errTitle').classList.contains('show'));
  check('校验: 空赏金行内报错', d.getElementById('errReward').classList.contains('show'));

  // === 用例3: 搜索 ===
  const si = d.getElementById('searchInput');
  si.value='麻辣烫'; si.dispatchEvent(new w.Event('input',{bubbles:true}));
  check('搜索: 命中 1 条', d.querySelectorAll('#taskList .task').length===1);
  check('搜索: 清除按钮出现', d.getElementById('searchClear').classList.contains('show'));
  si.value='zzz不存在zzz'; si.dispatchEvent(new w.Event('input',{bubbles:true}));
  check('搜索: 空结果提示', d.querySelector('#taskList .empty') && d.querySelector('#taskList .empty').textContent.includes('没有找到'));
  d.getElementById('searchClear').click();
  check('搜索: 清除后恢复 7 条', d.querySelectorAll('#taskList .task').length===7);

  // === 用例4: 排序 ===
  d.querySelector('.sort-btn[data-sort="reward"]').click();
  const rewards = [...d.querySelectorAll('#taskList .t-reward')].map(e=>parseFloat(e.textContent.replace('¥','')));
  check('排序: 赏金降序', rewards.every((v,i,a)=>i===0||a[i-1]>=v));
  d.querySelector('.sort-btn[data-sort="dist"]').click();
  const dists = [...d.querySelectorAll('#taskList .task')].map(t=>{const m=t.textContent.match(/🚶([\d.]+)km/);return m?+m[1]:99});
  check('排序: 距离升序', dists.every((v,i,a)=>i===0||a[i-1]<=v));
  d.querySelector('.sort-btn[data-sort="latest"]').click();
  check('排序: 最新发布第一条是刚发布的 XSS 标题', d.querySelector('#taskList .task').textContent.includes(payload));
  d.querySelector('.sort-btn[data-sort="rec"]').click();

  // === 用例5: 接单→送达→确认→评价→信用变化 ===
  const creditBefore = w.eval("S").user.credit;
  const firstTask = [...d.querySelectorAll('#taskList .task')].find(t=>!t.textContent.includes(payload)); // 非自己发的
  const onclick = firstTask.getAttribute('onclick');
  const tid = +onclick.match(/\d+/)[0];
  w.openTask(tid);
  w.acceptTask(tid);
  await sleep(1100);
  check('接单: 进入我接的单', w.eval("S").taken.length===1 && w.eval("S").taken[0].status==='doing');
  w.deliverOrder(tid);
  check('送达: 状态变待确认', w.eval("S").taken[0].status==='pending');
  w.confirmOrder(tid);
  check('确认: 状态变已完成', w.eval("S").taken[0].status==='done');
  check('确认: 信用 +2', w.eval("S").user.credit === creditBefore+2);
  // 评价 5 星
  d.querySelector('#starRow button[data-star="5"]').click();
  d.getElementById('rateSubmit').click();
  check('评价: 5星再 +1 信用', w.eval("S").user.credit === creditBefore+3);
  check('评价: 信用明细新增记录', w.eval("S").user.creditLog.length>=4);
  check('统计: 已完成接单 24', d.getElementById('statCompleted').textContent==='24');
  check('统计: 收入增加', w.eval("S").user.income > 156);

  // === 用例6: 取消发布 ===
  const posted = w.eval("S").posted.find(p=>p.id===101);
  w.askCancelPosted(posted.id);
  w.doCancelPosted(posted.id);
  check('取消: 状态变已取消', w.eval("S").posted.find(p=>p.id===posted.id).status==='cancelled');
  check('取消: 广场任务减少', w.eval("S").tasks.every(t=>t.id!==posted.id));

  // === 用例7: 持久化（刷新恢复） ===
  const storage = w.localStorage;
  const savedRaw = storage.getItem('bangpao_campus_v2');
  check('持久化: localStorage 已写入', !!savedRaw);
  const saved = JSON.parse(savedRaw);
  check('持久化: 任务数已保存(6)', saved.tasks.length===6);
  check('持久化: 信用分已保存', saved.user.credit===creditBefore+3);
  check('持久化: 已完成订单已保存', saved.taken[0].status==='done');
  dom.window.close();
  // 重新加载同 storage
  const dom2 = new JSDOM(html, { runScripts:'dangerously', url:'http://localhost/', pretendToBeVisual:true, beforeParse(win){ win.localStorage.setItem('bangpao_campus_v2', savedRaw); } });
  // jsdom 每次新 localStorage，beforeParse 预写
  await sleep(100);
  const w2 = dom2.window;
  check('刷新: 信用分恢复', w2.eval("S").user.credit===creditBefore+3);
  check('刷新: 已完成订单恢复', w2.eval("S").taken.length===1 && w2.eval("S").taken[0].status==='done');
  check('刷新: 广场 6 条', w2.document.querySelectorAll('#taskList .task').length===6);

  // === 用例8: 不能接自己的单 ===
  const myTask = w2.eval("S").tasks.find(t=>t.mine);
  w2.openTask(myTask.id);
  check('自接拦截: 按钮禁用', w2.document.querySelector('#sheetActions .primary').disabled===true);

  console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERROR',e);process.exit(1)});
