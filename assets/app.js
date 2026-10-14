/* =====================================================================
 * 帮跑校园 · 事件驱动原型
 * 统一底层：OrderEvent / CreditEvent 账本
 *   - 信用分 = 100 + Σ(CreditEvent.delta)
 *   - 统计（履约率/收入/足迹）从订单与事件聚合，不手工改数字
 * 订单状态机：OPEN → ACCEPTED → PICKING → DELIVERING → WAIT_CONFIRM → DONE
 * 异常态：CANCELLED / EXPIRED / DISPUTED
 * ===================================================================== */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
function esc(str) {
  return String(str ?? '').replace(/[&<>"'`]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;'}[c]));
}
const CAT_NAME = { express:'📦 代取快递', buy:'🛒 代买代送', seat:'📚 代占座', other:'✨ 其他' };
const AVATAR_COLORS = ['#3b82f6','#8b5cf6','#f59e0b','#ef4444','#10b981','#ec4899'];

/* ---- POI 图（校园分区 + 相对坐标，用于顺路拼单、距离排序与足迹）---- */
const POI_ZONE = { '菜鸟驿站':'快递区','顺丰点':'快递区','一食堂':'餐饮区','二食堂':'餐饮区','图书馆':'学习区','教学楼':'学习区','校门口':'校门','紫荆公寓':'宿舍区' };
/* 校园平面简化坐标（单位：百米），仅用于估算步行距离，不涉及真实定位 */
const POI_XY = { '校门口':[0,0], '菜鸟驿站':[1,2], '顺丰点':[2,2], '一食堂':[3,4], '二食堂':[4,4],
                 '教学楼':[7,5], '图书馆':[9,6], '紫荆公寓':[6,9] };
function zoneOf(text){ for (const p in POI_ZONE) if (String(text||'').includes(p)) return POI_ZONE[p]; return '其他'; }
/* 取送点→步行距离（km）：命中 POI 表则按坐标算直线距离，否则回落随机估算 */
function distOf(loc, dest){
  const a = poiOf(loc), b = poiOf(dest);
  if (a && b) return Math.round(Math.hypot(a[0]-b[0], a[1]-b[1]) * 0.1 * 10) / 10;
  return Math.round((0.2 + Math.random()*1.3)*10)/10;
}
function poiOf(text){
  for (const p in POI_XY) if (String(text||'').includes(p)) return POI_XY[p];
  return null;
}

/* ================= 状态 & 持久化 ================= */
const STORE_KEY = 'bangpao_campus_v3';
const DRAFT_KEY = 'bangpao_draft_v3';

/* 成员字段：一份「账号」= 下面这组字段；切换成员 = 整组替换 */
const PROFILE_FIELDS = ['name','school','college','avatar','studentId','sidHash','verified','verifiedAt','creditEvents','user','badges','routes','taken','posted'];
function pickProfile(p) {
  const o = {};
  PROFILE_FIELDS.forEach(k => { if (p && p[k] !== undefined) o[k] = JSON.parse(JSON.stringify(p[k])); });
  return o;
}
function seedDemoProfile(now) {
  return {
    name:'杨同学', school:'香港理工大学', college:'计算学院', avatar:'🎓',
    studentId:'2026****88', sidHash:'h-demo', verified:true, verifiedAt: now-30*864e5,
    creditEvents: [ /* CreditEvent 账本：信用分由事件聚合 */
      { t:now-6*864e5, type:'order_completed', title:'完成订单「代取快递」', delta:2 },
      { t:now-5*864e5, type:'order_completed', title:'完成订单「代买早餐」', delta:2 },
      { t:now-4*864e5, type:'on_time_completed', title:'准时履约', delta:1 },
      { t:now-3*864e5, type:'order_completed', title:'完成订单「图书馆占座」', delta:2 },
      { t:now-2*864e5, type:'positive_review', title:'收到「沟通顺畅」评价', delta:1 },
    ],
    /* accepted：接单事务中递增（履约率分母）；completed / income 由订单事件投影累加 */
    user: { completed:23, accepted:23, income:156, balance:32.5, monthCompleted:12, onTimeSeed:0.96 },
    badges: ['🌧️ 雨天互助者', '🌱 新手跑手'],
    routes: [{ from:'图书馆', to:'紫荆 5 号楼', n:5, label:'图书馆 → 紫荆 5 号楼' }],
    taken: [],   /* status: doing | delivering | wait_confirm | done | expired */
    posted: [ { id:101, ts:now-10*60e3, title:'代取中通快递到 5 号楼', cat:'express', reward:4, status:'open', loc:'菜鸟驿站', dest:'紫荆公寓 5 号楼' } ]
  };
}

function seedState() {
  const now = Date.now();
  const demo = seedDemoProfile(now);
  const s = {
    seq: 1000,
    orderEvents: [], /* OrderEvent 账本 */
    tasks: [
      { id:1, ts:now-8*60e3, cat:'express', title:'菜鸟驿站取 2 个包裹送到紫荆 3 号楼', desc:'两个小件，一个鞋盒大小一个文件袋。下午没课随时可送。', reward:5, loc:'菜鸟驿站', dest:'紫荆公寓 3 号楼', time:'今天内', urgent:false, relay:null, hasSecret:true, dist:0.4, issuer:'林同学', credit:112, avatar:'林', ownerId:'u-lin' },
      { id:2, ts:now-25*60e3, cat:'buy', title:'一食堂带份麻辣烫，送到图书馆北门', desc:'微辣，加宽粉和鱼丸。预算 25 以内，跑腿费另算。在复习期末，救命！', reward:6, loc:'一食堂', dest:'图书馆北门', time:'1 小时内', urgent:true, relay:null, hasSecret:false, dist:0.6, issuer:'王同学', credit:98, avatar:'王', ownerId:'u-wang' },
      { id:3, ts:now-45*60e3, cat:'seat', title:'明早 8 点图书馆 4 楼靠窗占座', desc:'考研党，需要靠窗有插座的位置。（平台规则：占位保留上限 40 分钟，超时自动释放）', reward:8, loc:'图书馆', dest:'4F 自习区', time:'明天中午前', urgent:false, relay:null, hasSecret:false, dist:0.8, issuer:'陈同学', credit:105, avatar:'陈', ownerId:'u-chen' },
      { id:4, ts:now-5*60e3, cat:'express', title:'顺丰取件，文件急用！', desc:'一份实习证明材料，顺丰柜取件，需要 1 小时内送到教学楼 A305。', reward:10, loc:'顺丰点', dest:'教学楼 A305', time:'1 小时内', urgent:true, relay:{ startedAt:now-5*60e3 }, hasSecret:true, dist:1.2, issuer:'赵同学', credit:95, avatar:'赵', ownerId:'u-zhao' },
      { id:5, ts:now-70*60e3, cat:'other', title:'帮搬宿舍行李下楼（两件）', desc:'周末搬宿舍，两个行李箱从 5 楼搬到楼下，有电梯但电梯口到楼下有一段台阶。', reward:15, loc:'紫荆公寓', dest:'楼下', time:'今天内', urgent:false, relay:null, hasSecret:false, dist:0.3, issuer:'周同学', credit:121, avatar:'周', ownerId:'u-zhou' },
      { id:6, ts:now-100*60e3, cat:'buy', title:'校门口奶茶店带两杯杨枝甘露', desc:'都要正常冰三分糖，到店自取报手机尾号即可，钱我转你。', reward:4, loc:'校门口', dest:'紫荆公寓 5 号楼', time:'今天内', urgent:false, relay:null, hasSecret:false, dist:1.5, issuer:'吴同学', credit:88, avatar:'吴', ownerId:'u-wu' },
    ],
    secrets: { /* SecurePayload：只存密文 enc，明文永不落盘 */
      1: { enc: obf('6-2-3018'), access:0, logs:[] },
      4: { enc: obf('SF-8890'), access:0, logs:[] },
    },
    groups: [],  /* OrderGroup：顺路拼单组 */
    ui: { cat:'all', sort:'rec', orderTab:'taken', noticeClosed:false },
    onboarded: false,        /* 是否已走过注册/认证引导 */
    activeId: 'u-demo',      /* 当前登录成员 */
    accounts: [ Object.assign({ id:'u-demo' }, pickProfile(demo)) ]
  };
  return Object.assign(s, pickProfile(demo));
}

let S;
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    S = raw ? JSON.parse(raw) : seedState();
    if (!S || !S.tasks || !S.creditEvents) S = seedState();
  } catch(e) { S = seedState(); }
  migrate();
}
/* 老版本数据（无 accounts 字段）迁移：把当前状态包成第一位成员 */
function migrate() {
  if (!Array.isArray(S.accounts) || !S.accounts.length) {
    const legacy = Object.assign({ name:'杨同学', school:'香港理工大学', college:'计算学院', avatar:'🎓', studentId:'2026****88', sidHash:'h-demo', verified:true, verifiedAt:Date.now() }, pickProfile(S));
    S.activeId = 'u-demo';
    S.accounts = [ Object.assign({ id:'u-demo' }, pickProfile(legacy)) ];
  }
  if (typeof S.onboarded !== 'boolean') S.onboarded = true; /* 老用户不打断 */
  if (!S.accounts.some(a=>a.id===S.activeId)) S.activeId = S.accounts[0].id;
  /* 老版本取件码为明文存储，迁移为密文 */
  Object.keys(S.secrets || {}).forEach(k => {
    const s = S.secrets[k];
    if (s && typeof s.code === 'string' && !s.enc) { s.enc = obf(s.code); delete s.code; }
  });
  /* 任务归属：mine 是会话派生字段，一律改为按 ownerId 动态判断 */
  (S.tasks || []).forEach(t => {
    if (!t.ownerId) t.ownerId = t.mine ? S.activeId : ('u-other-' + t.id);
    delete t.mine;
  });
  /* 学号脱敏：持久化只保留掩码 + 哈希，一人一号用哈希比对 */
  [S].concat(S.accounts || []).forEach(p => {
    if (!p || typeof p.studentId !== 'string' || !p.studentId) return;
    if (p.studentId.includes('*')) { if (!p.sidHash) p.sidHash = 'h-legacy'; return; }
    if (!p.sidHash) p.sidHash = sidHash(p.studentId.toUpperCase());
    p.studentId = maskSid(p.studentId.toUpperCase());
  });
  /* 履约率分母：老版本 totalTaken 与 completed 同步递增，口径错误，迁移为接单量 */
  [S].concat(S.accounts || []).forEach(p => {
    if (!p || !p.user) return;
    if (typeof p.user.accepted !== 'number') {
      p.user.accepted = Math.max(p.user.totalTaken || 0, p.user.completed || 0);
    }
    delete p.user.totalTaken;
  });
}
/* B4：localStorage 写入失败（隐私模式 / 配额 5MB 用尽）不再静默，提示一次 */
let saveWarned = false;
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
  catch(e) {
    if (!saveWarned) {
      saveWarned = true;
      if (typeof toast === 'function') toast('⚠️','本地存储不可用，本次操作在刷新后不会保留');
      else console.warn('[帮跑校园] localStorage 写入失败：', e && e.message);
    }
  }
}
load();

/* ================= 事件账本 ================= */
/* 任务归属：mine 永不持久化，始终由 ownerId 与当前成员派生 */
function isMine(t){ return !!(t && t.ownerId && t.ownerId === S.activeId); }
/* 学号为个人信息：本地只存脱敏形式，一人一号用不可逆哈希比对（生产为服务端校验） */
function normSid(v){ return String(v || '').replace(/\s+/g, '').toUpperCase(); }
function sidHash(k){
  let h = 5381;
  for (let i = 0; i < k.length; i++) h = (((h << 5) + h) + k.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(36);
}
function maskSid(k){
  if (!k) return '';
  if (k.length <= 4) return k.slice(0,1) + '****';
  return k.slice(0,4) + '****' + k.slice(-2);
}
function creditScore(){ return Math.min(120, 100 + S.creditEvents.reduce((s,e)=>s+e.delta,0)); }
/* 信用档位：可同时进行的订单上限（doing/delivering/wait_confirm 均占用额度） */
const ACTIVE_STATUS = ['doing','delivering','wait_confirm'];
function activeOrderCount(){ return (S.taken || []).filter(o => ACTIVE_STATUS.includes(o.status)).length; }
function maxActiveOrders(){ const c = creditScore(); return c < 80 ? 0 : (c < 90 ? 1 : Infinity); }
/* 履约率：分母为接单量（含已超时/已取消），分子为成功完成量，均由订单事件投影 */
function fulfillRate(){
  const u = S.user || {};
  return u.accepted ? Math.round(u.completed / u.accepted * 100) : 100;
}
function pushCredit(type, title, delta){ S.creditEvents.unshift({ t:Date.now(), type, title, delta }); }
function pushOrderEvent(orderId, type, note){ S.orderEvents.push({ t:Date.now(), orderId, type, note:note||'' }); }

/* ================= 渲染：任务广场 ================= */
const SORTS = {
  rec:    (a,b) => ((b.urgent||b.relay?1:0)-(a.urgent||a.relay?1:0)) || (b.ts - a.ts),
  reward: (a,b) => b.reward - a.reward,
  latest: (a,b) => b.ts - a.ts,
  dist:   (a,b) => a.dist - b.dist,
};

function renderTasks() {
  const list = $('#taskList');
  let data = S.tasks.filter(t => S.ui.cat==='all' || t.cat===S.ui.cat);
  const kw = $('#searchInput').value.trim().toLowerCase();
  if (kw) data = data.filter(t => [t.title, t.desc, t.loc, t.dest].some(f => String(f).toLowerCase().includes(kw)));
  data = [...data].sort(SORTS[S.ui.sort] || SORTS.rec);
  if (!data.length) {
    list.innerHTML = `<div class="empty">${kw ? `没有找到与「${esc(kw)}」相关的任务<br>换个关键词试试？` : '这个分类暂时没有任务<br>发布一个试试？'}</div>`;
    return;
  }
  list.innerHTML = data.map(t=>`
    <button class="task" onclick="openTask(${t.id})" aria-label="任务：${esc(t.title)}，赏金 ${t.reward} 元">
      <div class="row1">
        <div class="t-title">${esc(t.title)}</div>
        <div class="t-reward"><small>¥</small>${esc(t.reward)}</div>
      </div>
      <div class="t-desc">${esc(t.desc)}</div>
      <div class="row3">
        <span class="tag ${t.cat}">${CAT_NAME[t.cat]}</span>
        ${t.relay ? '<span class="tag relay">📢 接力中</span>' : (t.urgent ? '<span class="tag urgent">🔥 加急</span>' : '')}
        ${t.hasSecret ? '<span class="tag secure">🔐 取件码托管</span>' : ''}
        <span>📍${esc(t.loc)} → ${esc(t.dest)}</span>
        <span>🚶${t.dist}km</span>
        <span class="issuer">
          <span class="avatar" style="background:${AVATAR_COLORS[t.id % 6]}">${esc(t.avatar)}</span>
          <span class="credit-mini">信用 ${esc(t.credit)}</span>
        </span>
      </div>
    </button>`).join('');
}

/* ================= 渲染：订单 ================= */
const FLOW_STEPS = ['已接单','配送中','待确认','已完成'];
function flowIdx(status){ return { doing:0, delivering:1, wait_confirm:2, done:3 }[status] ?? 0; }
function flowSteps(status){
  const cur = flowIdx(status);
  return `<div class="o-flow">${FLOW_STEPS.map((s,i)=>`<span class="step ${i<cur?'past':i===cur?'cur':''}">${s}</span>${i<3?'<span>›</span>':''}`).join('')}</div>`;
}
const SEAT_HOLD_MS = 40*60*1000; /* 平台规则：占位保留上限 40 分钟 */
const SEAT_EXT_MS = 10*60*1000;

function seatBox(o){
  if (o.cat!=='seat' || !o.seat) return '';
  if (o.seat.status==='confirmed') return `<div class="seat-box"><div class="seat-info">✅ 发布者已到达，占座完成</div></div>`;
  if (o.seat.status==='expired') return `<div class="seat-box"><div class="seat-info">⏰ 座位已超时自动释放，已写入订单事件</div></div>`;
  const remain = Math.max(0, o.seat.holdUntil - Date.now());
  const mm = String(Math.floor(remain/60000)).padStart(2,'0'), ss = String(Math.floor(remain%60000/1000)).padStart(2,'0');
  const frac = remain / SEAT_HOLD_MS;
  const off = (163.4*(1-frac)).toFixed(1);
  return `<div class="seat-box" data-seat-box="${o.id}">
    <div class="seat-ring">
      <svg width="64" height="64"><circle cx="32" cy="32" r="26" fill="none" stroke="#e6dcfb" stroke-width="6"/><circle data-seat-ring="${o.id}" cx="32" cy="32" r="26" fill="none" stroke="#7c4ddb" stroke-width="6" stroke-linecap="round" stroke-dasharray="163.4" stroke-dashoffset="${off}"/></svg>
      <div class="seat-cd" data-seat-cd="${o.id}">${mm}:${ss}</div>
    </div>
    <div class="seat-info">
      座位 <b>${esc(o.seat.seatCode||'4F-A12')}</b> 保留中，发布者未到将自动释放<br>
      <div class="seat-actions">
        <button class="btn-sm primary" onclick="confirmArrive(${o.id})">我已到达（发布者视角）</button>
        ${o.seat.ext<1 ? `<button class="btn-sm warn" onclick="extendSeat(${o.id})">延长 10 分钟</button>` : ''}
      </div>
    </div>
  </div>`;
}

const RELAY_WAVES = [ {scope:'同楼栋',count:8,dur:45}, {scope:'相邻楼栋',count:21,dur:45}, {scope:'全校',count:136,dur:60} ]; /* 演示加速：45s/波 */
function relayWaveState(o){
  const elapsed = (Date.now() - o.relay.startedAt)/1000;
  let acc = 0, cur = RELAY_WAVES.length-1, remainInWave = 0;
  for (let i=0;i<RELAY_WAVES.length;i++){ if (elapsed < acc + RELAY_WAVES[i].dur) { cur=i; remainInWave = acc + RELAY_WAVES[i].dur - elapsed; break; } acc += RELAY_WAVES[i].dur; }
  const total = RELAY_WAVES.reduce((s,w)=>s+w.dur,0);
  return { cur, remainInWave, doneAll: elapsed >= total };
}
function relayWaveHtml(o){
  const s = relayWaveState(o);
  const mm = String(Math.floor(s.remainInWave/60)), ss = String(Math.floor(s.remainInWave%60)).padStart(2,'0');
  return `📢 ${s.doneAll ? '全校广播中，等待跑手接单…' : `第 ${s.cur+1} 波：已通知<b>${RELAY_WAVES[s.cur].scope} ${RELAY_WAVES[s.cur].count} 位跑手</b>，<span class="wave-cd" data-relay-cd="${o.id}">${mm}:${ss}</span> 后扩大范围`}`;
}
function relayBox(o){
  const t = S.tasks.find(x=>x.id===o.id) || o;
  if (!o.relay) return '';
  const cur = relayWaveState(o).cur;
  return `<div class="relay-box" data-relay-box="${o.id}">
    <div class="wave-line" data-relay-line="${o.id}">${relayWaveHtml(o)}</div>
    <div class="relay-waves">${RELAY_WAVES.map((w,i)=>`<span class="w ${i<cur?'past':i===cur?'cur':''}">${w.scope}</span>`).join('')}</div>
  </div>`;
}

function renderOrders() {
  const list = $('#orderList');
  const isTaken = S.ui.orderTab==='taken';
  const data = isTaken ? S.taken : S.posted;
  if (!data.length) {
    list.innerHTML = `<div class="empty">${isTaken ? '还没有接单，去任务广场看看？' : '还没有发布过任务'}</div>`;
    return;
  }
  const STATUS = { doing:['已接单','doing'], delivering:['配送中','delivering'], wait_confirm:['待确认','wait_confirm'], done:['已完成','done'], open:['待接单','open'], cancelled:['已取消','cancelled'], expired:['已超时','expired'], scheduled:['已排期','scheduled'] };
  list.innerHTML = data.map(o=>{
    const [sTxt, sCls] = STATUS[o.status] || ['未知','open'];
    const grp = o.groupId ? `<span class="group-badge">🔗 顺路拼单组</span>` : '';
    let btns = '', extra = '', flow = '';
    if (isTaken) {
      if (['doing','delivering','wait_confirm','done'].includes(o.status)) flow = flowSteps(o.status);
      if (o.status==='doing') {
        if (o.cat==='seat') btns = `<button class="btn-sm primary" onclick="seatProof(${o.id})">📷 上传占座凭证</button>`;
        else btns = `<button class="btn-sm primary" onclick="startDeliver(${o.id})">🛍️ 已取件/采购，出发配送</button>`;
      } else if (o.status==='delivering') {
        btns = `<button class="btn-sm primary" onclick="deliverOrder(${o.id})">📷 上传凭证并送达</button>`;
      } else if (o.status==='wait_confirm') {
        btns = `<button class="btn-sm primary" onclick="confirmOrder(${o.id})">（演示）代发布者确认</button>`;
        extra += `<div class="o-note">线上由发布者端确认后结算；单机演示无对端账号，此按钮代为推进并已在事件账本标注「模拟确认」。</div>`;
      }
      if (o.secretTaskId && ['doing','delivering'].includes(o.status)) {
        const sec = S.secrets[o.secretTaskId];
        if (sec) extra += `<div class="secure-box">🔐 取件码已托管 · 演示级混淆（已查看 ${sec.access} 次）<button class="btn-sm ghost" style="margin-left:auto" onclick="viewSecret(${o.id})">查看 30 秒</button></div>`;
      }
      if (o.seat) extra += seatBox(o);
    } else {
      if (o.status==='open') {
        btns = `<button class="btn-sm warn" onclick="simulateRunner(${o.id})">（演示）模拟跑手接单</button><button class="btn-sm ghost" onclick="askCancelPosted(${o.id})">取消发布</button>`;
        if (o.relay) extra += relayBox(o);
      } else if (o.status==='doing' || o.status==='delivering') {
        flow = flowSteps(o.status);
        btns = `<button class="btn-sm primary" onclick="simulateRunnerDeliver(${o.id})">（演示）模拟跑手送达</button>`;
      } else if (o.status==='wait_confirm') {
        flow = flowSteps(o.status);
        btns = `<button class="btn-sm primary" onclick="publisherConfirm(${o.id})">确认完成并结算</button>`;
      } else if (o.status==='done') {
        flow = flowSteps(o.status);
        btns = `<span style="font-size:11.5px;color:var(--green)">赏金已结算</span>`;
      } else if (o.status==='cancelled') {
        btns = `<span style="font-size:11.5px;color:var(--text-3)">赏金已原路退回</span>`;
      } else if (o.status==='scheduled') {
        btns = `<button class="btn-sm primary" onclick="triggerSchedule(${o.id})">（演示）立即生成任务</button><button class="btn-sm ghost" onclick="toggleSchedule(${o.id})">${o.paused?'恢复':'暂停'}</button>`;
      }
    }
    const meta = o.status==='wait_confirm' ? (isTaken ? '凭证已上传（模拟）· 等待发布者确认' : '跑手已送达 · 请确认后结算赏金')
      : o.status==='scheduled' ? `⏰ ${esc(o.scheduleLabel||'')} · ${o.paused?'已暂停':'生效中'}`
      : (o.timeAgo || '');
    return `<div class="order">
      <div class="o-head"><span>${CAT_NAME[o.cat]}${grp}</span><span class="o-status ${sCls}">${sTxt}</span></div>
      <div class="o-title">${esc(o.title)}</div>
      <div class="o-meta">${esc(meta)}</div>
      ${flow}${extra}
      <div class="o-foot"><span class="o-reward">¥${esc(o.reward)}</span><span style="display:flex;gap:8px">${btns}</span></div>
    </div>`;
  }).join('');
}

/* ================= 渲染：我的 ================= */
function renderMe() {
  /* 当前成员信息 */
  $('#meAvatar').textContent = S.avatar || '👤';
  $('#meName').textContent = S.name || '未命名同学';
  $('#meSchool').textContent = [S.school, S.college].filter(Boolean).join(' · ') || '未填写学校';
  const vb = $('#meVerify');
  vb.textContent = S.verified ? '✓ 学籍已认证（模拟）' : '⚠ 未认证 · 点此认证';
  vb.classList.toggle('warn', !S.verified);
  vb.disabled = !!S.verified;
  vb.onclick = () => openOnboard();
  $('#accCount').textContent = (S.accounts ? S.accounts.length : 1) + ' 位成员';
  const credit = creditScore();
  $('#creditNum').textContent = credit;
  $('#creditRing').style.strokeDashoffset = (232.5 * (1 - credit/120)).toFixed(1);
  const lvl = credit < 80 ? '失信 · 禁止接单' : credit < 90 ? '受限 · 限接 1 单' : credit < 110 ? (credit >= 105 ? '优秀' : '良好') : '金牌跑手 🏅';
  $('#creditLvl').textContent = lvl;
  const u = S.user;
  $('#statCompleted').textContent = u.completed;
  $('#statRate').textContent = fulfillRate() + '%';
  $('#statIncome').textContent = '¥' + u.income;
  const limit = maxActiveOrders();
  $('#statQuota').textContent = limit === Infinity ? '不限' : (limit + ' 单');
  $('#balanceTxt').textContent = '余额 ¥' + (Math.round(u.balance*10)/10);
  /* 信用护照：从事件与订单聚合 */
  const doneThisMonth = u.monthCompleted + S.taken.filter(o=>o.status==='done').length;
  $('#ppMonth').textContent = doneThisMonth + ' 单';
  const onTimeEvents = S.creditEvents.filter(e=>e.type==='on_time_completed').length;
  const doneEvents = Math.max(1, S.creditEvents.filter(e=>e.type==='order_completed').length);
  const onTime = Math.min(100, Math.round(u.onTimeSeed*100 * 0.7 + (onTimeEvents/doneEvents*100) * 0.3));
  $('#ppOnTime').textContent = onTime + '%';
  const best = [...S.routes].sort((a,b)=>b.n-a.n)[0];
  $('#ppRoute').textContent = best ? best.label : '暂无足迹';
  /* 徽章：事件解锁 */
  const badges = [...S.badges];
  if (u.completed >= 25 && !badges.includes('🤝 靠谱搭档')) badges.push('🤝 靠谱搭档');
  if (credit >= 110 && !badges.includes('🏅 金牌跑手')) badges.push('🏅 金牌跑手');
  const locked = ['⚡ 闪电手（30 分钟 5 单）','🌙 深夜守护者'];
  $('#badgesRow').innerHTML = badges.map(b=>`<span class="badge">${esc(b)}</span>`).join('') + locked.map(b=>`<span class="badge locked">🔒 ${esc(b)}</span>`).join('');
}

/* ================= 导航 ================= */
/* 订单 tab 红点：非订单页发生的状态变更不弹 toast，改为红点提示 */
function renderTabBadge(){
  const dot = $('#ordersBadge');
  if (!dot) return;
  const active = $('#page-orders').classList.contains('active');
  dot.hidden = active || !S.ui.ordersUnread;
}
function switchTab(name) {
  $$('.tab[data-page]').forEach(t=>t.classList.toggle('on', t.dataset.page===name));
  $$('.page').forEach(p=>p.classList.toggle('active', p.id==='page-'+name));
  $('#navTitle').textContent = { home:'帮跑校园', publish:'发布任务', orders:'我的订单', me:'个人中心' }[name] || '帮跑校园';
  $('#prdLink').classList.toggle('show', name==='home');
  if (name==='orders') { S.ui.ordersUnread = false; save(); renderOrders(); }
  if (name==='me') renderMe();
  renderTabBadge();
  $('#pages').scrollTop = 0;
}
$$('.tab[data-page]').forEach(t=>t.addEventListener('click', ()=>switchTab(t.dataset.page)));

$('#catBar').addEventListener('click', e=>{
  const el = e.target.closest('.cat'); if (!el) return;
  S.ui.cat = el.dataset.cat; save();
  $$('.cat').forEach(c=>{ const on = c===el; c.classList.toggle('on', on); c.setAttribute('aria-selected', on); });
  renderTasks();
});
$$('.sort-btn').forEach(b=>b.addEventListener('click', ()=>{
  S.ui.sort = b.dataset.sort; save();
  $$('.sort-btn').forEach(x=>x.classList.toggle('on', x===b));
  renderTasks();
}));
$('#searchInput').addEventListener('input', ()=>{
  $('#searchClear').classList.toggle('show', !!$('#searchInput').value);
  renderTasks();
});
$('#searchClear').addEventListener('click', ()=>{
  $('#searchInput').value=''; $('#searchClear').classList.remove('show'); renderTasks(); $('#searchInput').focus();
});
$$('.order-tab').forEach(t=>t.addEventListener('click', ()=>{
  S.ui.orderTab = t.dataset.tab; save();
  $$('.order-tab').forEach(x=>{ const on = x===t; x.classList.toggle('on', on); x.setAttribute('aria-selected', on); });
  renderOrders();
}));

/* ================= 动态赏金建议 ================= */
const PRICE_BASE = { express:3, buy:5, seat:8, other:6 };
function suggestPrice() {
  const loc = ($('.loc-chip.on')||{}).textContent || '菜鸟驿站';
  const dest = $('#fDest').value.trim() || '宿舍区';
  const zoneA = zoneOf(loc), zoneB = zoneOf(dest);
  const hour = new Date().getHours();
  const peak = (hour>=11&&hour<=13)||(hour>=17&&hour<=19) ? 1 : 0;
  const distCoef = zoneA===zoneB ? 0 : 1;
  /* 模拟供需聚合（生产：7 天订单聚合 + Redis 缓存） */
  const hash = (zoneA+zoneB).split('').reduce((s,c)=>s+c.charCodeAt(0),0);
  const tasks = 8 + hash % 14, runners = 3 + hash % 6;
  const demandCoef = tasks > runners*2 ? 1 : 0;
  const mid = (PRICE_BASE[pubType]||5) + peak + distCoef + demandCoef;
  return { low: mid-1, high: mid+1, mid, tasks, runners, zoneA, zoneB };
}
function refreshPriceTip() {
  const tip = $('#priceTip');
  if (pubMode!=='now') { tip.classList.remove('show'); return; }
  const s = suggestPrice();
  const v = parseFloat($('#fReward').value);
  let verdict = '', vcls = '';
  if (v > 0) {
    if (v < s.low) { verdict = '偏低 · 可能无人接单'; vcls = 'low'; }
    else if (v <= s.high) { verdict = '合理'; vcls = 'fair'; }
    else { verdict = '偏高 · 性价比可优化'; vcls = 'high'; }
  }
  tip.innerHTML = `💡 <b>动态赏金建议：</b>近 30 分钟「${s.zoneA} → ${s.zoneB}」路线有 ${s.tasks} 个任务、${s.runners} 位跑手，建议 <b>¥${s.low}–${s.high}</b>${verdict ? `<span class="verdict ${vcls}">${verdict}</span>` : ''}`;
  tip.classList.add('show');
}

/* ================= 发布 ================= */
let pubType = 'express';
let pubMode = 'now';
const SCHEDULE_OPTS = { once: ['今晚 20:00','明早 08:00','明天 12:30'], weekly: ['每周一 08:00','每周三 08:00','每周五 18:00'] };

$('#typeGrid').addEventListener('click', e=>{
  const el = e.target.closest('.type-item'); if (!el) return;
  pubType = el.dataset.type;
  $$('.type-item').forEach(x=>{ const on = x===el; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
  refreshPriceTip(); saveDraft();
});
$('#locChips').addEventListener('click', e=>{
  if (!e.target.classList.contains('loc-chip')) return;
  $$('.loc-chip').forEach(x=>{ const on = x===e.target; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
  refreshPriceTip(); saveDraft();
});
$('#modeRow').addEventListener('click', e=>{
  const el = e.target.closest('.mode-btn'); if (!el) return;
  pubMode = el.dataset.mode;
  $$('.mode-btn').forEach(x=>{ const on = x===el; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
  const row = $('#scheduleRow');
  if (pubMode==='now') { row.style.display='none'; }
  else {
    row.style.display='block';
    $('#fSchedule').innerHTML = SCHEDULE_OPTS[pubMode].map(o=>`<option>${o}</option>`).join('');
  }
  refreshPriceTip(); saveDraft();
});
$('#fDeadline').addEventListener('change', ()=>{
  $('#relayCheck').classList.toggle('show', $('#fDeadline').value==='1 小时内' && pubMode==='now');
  saveDraft();
});
$('#fDest').addEventListener('input', refreshPriceTip);
$('#fReward').addEventListener('input', refreshPriceTip);
function setReward(v){ $('#fReward').value = v; refreshPriceTip(); saveDraft(); }
function goPublish(type){
  pubType = type;
  $$('.type-item').forEach(x=>{ const on = x.dataset.type===type; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
  switchTab('publish'); refreshPriceTip();
}

let draftTimer;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(()=>{
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        type: pubType, mode: pubMode,
        title: $('#fTitle').value, dest: $('#fDest').value,
        desc: $('#fDesc').value, reward: $('#fReward').value,
        /* 取件码不入草稿：草稿明文落盘，与「加密托管、仅接单者可见」冲突 */
        loc: ($('.loc-chip.on')||{}).textContent || '菜鸟驿站',
        deadline: $('#fDeadline').value
      }));
      $('#draftTip').hidden = false;
    } catch(e){}
  }, 400);
}
['fTitle','fDest','fDesc','fReward','fSecret'].forEach(id=>$('#'+id).addEventListener('input', saveDraft));
function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY); if (!raw) return;
    const d = JSON.parse(raw);
    if (d.title || d.desc || d.reward || d.dest) {
      pubType = d.type || 'express';
      $$('.type-item').forEach(x=>{ const on = x.dataset.type===pubType; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
      $('#fTitle').value = d.title||''; $('#fDest').value = d.dest||'';
      $('#fDesc').value = d.desc||''; $('#fReward').value = d.reward||'';
      /* 取件码不恢复（草稿从未保存过它），保持空 */
      $$('.loc-chip').forEach(x=>{ const on = x.textContent===d.loc; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
      if (d.deadline) $('#fDeadline').value = d.deadline;
      /* 恢复发布方式：立即 / 预约 / 每周重复 */
      if (d.mode && d.mode !== pubMode) {
        pubMode = d.mode;
        $$('.mode-btn').forEach(x=>{ const on = x.dataset.mode===pubMode; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
        const row = $('#scheduleRow');
        row.style.display = 'block';
        $('#fSchedule').innerHTML = SCHEDULE_OPTS[pubMode].map(o=>`<option>${o}</option>`).join('');
      }
      $('#draftTip').hidden = false;
    }
  } catch(e){}
}
function clearDraft(){ try { localStorage.removeItem(DRAFT_KEY); } catch(e){} $('#draftTip').hidden = true; }

function markInvalid(inputId, errId, bad) {
  $('#'+inputId).classList.toggle('invalid', bad);
  $('#'+errId).classList.toggle('show', bad);
  return bad;
}
function submitTask() {
  if (!S.verified) { toast('🪪', '请先完成学籍认证才能发布任务<br>「我的 → 学籍认证」'); return; }
  const title = $('#fTitle').value.trim();
  const reward = parseFloat($('#fReward').value);
  let hasErr = false;
  hasErr = markInvalid('fTitle','errTitle', !title) || hasErr;
  hasErr = markInvalid('fReward','errReward', !(reward > 0 && reward <= 200)) || hasErr;
  if (hasErr) { toast('⚠️','请先完善必填项'); return; }

  const btn = $('#pubSubmitBtn');
  btn.disabled = true; btn.textContent = '托管支付中…（模拟）';

  setTimeout(()=>{
    const loc = ($('.loc-chip.on')||{}).textContent || '菜鸟驿站';
    const dest = $('#fDest').value.trim() || '待定';
    const id = ++S.seq;
    const secret = $('#fSecret').value.trim();
    const relay = (pubMode==='now' && $('#fDeadline').value==='1 小时内' && $('#fRelay').checked) ? { startedAt: Date.now() } : null;

    if (pubMode==='now') {
      S.tasks.unshift({ id, ts:Date.now(), cat:pubType, title,
        desc: $('#fDesc').value.trim() || '（无补充说明）',
        reward, loc, dest, time:$('#fDeadline').value, urgent: $('#fDeadline').value==='1 小时内',
        relay, hasSecret: !!secret,
        dist: distOf(loc, dest),
        issuer:'我', credit:creditScore(), avatar:'我', ownerId:S.activeId });
      if (secret) S.secrets[id] = { enc: obf(secret), access:0, logs:[] };
      S.posted.unshift({ id, ts:Date.now(), title, cat:pubType, reward, status:'open', loc, dest, relay, ownerId:S.activeId, hasSecret: !!secret, timeAgo:'刚刚发布' });
      pushOrderEvent(id, 'task_published', relay ? '紧急接力任务发布' : '任务发布');
    } else {
      const label = $('#fSchedule').value;
      /* 排期任务同样加密托管取件码，触发时按密文恢复，绝不静默丢弃 */
      S.posted.unshift({ id, ts:Date.now(), title, cat:pubType, reward, status:'scheduled', loc, dest,
        desc: $('#fDesc').value.trim() || '',   /* 模板原始说明，触发后沿用 */
        scheduleLabel: label, mode: pubMode, paused:false, ownerId:S.activeId,
        hasSecret: !!secret, secretEnc: secret ? obf(secret) : null, timeAgo:'刚刚创建' });
      pushOrderEvent(id, 'schedule_created', label);
    }
    save();

    ['fTitle','fDest','fDesc','fReward','fSecret'].forEach(fid=>$('#'+fid).value='');
    $('#fRelay').checked = false; $('#relayCheck').classList.remove('show');
    clearDraft();
    S.ui.cat = 'all'; save();
    $$('.cat').forEach(c=>{ const on = c.dataset.cat==='all'; c.classList.toggle('on', on); c.setAttribute('aria-selected', on); });
    renderTasks();

    btn.disabled = false; btn.textContent = '托管赏金并发布';
    if (pubMode==='now') {
      toast('🛡️', `赏金 ¥${reward} 已托管（模拟）<br>${relay ? '紧急接力广播已启动！' : '任务发布成功！'}`);
      setTimeout(()=>switchTab(relay ? 'orders' : 'home'), 1000);
      if (relay) { S.ui.orderTab='posted'; save(); }
    } else {
      toast('🕐', `已创建${pubMode==='weekly'?'周期':'预约'}任务<br>${$('#fSchedule').value} 自动生成（模拟）`);
      setTimeout(()=>{ S.ui.orderTab='posted'; save(); switchTab('orders'); }, 1200);
    }
  }, 600);
}

/* ================= 顺路拼单 ================= */
function findAlongTask(t) {
  if (isMine(t)) return null;
  const zones = new Set([zoneOf(t.loc), zoneOf(t.dest)]);
  /* C3：遍历全部同区候选，取「顺路分」最高的一组，而不是命中即返回 */
  let best = null;
  S.tasks.forEach(x => {
    if (x.id === t.id || isMine(x)) return;
    if (!(zones.has(zoneOf(x.loc)) || zones.has(zoneOf(x.dest)))) return;
    const detour = 180 + (t.id + x.id) % 5 * 70;      /* 模拟绕行 180–460m，上限 500m */
    if (detour > 800) return;                          /* 超过绕行上限不推荐 */
    const score = (t.reward + x.reward) / (t.dist + detour / 1000);
    if (!best || score > best.score) best = { task: x, detour, score };
  });
  return best;
}
/* ================= 取件码保险箱：密文落盘 =================
 * 演示实现：字符级混淆（XOR + hex），只保证 localStorage 里不出现明文。
 * 生产实现：AES-GCM 加密 + KMS 托管密钥，密文服务端存储，前端仅持有一次性解密令牌。
 */
function obf(s) {
  return String(s).split('').map(c => (c.charCodeAt(0) ^ 0x5a).toString(16).padStart(4, '0')).join('');
}
function unobf(s) {
  try {
    return String(s).match(/.{4}/g).map(h => String.fromCharCode(parseInt(h, 16) ^ 0x5a)).join('');
  } catch (e) { return ''; }
}
function secretText(sec) { return (sec && sec.enc) ? unobf(sec.enc) : ''; }

/* ================= 接单 → 履约状态机 ================= */
/* C1：把任务的期望时限换算成绝对 deadline，准时判定与任务时限挂钩。
   生产由服务端下发 deadline_at，客户端只做展示。 */
function deadlineFrom(timeLabel, fromTs) {
  if (timeLabel === '1 小时内') return fromTs + 3600e3;
  if (timeLabel === '今天内') {
    const d = new Date(fromTs); d.setHours(23, 59, 59, 999); return d.getTime();
  }
  if (timeLabel === '明天中午前') {
    const d = new Date(fromTs); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); return d.getTime();
  }
  return fromTs + 24 * 3600e3; /* 未指定时限：默认 24h */
}
/* 接单前置校验：任何入口（单接 / 拼单）都必须先过这一关 */
function acceptBlockReason(t) {
  if (!t) return '任务已被抢走';
  if (isMine(t)) return '不能接自己发布的任务';
  if (!S.verified) return '请先完成学籍认证才能接单';
  const credit = creditScore();
  if (credit < 80) return '信用分低于 80，已被限制接单';
  const limit = maxActiveOrders();
  if (activeOrderCount() >= limit) {
    return `信用分 ${credit}（80–90 档）最多同时接 1 单<br>完成当前订单后再接新单`;
  }
  return null;
}
/* 拼单额度校验：整组接单后的活动订单数不得超过档位上限 */
function groupBlockReason(size) {
  const limit = maxActiveOrders();
  if (limit === Infinity) return null;
  if (activeOrderCount() + size > limit) {
    return `信用分 ${creditScore()}（80–90 档）最多同时接 ${limit} 单<br>当前已有 ${activeOrderCount()} 单在进行中`;
  }
  return null;
}
/* 接单事务：唯一的落单入口，完整保留 seat / relay 副作用，groupId 为空表示单接 */
function takeTask(t, groupId) {
  const seat = t.cat === 'seat'
    ? { holdUntil: Date.now() + SEAT_HOLD_MS, ext: 0, status: 'active', seatCode: '4F-A' + String(10 + t.id % 40), notified: false }
    : null;
  S.taken.unshift({
    id: t.id, ts: Date.now(), title: t.title, cat: t.cat, reward: t.reward,
    loc: t.loc || '', dest: t.dest || '', ownerId: t.ownerId || '',
    status: 'doing', timeAgo: groupId ? '拼单接单' : '刚刚接单',
    time: t.time || '', deadlineAt: deadlineFrom(t.time, Date.now()),
    secretTaskId: t.hasSecret ? t.id : null, seat, groupId: groupId || null
  });
  /* 履约率分母：接单即计入，超时/取消的订单会留在分母里 */
  S.user.accepted = (S.user.accepted || 0) + 1;
  pushOrderEvent(t.id, 'order_accepted', groupId ? `顺路拼单组 #${groupId}` : '');
  if (t.relay) pushOrderEvent(t.id, 'broadcast_stopped', '已有跑手接单，停止后续广播');
  cleanupGroups();
}
/* C4：组内订单全部进入终态后回收 OrderGroup，避免长会话无限膨胀 */
function cleanupGroups() {
  if (!Array.isArray(S.groups)) return;
  const TERMINAL = ['done', 'expired', 'cancelled'];
  S.groups = S.groups.filter(g => !g.taskIds.every(id => {
    const o = S.taken.find(x => x.id === id);
    return o && TERMINAL.includes(o.status);
  }));
}

function acceptTask(id) {
  const t = S.tasks.find(x => x.id === id);
  const reason = acceptBlockReason(t);
  if (reason) { toast(reason.includes('认证') ? '🪪' : '🚫', reason); return; }
  /* 条件更新（生产：UPDATE ... WHERE runner_id IS NULL） */
  S.tasks = S.tasks.filter(x => x.id !== id);
  takeTask(t, null);
  save(); renderTasks(); closeSheet();
  toast('✅', t.cat === 'seat' ? '接单成功！<br>占座倒计时已启动' : '接单成功！<br>完成后请拍照留证');
  setTimeout(() => switchTab('orders'), 900);
}

/* 拼单：先对两单做完整预校验，任一不通过则整组失败，绝不部分成交 */
function acceptGroup(mainId, alongId) {
  const a = S.tasks.find(x => x.id === mainId), b = S.tasks.find(x => x.id === alongId);
  const reasonA = acceptBlockReason(a), reasonB = acceptBlockReason(b);
  if (reasonA || reasonB) {
    toast('🚫', `拼单失败：${esc(reasonA || reasonB)}`);
    closeSheet(); renderTasks(); return;
  }
  if (a.id === b.id) { toast('😅', '拼单失败：不能重复选择同一任务'); return; }
  const groupReason = groupBlockReason(2);
  if (groupReason) { toast('🚫', `拼单失败：${groupReason}`); closeSheet(); return; }
  const gid = ++S.seq;
  S.groups.push({ id: gid, taskIds: [a.id, b.id], ts: Date.now() });
  /* 事务：整组下架，任一已被接走则整组回滚 */
  S.tasks = S.tasks.filter(x => x.id !== a.id && x.id !== b.id);
  takeTask(a, gid);
  takeTask(b, gid);
  save(); renderTasks(); closeSheet();
  const hasSeat = a.cat === 'seat' || b.cat === 'seat';
  toast('🔗', `拼单成功！<br>两单合计 ¥${a.reward + b.reward}${hasSeat ? '<br>占座倒计时已启动' : ''}`);
  setTimeout(() => switchTab('orders'), 1000);
}
function startDeliver(id) {
  const o = S.taken.find(x=>x.id===id); if (!o) return;
  if (o.status !== 'doing') return; /* 幂等：已出发不可重复触发 */
  o.status = 'delivering'; pushOrderEvent(id, 'delivering');
  save(); renderOrders();
}
function deliverOrder(id) {
  const o = S.taken.find(x=>x.id===id); if (!o) return;
  if (['wait_confirm','done','expired'].includes(o.status)) return; /* 幂等：已送达不可重复上传 */
  o.status = 'wait_confirm'; pushOrderEvent(id, 'proof_uploaded', '送达凭证已上传（模拟）');
  save(); renderOrders();
  toast('📷','送达凭证已上传（模拟）<br>等待发布者确认');
}
function confirmOrder(id) {
  const o = S.taken.find(x=>x.id===id); if (!o) return;
  if (o.status === 'done' || o.status === 'expired') return; /* 幂等：状态与事件在同一分支写入 */
  /* 演示环境由跑手端代发布者确认；生产由发布者端发起，此处需服务端校验操作者身份 */
  pushOrderEvent(id, 'publisher_confirm_simulated', '演示：跑手端代发布者确认（生产由发布者端操作）');
  finishTakenOrder(o);
}
function finishTakenOrder(o) {
  if (o.status === 'done' || o.status === 'expired') return; /* 幂等：已完成不重复结算 */
  o.status = 'done'; o.doneAt = Date.now();
  pushOrderEvent(o.id, 'order_done');
  pushCredit('order_completed', `完成订单「${String(o.title).slice(0,12)}…」`, 2);
  /* 准时 = 确认时刻未超过任务时限换算出的 deadline（接单时刻 + 时限） */
  const deadline = o.deadlineAt || (o.ts + 24*3600e3);
  const onTime = Date.now() <= deadline;
  if (onTime) pushCredit('on_time_completed', '准时履约', 1);
  const u = S.user;
  u.completed += 1;                       /* 分子：成功完成量（分母 accepted 在接单事务中已计） */
  u.income += o.reward; u.balance += o.reward;
  /* 足迹 RouteStamp */
  const from = o.loc || zoneOf(o.title), to = o.dest || '宿舍区';
  if (from && to && from!==to) {
    const label = `${from} → ${to}`;
    const r = S.routes.find(x=>x.label===label);
    if (r) r.n += 1; else S.routes.push({ from, to, n:1, label });
  }
  /* B1：订单结算后销毁取件码密文，敏感数据不长期驻留本地 */
  releaseSecret(o.secretTaskId);
  cleanupGroups();
  save(); renderOrders(); renderMe();
  openReviewTags(o);
}
/* 取件码密文生命周期：终态订单释放密文 */
function releaseSecret(taskId) {
  if (taskId && S.secrets && S.secrets[taskId]) delete S.secrets[taskId];
}

/* ---- 占座 ---- */
function seatProof(id) {
  const o = S.taken.find(x=>x.id===id); if (!o || !o.seat) return;
  if (o.seat.proofAt) return; /* 幂等：凭证只上传一次，不重复写事件 */
  o.seat.proofAt = Date.now();
  pushOrderEvent(id, 'seat_proof', `座位 ${o.seat.seatCode} 凭证已上传（模拟）`);
  save(); renderOrders();
  toast('📷', `占座凭证已上传（模拟）<br>座位 ${o.seat.seatCode} 保留倒计时进行中`);
}
function confirmArrive(id) {
  const o = S.taken.find(x=>x.id===id); if (!o || !o.seat) return;
  if (o.seat.status !== 'active') return; /* 幂等：已确认/已超时不重复结算 */
  o.seat.status = 'confirmed';
  pushOrderEvent(id, 'seat_confirmed', '发布者确认到达');
  finishTakenOrder(o);
}
function extendSeat(id) {
  const o = S.taken.find(x=>x.id===id); if (!o || !o.seat || o.seat.ext>=1) return;
  o.seat.ext += 1;
  o.seat.holdUntil += SEAT_EXT_MS;
  pushOrderEvent(id, 'seat_extended', '延长保留 10 分钟');
  pushCredit('seat_extension', '申请延长占座保留（已记录）', 0); /* 进入信用记录 */
  save(); renderOrders(); renderMe();
  toast('⏰','已延长 10 分钟<br>本次操作已写入信用记录');
}
function checkSeatExpiry() {
  let changed = false;
  S.taken.forEach(o=>{
    if (o.seat && o.seat.status==='active' && Date.now() > o.seat.holdUntil) {
      o.seat.status = 'expired';
      o.status = 'expired';
      pushOrderEvent(o.id, 'seat_expired', '发布者未到，座位自动释放');
      pushCredit('seat_expired', '占座超时自动释放', 0);
      changed = true;
      /* D4：只在订单页提示，避免浏览其它页面时被 toast 打断 */
      if ($('#page-orders').classList.contains('active')) {
        toast('⏰','一个占座订单已超时<br>座位自动释放');
      } else {
        S.ui.ordersUnread = true;
      }
    }
  });
  /* C4：占座超时进入终态，顺带回收已完结的拼单组 */
  if (changed) { cleanupGroups(); save(); if ($('#page-orders').classList.contains('active')) renderOrders(); renderMe(); renderTabBadge(); }
}

/* ---- 取件码保险箱 ---- */
let secretTimer = null;
function viewSecret(orderId) {
  const o = S.taken.find(x=>x.id===orderId); if (!o) return;
  const sec = S.secrets[o.secretTaskId]; if (!sec) return;
  if (sec.access >= 5) { toast('🚫','查看次数已达上限（5 次）'); return; }
  sec.access += 1;
  sec.logs.push({ t:Date.now() }); /* SecretAccessLog */
  save(); renderOrders();
  const code = secretText(sec);
  let remain = 30;
  openSheet(`
    <div class="sheet-title" style="text-align:center">🔐 取件码保险箱</div>
    <div class="secret-display">
      <div class="s-code" id="secretCode">${esc(code)}</div>
      <div class="s-cd" id="secretCd">剩余 ${remain} 秒</div>
      <div class="s-note">已记录本次访问（第 ${sec.access} 次）· 请勿截图外传<br>明文不落盘、不缓存，30 秒后自动关闭<br>当前为<b>演示级混淆</b>，生产为 AES-GCM 加密 + KMS 密钥托管</div>
    </div>`,
    `<button class="btn-sm ghost" onclick="closeSecret()">立即关闭</button>`);
  clearInterval(secretTimer);
  secretTimer = setInterval(()=>{
    remain -= 1;
    const el = document.getElementById('secretCd');
    if (!el) { clearInterval(secretTimer); return; }
    if (remain <= 0) { clearInterval(secretTimer); closeSheet(); toast('🔒','取件码已重新加密'); return; }
    el.textContent = `剩余 ${remain} 秒`;
  }, 1000);
}
function closeSecret(){
  clearInterval(secretTimer);
  const el = $('#secretCode'); if (el) el.textContent = '••••'; /* 关闭即抹掉明文 */
  closeSheet();
}

/* ---- 发布者视角（模拟对端） ---- */
function simulateRunner(id) {
  const o = S.posted.find(x=>x.id===id); if (!o) return;
  if (o.status !== 'open') return; /* 幂等：非待接单不重复模拟 */
  o.status = 'doing'; o.timeAgo = '林同学（跑手）已接单';
  if (o.relay) pushOrderEvent(id, 'broadcast_stopped', '跑手已接单，停止广播');
  pushOrderEvent(id, 'order_accepted', '林同学（模拟跑手）接单');
  S.tasks = S.tasks.filter(t => t.id !== id); /* 任务同步下架，不再留在广场 */
  save(); renderOrders(); renderTasks();
  toast('🏃','林同学 已接单（模拟）<br>接力广播已停止');
}
function simulateRunnerDeliver(id) {
  const o = S.posted.find(x=>x.id===id); if (!o) return;
  if (o.status !== 'doing' && o.status !== 'delivering') return; /* 幂等 */
  o.status = 'wait_confirm';
  pushOrderEvent(id, 'proof_uploaded', '跑手已上传送达凭证（模拟）');
  save(); renderOrders();
  toast('📷','跑手已送达并上传凭证（模拟）<br>请确认完成');
}
function publisherConfirm(id) {
  const o = S.posted.find(x=>x.id===id); if (!o) return;
  if (o.status === 'done') return; /* 幂等：已结算不重复结算 */
  o.status = 'done';
  pushOrderEvent(id, 'order_done', '发布者确认，托管赏金已结算（模拟）');
  save(); renderOrders();
  toast('🎉', `已确认完成<br>托管赏金 ¥${o.reward} 已结算给跑手（模拟）`);
}

/* ---- 预约 / 周期 ---- */
function triggerSchedule(id) {
  const o = S.posted.find(x=>x.id===id); if (!o || o.status!=='scheduled') return; /* 幂等 */
  S.posted = S.posted.filter(x=>x.id!==id);
  /* 取件码密文随排期一起恢复，创建时填了取件码的任务触发后仍有保险箱 */
  if (o.secretEnc) S.secrets[id] = { enc: o.secretEnc, access:0, logs:[] };
  S.tasks.unshift({ id:o.id, ts:Date.now(), cat:o.cat, title:o.title,
    /* C5：保留模板原始说明，不再用固定文案覆盖 */
    desc: o.desc || '由预约/周期模板自动生成（模拟）', reward:o.reward, loc:o.loc, dest:o.dest,
    time:'今天内', urgent:false, relay:null, hasSecret: !!o.hasSecret, dist: distOf(o.loc, o.dest),
    issuer:'我', credit:creditScore(), avatar:'我', ownerId:o.ownerId || S.activeId });
  S.posted.unshift({ id:o.id, ts:Date.now(), title:o.title, cat:o.cat, reward:o.reward, status:'open', loc:o.loc, dest:o.dest, ownerId:o.ownerId || S.activeId, hasSecret: !!o.hasSecret, timeAgo:'由排期自动生成' });
  pushOrderEvent(id, 'schedule_fired', o.scheduleLabel || '');
  save(); renderTasks(); renderOrders();
  toast('⚡','排期已触发<br>任务已自动上架广场');
}
function toggleSchedule(id) {
  const o = S.posted.find(x=>x.id===id); if (!o) return;
  o.paused = !o.paused; save(); renderOrders();
}

/* ================= 取消发布 ================= */
function askCancelPosted(id) {
  const o = S.posted.find(x=>x.id===id); if (!o) return;
  openSheet(`
    <div class="sheet-title">取消发布？</div>
    <div class="sheet-sec"><p>任务「${esc(o.title)}」将被下架，托管赏金 <b style="color:var(--orange)">¥${esc(o.reward)}</b> 将原路退回（模拟）。${o.relay ? '<br>进行中的接力广播将立即停止。' : ''}</p></div>`,
    `<button class="btn-sm ghost" onclick="closeSheet()">再想想</button>
     <button class="btn-sm primary" style="background:var(--red)" onclick="doCancelPosted(${o.id})">确认取消</button>`);
}
function doCancelPosted(id) {
  const o = S.posted.find(x=>x.id===id); if (!o) return;
  if (o.status !== 'open' && o.status !== 'scheduled') return; /* 幂等：已取消/已成交不再退款 */
  o.status = 'cancelled';
  /* B1：取消发布同样释放密文（含未触发的排期任务） */
  releaseSecret(id); delete o.secretEnc;
  S.tasks = S.tasks.filter(t=>t.id!==id);
  pushOrderEvent(id, 'task_cancelled');
  cleanupGroups();
  save(); renderTasks(); renderOrders(); closeSheet();
  toast('↩️', `已取消发布<br>赏金 ¥${o.reward} 已原路退回（模拟）`);
}

/* ================= 微评价标签 ================= */
const REVIEW_TAGS = [ {t:'速度快',d:0.5}, {t:'沟通顺畅',d:0.5}, {t:'包装完整',d:0.5}, {t:'礼貌',d:0.5}, {t:'准时',d:1} ];
function openReviewTags(o) {
  window.__reviewOrderId = o.id;
  window.__reviewSel = new Set();
  openSheet(`
    <div class="sheet-title" style="text-align:center">微评价 · 一点即过</div>
    <div class="sheet-sec" style="text-align:center"><p>选 1–3 个标签即可，评价将双向匿名 24 小时后展示（盲评）</p></div>
    <div class="tag-chips" id="reviewChips">
      ${REVIEW_TAGS.map((x,i)=>`<button class="tag-chip" data-i="${i}">${x.t}</button>`).join('')}
    </div>
    <div class="review-note">标签计入信用事件：准时 +1，其余 +0.5</div>`,
    `<button class="btn-sm primary" id="reviewSubmit" disabled>提交评价</button>`);
  $('#reviewChips').addEventListener('click', e=>{
    const b = e.target.closest('.tag-chip'); if (!b) return;
    const i = +b.dataset.i;
    if (window.__reviewSel.has(i)) window.__reviewSel.delete(i);
    else if (window.__reviewSel.size < 3) window.__reviewSel.add(i);
    else { toast('🙈','最多选 3 个'); return; }
    b.classList.toggle('on', window.__reviewSel.has(i));
    const sb = $('#reviewSubmit');
    sb.disabled = window.__reviewSel.size === 0;
    sb.onclick = submitReviewTags;
  });
}
function submitReviewTags() {
  const o = S.taken.find(x=>x.id===window.__reviewOrderId);
  if (!o || o.reviewed) { closeSheet(); return; } /* 幂等：一单只评价一次 */
  const sel = [...window.__reviewSel].map(i=>REVIEW_TAGS[i]).filter(Boolean);
  if (!sel.length) { toast('🙈','请先选择 1–3 个标签'); return; }
  let total = 0;
  sel.forEach(x=>{ total += x.d; pushCredit('positive_review', `收到「${x.t}」评价`, x.d); });
  o.reviewed = true; o.reviewTags = sel.map(x=>x.t);
  save(); renderMe(); renderOrders(); closeSheet();
  toast('🎉', `评价成功！<br>赏金 ¥${o.reward} 已到账（模拟），信用 +${total}`);
}

/* ================= 弹层 ================= */
let lastFocus = null;
function openSheet(bodyHtml, actionsHtml) {
  lastFocus = document.activeElement;
  $('#sheetBody').innerHTML = bodyHtml;
  $('#sheetActions').innerHTML = actionsHtml;
  $('#mask').classList.add('show');
  $('#sheet').classList.add('show');
  $('#sheet').setAttribute('aria-hidden','false');
  /* 焦点进入弹层，首个可聚焦元素 */
  const first = $('#sheetActions button:not([disabled])') || $('#sheetBody button:not([disabled])') || $('#sheetBody input') || $('#sheet');
  if (first) { try { first.focus(); } catch(e){} }
}
function closeSheet(){
  clearInterval(secretTimer);
  $('#mask').classList.remove('show');
  $('#sheet').classList.remove('show');
  $('#sheet').setAttribute('aria-hidden','true');
  const el = $('#secretCode'); if (el) el.textContent = '••••';
  /* 焦点回到触发弹层的元素 */
  if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch(e){} }
  lastFocus = null;
}
/* 弹层内焦点锁定 + Escape 关闭 */
document.addEventListener('keydown', e => {
  /* 注册引导层：Escape = 放弃注册回到当前账号；Tab 锁在层内 */
  /* D1：分类 tab 支持 ←/→ 与 Home/End 键盘导航（role=tablist 的应有行为） */
  const t = e.target;
  const inSheet = !!(t && t.closest && t.closest('#sheet'));
  if (!inSheet && $('#obLayer').hidden) {
    const cats = [...$$('.cat')];
    const idx = cats.indexOf(t.closest ? t.closest('.cat') : null);
    if (idx !== -1 && ['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0
        : e.key === 'End' ? cats.length - 1
        : (idx + (e.key === 'ArrowRight' ? 1 : -1) + cats.length) % cats.length;
      cats[next].focus();
      if (cats[next].dataset.cat) cats[next].click();
      return;
    }
  }
  const obOpen = !$('#obLayer').hidden;
  if (obOpen) {
    if (e.key === 'Escape') { e.preventDefault(); skipOnboard(); return; }
    if (e.key === 'Tab') {
      const items = [...$('#obLayer').querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled])')];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!items.includes(document.activeElement)) { e.preventDefault(); first.focus(); }
      return;
    }
  }
  const open = $('#sheet').classList.contains('show');
  if (!open) return;
  if (e.key === 'Escape') { e.preventDefault(); if (secretTimer) closeSecret(); else closeSheet(); return; }
  if (e.key !== 'Tab') return;
  const items = [...$('#sheetBody').querySelectorAll('button,input,textarea,select,[tabindex]:not([tabindex="-1"])'),
                 ...$('#sheetActions').querySelectorAll('button:not([disabled])')].filter(el => !el.disabled);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

function openTask(id) {
  const t = S.tasks.find(x=>x.id===id); if (!t) return;
  const along = findAlongTask(t);
  openSheet(`
    <div class="sheet-title">${esc(t.title)}</div>
    <div class="sheet-reward"><small>¥</small>${esc(t.reward)}<span class="sheet-escrow">🛡️ 赏金平台托管中（模拟）</span></div>
    <div class="sheet-sec"><h5>任务说明</h5><p>${esc(t.desc)}</p></div>
    <div class="sheet-sec"><h5>取送信息</h5><p>📍 ${esc(t.loc)} → ${esc(t.dest)}<br>🚶 距离约 ${t.dist}km · 区域：${zoneOf(t.loc)}<br>⏰ 期望时限：${esc(t.time)}</p></div>
    ${t.hasSecret ? `<div class="sheet-sec"><h5>取件码保险箱</h5><div class="secure-box" style="margin-top:0">🔐 取件码已托管（演示级混淆 · 生产为 AES-GCM + KMS），接单后限时查看</div></div>` : ''}
    ${t.cat==='seat' ? `<div class="sheet-sec"><h5>占座规则</h5><p>占位保留上限 <b>40 分钟</b>，发布者未到自动释放；可申请延长一次 10 分钟（写入信用记录）。</p></div>` : ''}
    ${t.relay ? `<div class="sheet-sec"><h5>紧急接力</h5><p>📢 本任务正在按「同楼栋 → 相邻楼栋 → 全校」逐波广播，先接先得。</p></div>` : ''}
    <div class="sheet-sec"><h5>发布者</h5>
      <div class="issuer-card">
        <span class="avatar" style="background:${AVATAR_COLORS[t.id % 6]}">${esc(t.avatar)}</span>
        <div>
          <div class="i-name">${esc(t.issuer)} <span style="font-size:10px;color:var(--green)">✓ 学籍已认证（模拟）</span></div>
          <div class="i-meta">信用分 <b style="color:var(--green)">${esc(t.credit)}</b> · 准时 98% · 沟通 96% · 包装 94%</div>
        </div>
      </div>
    </div>
    ${along ? `
    <div class="sheet-sec"><h5>顺路推荐</h5>
      <div class="along-card">
        <div class="a-head">🔗 顺路可再接 1 单，合计多赚 ¥${along.task.reward}</div>
        <div class="a-task">${esc(along.task.title)}</div>
        <div class="a-meta">📍 ${esc(along.task.loc)} → ${esc(along.task.dest)} · 预计多绕约 ${along.detour} 米 · 顺路分 ${((t.reward+along.task.reward)/(t.dist+along.detour/1000)).toFixed(1)}</div>
      </div>
    </div>` : ''}`,
    (along && !isMine(t))
      ? `<button class="btn-sm ghost" onclick="closeSheet()">再想想</button>
         <button class="btn-sm primary" style="flex:1.4" onclick="acceptGroup(${t.id},${along.task.id})">🔗 拼单同接 ¥${t.reward + along.task.reward}</button>
         <button class="btn-sm primary" style="background:var(--blue)" onclick="acceptTask(${t.id})">只接这单</button>`
      : `<button class="btn-sm ghost" onclick="closeSheet()">再想想</button>
         <button class="btn-sm primary" onclick="acceptTask(${t.id})" ${isMine(t)?'disabled':''}>${isMine(t) ? '这是我发布的' : '立即接单'}</button>`);
}

/* ================= 信用明细 / 分享卡 ================= */
function openCreditLog() {
  const logs = S.creditEvents.slice(0, 30);
  const fmt = t => { const d = new Date(t); return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
  openSheet(`
    <div class="sheet-title">信用分明细 · 事件账本</div>
    <div class="sheet-sec"><p>当前 <b style="color:var(--green)">${creditScore()}</b> 分 = 100 + Σ(${S.creditEvents.length} 条事件)</p></div>
    <div class="credit-log" style="margin-top:8px">
      ${logs.map(l=>`<div class="credit-log-item">
        <div class="cl-info"><div class="cl-title">${esc(l.title)}</div><div class="cl-time">${fmt(l.t)} · ${esc(l.type)}</div></div>
        <div class="cl-num ${l.delta>0?'plus':l.delta<0?'minus':'zero'}">${l.delta>0?'+':''}${l.delta}</div>
      </div>`).join('') || '<div class="empty">暂无记录</div>'}
    </div>`,
    `<button class="btn-sm ghost" onclick="closeSheet()">关闭</button>`);
}
function openShareCard() {
  const credit = creditScore();
  const u = S.user;
  const best = [...S.routes].sort((a,b)=>b.n-a.n)[0];
  openSheet(`
    <div class="sheet-title" style="text-align:center">我的信用护照</div>
    <div class="share-card">
      <div class="sc-title">帮跑校园 · 信用护照（模拟生成）</div>
      <div class="sc-name">${esc(S.name || '同学')} · 信用 ${credit}</div>
      <div class="sc-stats">
        <div class="sc-stat"><b>${u.completed}</b><span>完成订单</span></div>
        <div class="sc-stat"><b>${$('#statRate').textContent}</b><span>履约率</span></div>
        <div class="sc-stat"><b>¥${u.income}</b><span>累计收入</span></div>
      </div>
      <div class="sc-route">🚩 最常路线：${best ? esc(best.label) : '暂无'}</div>
      <div class="sc-badges">${S.badges.map(b=>esc(b)).join(' · ')}</div>
    </div>`,
    `<button class="btn-sm ghost" onclick="closeSheet()">关闭</button>
     <button class="btn-sm primary" onclick="toast('📤','分享图为模拟生成')">保存分享图</button>`);
}

/* ================= 成员（账号）：注册 / 学籍认证 / 切换 ================= */
/* 信用分由该成员的 CreditEvent 账本聚合；当前成员的账本取实时值 */
function creditOf(acc) {
  const evs = (acc && acc.id === S.activeId) ? S.creditEvents : (acc ? acc.creditEvents : []);
  return Math.min(120, 100 + (evs || []).reduce((s, e) => s + e.delta, 0));
}
function syncActiveProfile() {
  const i = S.accounts.findIndex(a => a.id === S.activeId);
  if (i !== -1) S.accounts[i] = Object.assign({ id: S.activeId }, pickProfile(S));
}
function switchAccount(id) {
  if (id === S.activeId) { closeSheet(); return; }
  const target = S.accounts.find(a => a.id === id); if (!target) return;
  syncActiveProfile();
  Object.assign(S, pickProfile(target));
  S.activeId = id;
  S.ui.cat = 'all'; S.ui.orderTab = 'taken';
  S.posted = S.posted || []; S.taken = S.taken || [];
  save(); closeSheet();
  $('#searchInput').value = ''; $('#searchClear').classList.remove('show');
  $$('.cat').forEach(c => { const on = c.dataset.cat === 'all'; c.classList.toggle('on', on); c.setAttribute('aria-selected', on); });
  $$('.order-tab').forEach(t => { const on = t.dataset.tab === 'taken'; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); });
  renderTasks(); renderOrders(); renderMe();
  switchTab('me');
  toast('👥', `已切换为 <b>${esc(target.name)}</b>`);
}
function openAccounts() {
  const rows = S.accounts.map(a => {
    const on = a.id === S.activeId;
    const badge = a.verified
      ? '<span class="verify-badge light">✓ 已认证</span>'
      : '<span class="verify-badge light warn">未认证</span>';
    return `<button class="acc-card ${on ? 'on' : ''}" type="button" onclick="switchAccount('${esc(a.id)}')"${on ? ' aria-current="true"' : ''}>
      <div class="acc-av" aria-hidden="true">${esc(a.avatar || '👤')}</div>
      <div class="acc-info">
        <div class="acc-name">${esc(a.name || '未命名')}${badge}</div>
        <div class="acc-sub">${esc([a.school, a.college].filter(Boolean).join(' · ') || '未填写学校')}${on ? ' · 当前登录' : ''}</div>
      </div>
      <div class="acc-credit">信用 ${creditOf(a)}</div>
    </button>`;
  }).join('');
  openSheet(`
    <div class="sheet-title">成员与账号</div>
    <div class="sheet-sec"><p>演示版支持在同一设备切换成员，方便体验「发布者 / 跑腿员」双方视角。生产中每个账号由微信 openid 唯一绑定，<b>学籍认证一人一号</b>，认证成功不可转让。</p></div>
    ${rows}
    <div class="sheet-sec" style="margin-top:4px"><p><b>邀请同学：</b>同学用微信打开链接 → 一键登录 → 学籍认证，即成为同校互助成员（模拟）。</p></div>`,
    `<button class="btn-sm ghost" onclick="closeSheet()">关闭</button>
     <button class="btn-sm primary" onclick="openOnboard()">＋ 注册新成员</button>`);
}

/* ================= 注册 / 学籍认证（Onboarding） ================= */
const OB_STEPS = ['微信登录', '学籍认证', '开始使用'];
const OB_SCHOOLS = ['香港理工大学', '深圳大学', '中山大学', '华南理工大学', '其他院校'];
let obStep = 1;
let obForm = {};
let obLastFocus = null;

function openOnboard() {
  closeSheet();
  obStep = 1;
  obForm = { name: '', school: S.school || '香港理工大学', college: '', studentId: '', cardUploaded: false, err: '' };
  obLastFocus = document.activeElement;
  $('#obLayer').hidden = false;
  $('#obLayer').setAttribute('aria-hidden', 'false');
  renderOnboard();
  /* 焦点进入引导层首个可操作元素 */
  const first = $('#obBtns button:not([disabled])') || $('#obBody input:not([disabled])');
  if (first) { try { first.focus(); } catch(e){} }
}
function closeOnboard() {
  $('#obLayer').hidden = true;
  $('#obLayer').setAttribute('aria-hidden', 'true');
  if (obLastFocus && obLastFocus.focus) { try { obLastFocus.focus(); } catch(e){} }
  obLastFocus = null;
}
function skipOnboard() {
  closeOnboard();
  S.onboarded = true; save();
  renderMe();
  toast('👋', `已回到 <b>${esc(S.name || '当前成员')}</b><br>可在「我的 → 成员与账号」注册新成员`);
}
function renderOnboard() {
  $('#obSteps').innerHTML = OB_STEPS.map((t, i) => {
    const n = i + 1, cls = n === obStep ? 'on' : (n < obStep ? 'done' : '');
    return (i ? '<span class="ob-line"></span>' : '') + `<span class="ob-step ${cls}"><i>${n < obStep ? '✓' : n}</i>${t}</span>`;
  }).join('');

  if (obStep === 1) {
    $('#obBody').innerHTML = `
      <div class="ob-card">
        <div style="font-size:14px;font-weight:600;margin-bottom:8px">微信一键登录</div>
        <p style="font-size:12.5px;color:var(--text-2);line-height:1.75">原型演示：生产中调用 wx.login 换取 openid，无需设置密码，学生零门槛进入。</p>
      </div>
      <div class="ob-card" style="background:#f0fdf5">
        <p style="font-size:12.5px;color:var(--green-dark);line-height:1.75"><b>为什么先登录？</b>跑腿涉及赏金托管与信用累积，账号是信用的载体——信用分、履约记录、徽章都挂在账号上。</p>
      </div>`;
    $('#obBtns').innerHTML = `
      <button class="btn-lg primary" id="obWxBtn" onclick="obWxLogin()">微信一键登录（模拟）</button>
      <button class="btn-lg ghost" onclick="skipOnboard()">先看看示例成员 →</button>`;
    return;
  }

  if (obStep === 2) {
    $('#obBody').innerHTML = `
      <div class="ob-card">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:12px">学籍实名认证</h3>
        <div class="form-row">
          <label for="obName">昵称</label>
          <input id="obName" maxlength="12" placeholder="用于展示，如 杨同学" value="${esc(obForm.name)}">
        </div>
        <div class="form-row">
          <label for="obSchool">学校</label>
          <select id="obSchool">${OB_SCHOOLS.map(s => `<option${s === obForm.school ? ' selected' : ''}>${s}</option>`).join('')}</select>
        </div>
        <div class="form-row">
          <label for="obCollege">学院 / 专业</label>
          <input id="obCollege" maxlength="20" placeholder="如 计算学院" value="${esc(obForm.college)}">
        </div>
        <div class="form-row">
          <label for="obSid">学号（6–16 位字母或数字）</label>
          <input id="obSid" maxlength="16" placeholder="用于一人一号核验" value="${esc(obForm.studentId)}" autocomplete="off">
          <div class="field-err${obForm.err ? ' show' : ''}" id="obErr">${esc(obForm.err || '')}</div>
        </div>
      </div>
      <div class="ob-card">
        <div style="font-size:14px;font-weight:600;margin-bottom:10px">校园卡 / 学生证核验</div>
        <button class="idcard${obForm.cardUploaded ? ' up' : ''}" id="obCardBtn" type="button" onclick="obUploadCard()">${obForm.cardUploaded ? '✓ 已上传，OCR 识别通过（模拟）' : '📷 点击上传校园卡（模拟 OCR 识别）'}</button>
        <p style="font-size:11.5px;color:var(--text-3);margin-top:8px;line-height:1.7">按「最小必要」原则采集，核验完成后立即销毁原图（模拟）。</p>
      </div>`;
    $('#obBtns').innerHTML = `
      <button class="btn-lg primary" id="obSubmitBtn" onclick="obSubmitVerify()">提交认证</button>
      <button class="btn-lg ghost" onclick="obSkipVerify()">暂不认证，先逛逛（功能受限）</button>`;
    return;
  }

  const acc = S.accounts.find(a => a.id === S.activeId) || {};
  $('#obBody').innerHTML = `
    <div class="ob-card" style="text-align:center;padding:26px 16px">
      <div style="font-size:46px" aria-hidden="true">${acc.verified ? '✅' : '👋'}</div>
      <div style="font-size:16px;font-weight:700;margin:12px 0 8px">${acc.verified ? '学籍认证通过' : '已进入体验模式'}</div>
      <p style="font-size:12.5px;color:var(--text-2);line-height:1.75">${acc.verified ? '你已成为同校互助成员，信用分从 <b>100</b> 起步，完成订单与收到好评都会累积信用。' : '未认证状态下可以浏览任务，但<b>不能发布或接单</b>。随时可在「我的」完成认证。'}</p>
    </div>
    <div class="ob-card">
      <div style="font-size:13px;font-weight:600;margin-bottom:10px">当前权限</div>
      <div style="font-size:12.5px;color:var(--text-2);line-height:2">
        ${acc.verified
          ? '✓ 发布任务 / 接单跑腿<br>✓ 赏金托管与结算<br>✓ 占座、取件码保险箱等特色任务'
          : '○ 发布任务 / 接单跑腿（需先认证）<br>○ 赏金托管与结算（需先认证）<br>✓ 浏览任务广场（可体验）'}
      </div>
    </div>`;
  $('#obBtns').innerHTML = `<button class="btn-lg primary" onclick="finishOnboard()">进入帮跑校园</button>`;
}

function obWxLogin() {
  const btn = $('#obWxBtn'); btn.disabled = true; btn.textContent = '微信授权中…';
  setTimeout(() => { obForm.name = obForm.name || '新同学'; obStep = 2; renderOnboard(); }, 700);
}
function obUploadCard() {
  const btn = $('#obCardBtn'); btn.disabled = true; btn.textContent = 'OCR 识别中…（模拟）';
  /* 重渲染前先回读表单，避免已填内容被重置 */
  setTimeout(() => { obReadForm(); obForm.cardUploaded = true; obForm.err = ''; renderOnboard(); }, 900);
}
function obReadForm() {
  const g = id => { const el = $('#' + id); return el ? el.value.trim() : ''; };
  if (obStep === 2) {
    obForm.name = g('obName'); obForm.school = g('obSchool');
    obForm.college = g('obCollege'); obForm.studentId = g('obSid');
  }
}
function obSubmitVerify() {
  obReadForm();
  if (!obForm.name) { obForm.err = '请填写昵称'; renderOnboard(); return; }
  /* 学号归一：去空格 + 统一大写后再校验/比对，避免 ABC123 与 abc123 注册成两个账号 */
  obForm.studentId = normSid(obForm.studentId);
  if (!/^[A-Z0-9]{6,16}$/.test(obForm.studentId)) { obForm.err = '学号需为 6–16 位字母或数字'; renderOnboard(); return; }
  if (!obForm.cardUploaded) { obForm.err = '请上传校园卡完成核验'; renderOnboard(); return; }
  const btn = $('#obSubmitBtn'); btn.disabled = true; btn.textContent = '学籍核验中…（模拟）';
  setTimeout(() => {
    const sid = String(obForm.studentId || '').toUpperCase();
    const hash = sid ? sidHash(sid) : '';
    if (hash && S.accounts.some(a => a.sidHash === hash)) {
      obForm.err = '该学号已完成认证，请直接切换该账号'; renderOnboard(); return;
    }
    obForm.err = '';
    createAndActivate({ name: obForm.name, school: obForm.school, college: obForm.college,
      studentId: sid, verified: true });
    obStep = 3; renderOnboard();
    toast('🎉', '学籍认证通过（模拟）<br>信用分 100 起步');
  }, 1000);
}
function obSkipVerify() {
  obReadForm();
  createAndActivate({ name: obForm.name || '新同学', school: obForm.school, college: obForm.college, studentId: '', sidHash: '', verified: false });
  obStep = 3; renderOnboard();
}
function createAndActivate(form) {
  syncActiveProfile();
  const id = 'u' + Date.now().toString(36);
  /* B2：学号在这里统一归一（去空格 + 大写）→ 掩码（落盘）→ 哈希（一人一号比对）。
     所有入口共用这一步，避免某个入口漏处理导致明文落盘。 */
  const sid = normSid(form.studentId);
  const acc = {
    id, name: form.name, school: form.school, college: form.college || '未填写',
    avatar: (form.name || '新').slice(0, 1),
    studentId: sid ? maskSid(sid) : '',
    sidHash: sid ? sidHash(sid) : '',
    verified: !!form.verified, verifiedAt: form.verified ? Date.now() : null,
    creditEvents: form.verified ? [{ t: Date.now(), type: 'identity_verified', title: '完成学籍认证（模拟）', delta: 0 }] : [],
    user: { completed: 0, accepted: 0, income: 0, balance: 0, monthCompleted: 0, onTimeSeed: 1 },
    badges: [], routes: [], taken: [], posted: []
  };
  S.accounts.push(Object.assign({ id }, pickProfile(acc)));
  Object.assign(S, pickProfile(acc));
  S.activeId = id;
  S.onboarded = true;
  S.ui.cat = 'all'; S.ui.orderTab = 'taken';
  save();
  $$('.cat').forEach(c => { const on = c.dataset.cat === 'all'; c.classList.toggle('on', on); c.setAttribute('aria-selected', on); });
  $$('.order-tab').forEach(t => { const on = t.dataset.tab === 'taken'; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); });
  renderTasks(); renderOrders(); renderMe();
}
function finishOnboard() {
  closeOnboard();
  S.onboarded = true; save();
  $('#searchInput').value = ''; $('#searchClear').classList.remove('show');
  renderTasks(); renderMe();
  switchTab('home');
}

/* ================= 重置 ================= */
function resetDemo() {
  openSheet(`
    <div class="sheet-title">重置演示数据？</div>
    <div class="sheet-sec"><p>将清空所有订单、事件账本、信用记录和草稿，恢复初始演示状态。</p></div>`,
    `<button class="btn-sm ghost" onclick="closeSheet()">取消</button>
     <button class="btn-sm primary" style="background:var(--red)" onclick="doReset()">确认重置</button>`);
}
function doReset() {
  try { localStorage.removeItem(STORE_KEY); localStorage.removeItem(DRAFT_KEY); } catch(e){}
  S = seedState(); S.onboarded = true; save();
  $('#obLayer').hidden = true;
  $('#searchInput').value=''; $('#searchClear').classList.remove('show');
  ['fTitle','fDest','fDesc','fReward','fSecret'].forEach(fid=>$('#'+fid).value='');
  $$('.cat').forEach(c=>c.classList.toggle('on', c.dataset.cat==='all'));
  $$('.sort-btn').forEach(b=>b.classList.toggle('on', b.dataset.sort==='rec'));
  $('#simNotice').style.display = '';
  renderTasks(); renderMe(); closeSheet();
  toast('🔄','已恢复初始演示数据');
  setTimeout(()=>switchTab('home'), 800);
}
function dismissNotice(){ $('#simNotice').style.display='none'; S.ui.noticeClosed = true; save(); }

/* ================= Toast ================= */
let toastTimer;
function toast(ico, html) {
  const el = $('#toast');
  el.innerHTML = `<span class="t-ico">${esc(ico)}</span>${html}`;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.remove('show'), 2000);
}

/* ================= 全局滴答：占座倒计时 & 接力广播 =================
 * D2：只更新变化的文本节点与环形偏移，不再每秒整表重渲染。
 */
function tickSeatCounters() {
  $$('[data-seat-cd]').forEach(el=>{
    const o = S.taken.find(x=>String(x.id)===el.dataset.seatCd);
    if (!o || !o.seat || o.seat.status!=='active') return;
    const remain = Math.max(0, o.seat.holdUntil - Date.now());
    el.textContent = String(Math.floor(remain/60000)).padStart(2,'0') + ':' + String(Math.floor(remain%60000/1000)).padStart(2,'0');
    const ring = document.querySelector(`[data-seat-ring="${o.id}"]`);
    if (ring) ring.style.strokeDashoffset = (163.4*(1-remain/SEAT_HOLD_MS)).toFixed(1);
  });
}
function tickRelayWaves() {
  $$('[data-relay-line]').forEach(el=>{
    const id = +el.dataset.relayLine;
    const o = S.posted.find(x=>x.id===id) || S.taken.find(x=>x.id===id);
    if (!o || !o.relay) return;
    el.innerHTML = relayWaveHtml(o);
  });
}
setInterval(()=>{
  tickSeatCounters();
  tickRelayWaves();
  checkSeatExpiry();
}, 1000);

/* ================= 初始化 ================= */
if (S.ui.noticeClosed) $('#simNotice').style.display = 'none';
$$('.cat').forEach(c=>{ const on = c.dataset.cat===S.ui.cat; c.classList.toggle('on', on); c.setAttribute('aria-selected', on); });
$$('.sort-btn').forEach(b=>b.classList.toggle('on', b.dataset.sort===S.ui.sort));
$$('.order-tab').forEach(t=>{ const on = t.dataset.tab===S.ui.orderTab; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); });
loadDraft();
renderTasks();
renderMe();
renderTabBadge();
/* 首次访问：走注册 / 学籍认证引导 */
if (!S.onboarded) openOnboard();
