/* ==========================================================================
   BiliFav Studio · 前端逻辑
   纯原生 JS，不依赖任何外部库（离线也能跑）。
   ========================================================================== */
(() => {
  'use strict';

  const TOKEN = window.__TOKEN__ || '';
  const PREFS = { folder_order: null, shortcuts: {}, misc: {}, ui: {} };
  // 与当前脚本同目录，兼容正式 /static/ 服务和直接打开的静态预览页。
  const READING_IMAGE = new URL('reading.webp', document.currentScript.src).href;
  const APP_ASSET_URL = document.currentScript.src;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  let sortModeSaving = false;
  document.addEventListener('keydown', (e) => {
    if (!sortModeSaving) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  /* ---------------------------------------------------------------- 工具 */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const httpsify = (url) => String(url || '').replace(/^http:\/\//i, 'https://');

  /**
   * 往本机存一点东西。
   *
   * **双写**：浏览器存储 + 后端 `data/config/prefs.json`。
   *
   * 以前只写浏览器存储 —— 那东西是跟浏览器绑着的，换台电脑、清一次
   * "网站数据"就全没了。用户明确要求所有数据都待在程序旁边的 data/ 里，
   * 所以现在后端那份才是权威副本：浏览器存储降级成缓存（读得快，老的
   * 读代码一行都不用改），拷走 data/ 就能把标签、主题一起带走。
   *
   * 浏览器存储是有配额、也可能被禁用的，写不进去的时候**必须吭一声** ——
   * 静默失败最坑人：用户以为标签都存好了，关掉窗口才发现没了。
   */
  function lsSave(key, value, what) {
    let ok = true;
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      ok = false;
      console.warn('localStorage 写入失败：', key, err);
    }
    queueUiSave(key, value);          // 后端那份照样写得到
    if (!ok) {
      toast(`${what}没能存进浏览器缓存（存储满了或者被禁用了），不过已经存到 data/ 里了`, 'warn', 9000);
    }
    return ok;
  }

  /* 攒一下再发 —— 连着贴几个标签不该打一串请求出去 */
  const uiPending = {};
  let uiTimer = null;
  let uiSaveQueue = Promise.resolve();
  let uiSaveFailed = false;

  function queueUiSave(key, value) {
    uiPending[key] = value;
    PREFS.ui[key] = value;
    if (uiTimer) clearTimeout(uiTimer);
    uiTimer = setTimeout(flushUiSave, 600);
  }

  async function flushUiSave() {
    if (uiTimer) clearTimeout(uiTimer);
    uiTimer = null;
    const patch = {...uiPending};
    if (!Object.keys(patch).length) { await uiSaveQueue; return !uiSaveFailed; }
    Object.keys(patch).forEach(k => delete uiPending[k]);
    const write = uiSaveQueue.then(() => api('/api/prefs/ui-patch', { ui: patch }));
    uiSaveQueue = write.catch(() => {});
    try {
      await write;
      if (uiSaveFailed && !Object.keys(uiPending).length) toast('待保存的设置已恢复保存', 'ok', 3000);
      uiSaveFailed = uiSaveFailed && !!Object.keys(uiPending).length;
      return true;
    } catch (_) {
      // 新值优先；失败的补丁留待恢复连接 / 下一次修改时重试。
      Object.keys(patch).forEach(k => { if (!(k in uiPending) && PREFS.ui[k] === patch[k]) uiPending[k] = patch[k]; });
      if (!uiSaveFailed) toast('设置暂未保存到本机文件，恢复连接或继续修改设置后会重试', 'warn', 7000);
      uiSaveFailed = true;
      if (!uiTimer) uiTimer = setTimeout(flushUiSave, 5000);
      return false;
    }
  }

  /**
   * 把还留在浏览器里的老数据补写到 data/config。
   *
   * 老版本这些东西只存浏览器，升级上来的用户后端是空的 —— 补一次，
   * 之后就统一以后端那份为准了。
   */
  function migrateLocalToPrefs() {
    const KEYS = ['bilifav.tags', 'bilifav.itemTags', 'bilifav.theme',
      'bilifav.pageSize', 'bilifav.drawerW', 'bilifav.boxW', 'bilifav.filterScope', 'bilifav.lastFolder', 'bilifav.skin'];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (/^bilifav\.(?:tags|itemTags)\.\d+$/.test(key)) KEYS.push(key);
    }
    const ui = {};
    KEYS.forEach((k) => {
      try {
        const v = localStorage.getItem(k);
        if (v != null) ui[k] = v;
      } catch (_) { /* 读不到就算了 */ }
    });
    if (!Object.keys(ui).length) return;
    PREFS.ui = ui;
    Object.entries(ui).forEach(([key,value]) => queueUiSave(key,value));
  }

  /** 这条视频在 B 站的地址 */
  function biliUrlOf(it) {
    if (!it) return '';
    if (it.bvid) return `https://www.bilibili.com/video/${it.bvid}`;
    if (it.avid) return `https://www.bilibili.com/video/av${it.avid}`;
    return '';
  }

  /**
   * 用**系统默认浏览器**打开一个外链（详情里的「去 B 站看」、右键的「打开」）。
   *
   * 为什么不直接 window.open：界面平时跑在 Edge WebView2 / Edge 应用模式里，
   * 前端这一下开出来的还是 Edge 的小窗 —— 用户要的是"我平时用的那个浏览器"。
   * 所以交给后台调用系统 URL 关联。
   *
   * 后台只有 /api/open-external 一个口子，而且它只放 B 站域名（见 server.py）。
   * 静态预览由点击同步打开新标签，不经过假接口。
   */
  async function openExternal(url) {
    if (!url) { toast('这条没有可打开的链接', 'warn'); return; }
    if (window.BILIFAV_PREVIEW) { openPreviewLink(url); return; }
    try {
      const d = await api('/api/open-external', { url });
      if (d && d.ok) { toast('已交给系统默认浏览器打开', 'ok', 2600); return; }
      toast((d && d.error) || '没能打开浏览器', 'err', 5000);
      return;
    } catch (err) {
      // 后端明确回了理由（比如"只允许打开 B 站的链接"）：照实说，不退回去
      if (err && err.payload) { toast(err.message, 'warn', 5000); return; }
      // 连不上后台（静态预览）：退回浏览器自己开
    }
    window.open(url, '_blank', 'noopener');
  }

  function openPreviewLink(url) {
    let target;
    try { target = new URL(url, location.href); } catch (_) { toast('链接无效', 'warn'); return; }
    const host = target.hostname.toLowerCase();
    const ownPage = target.href === location.href;
    if (!ownPage && (!['http:', 'https:'].includes(target.protocol)
      || !(host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv' || host.endsWith('.b23.tv')))) {
      toast('只允许打开当前界面或 B 站链接', 'warn'); return;
    }
    // 保留真实点击的用户手势；不能先等待异步假接口再弹出窗口。
    const opened = window.open(target.href, '_blank');
    if (opened) { try { opened.opener = null; } catch (_) {} return; }
    openModal({title: '打开链接', desc: '浏览器拦截了新窗口，可以点击下面的链接打开。',
      body: `<a href="${esc(target.href)}" target="_blank" rel="noopener noreferrer">点击打开页面</a>`,
      okText: '关闭', showCancel: false});
  }

  /**
   * 复制一段文字到剪贴板。
   *
   * 优先用剪贴板 API（127.0.0.1 算安全上下文，桌面版和网页版都吃得到）；
   * 预览页是 file:// 拿不到权限，就退回老办法；再不行把内容打到控制台，
   * 至少别让用户白点一下。
   */
  async function copyText(text, what) {
    if (!text) { toast('这条没有可复制的链接', 'warn'); return false; }
    try {
      await navigator.clipboard.writeText(text);
      toast(`已经复制${what}了`, 'ok');
      return true;
    } catch (_) { /* 往下退 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) { toast(`已经复制${what}了`, 'ok'); return true; }
    } catch (_) { /* 还是不行 */ }
    console.log(text);
    toast('浏览器不给复制权限，内容已经打到控制台了', 'warn', 7000);
    return false;
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    return String(n);
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = (x) => String(x).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }

  function fmtClock(ts) {
    const d = ts ? new Date(Number(ts) * 1000) : new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function fmtElapsed(sec) {
    sec = Math.max(0, Math.floor(sec));
    if (sec < 60) return sec + ' 秒';
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return `${m} 分 ${s} 秒`;
    return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
  }

  /* ---------------------------------------------------------------- 请求 */
  async function api(path, body, method) {
    const opts = {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { 'X-Token': TOKEN },
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = typeof body === 'string' ? body : JSON.stringify(body || {});
    }
    let resp;
    try {
      resp = await fetch(path, opts);
    } catch (err) {
      throw new Error('连不上本机的服务了，程序是不是被关掉了？');
    }
    let data;
    try {
      data = await resp.json();
    } catch (err) {
      throw new Error(`服务返回了看不懂的东西（HTTP ${resp.status}）`);
    }
    if (!resp.ok || data.ok === false) {
      const msg = data.error || data.message || `请求失败（HTTP ${resp.status}）`;
      const e = new Error(msg);
      e.reason = data.reason;
      e.payload = data;
      throw e;
    }
    return data;
  }

  /* ---------------------------------------------------------------- 提示 */
  /**
   * 弹一条提示。
   *
   * 带 id 的话是**原地更新**同一条（进度提示用）：连着调十次只会看到一条
   * 数字在变，而不是十条堆在一起。ms 传 0 表示先别自动消失。
   */
  function toast(text, kind = 'info', ms = 3600, id = '') {
    const box = $('#toasts');
    let el = id ? box.querySelector(`[data-toast="${id}"]`) : null;
    if (!el) {
      el = document.createElement('div');
      if (id) el.dataset.toast = id;
      box.appendChild(el);
    }
    el.className = `toast ${kind}`;
    const icon = { ok: '✅', err: '😵', info: '🐳', warn: '⚠️' }[kind] || '🐳';
    el.innerHTML = `<span>${icon}</span><span>${esc(text)}</span>`;
    if (el._timer) { clearTimeout(el._timer); el._timer = null; }
    if (ms > 0) {
      el._timer = setTimeout(() => {
        el._timer = null;
        el.classList.add('out');
        setTimeout(() => el.remove(), 280);
      }, ms);
    }
  }

  /* ------------------------------------------------------------ 弹窗 */
  let modalResolve = null;
  let modalCollect = null;

  /**
   * 打开弹窗。
   * collect 是"点确定时怎么取值"的回调：返回 false 表示校验没过、不关窗；
   * 返回别的值就作为 openModal 的结果。
   */
  /**
   * 弹一个窗。
   *
   * 右下角的按钮组两种给法：
   *   · 默认 —— 「算了 / 确定」，用 okText / cancelText / showCancel 调
   *   · 自定义 —— 传 `buttons: [{ text, kind: 'plain'|'solid', onClick }]`，
   *     `kind: 'plain'` 是白底、`'solid'` 是主色实心（跟「提交改动」一个样）。
   *
   * 右上角永远有个 ×，所以需要「只是展示」的窗，把 showCancel 关掉就行，不用再加个关闭键。
   */
  function openModal({ title, desc, body, okText = '确定', cancelText = '算了',
                       showCancel = true, collect = null, buttons = null, onEnter = null, help = null }) {
    $('#modal-title').textContent = title || '';
    if (help) $('#modal-title').insertAdjacentHTML('beforeend', sectionHelpHtml(help));
    $('#modal-desc').innerHTML = desc || '';
    $('#modal-body').innerHTML = body || '';
    const acts = $('#modal-actions');
    if (Array.isArray(buttons) && buttons.length) {
      // 自定义按钮也可以带 id —— 这样「取消 / 确定」这类角色仍能用老选择器找到，
      // 快捷键和自测脚本都不用跟着改。
      acts.innerHTML = buttons.map((b, i) =>
        `<button class="${b.kind === 'plain' ? 'btn-skew' : 'btn-solid'}" data-mbtn="${i}"`
        + `${b.id ? ` id="${b.id}"` : ''}${b.disabled ? ' disabled' : ''}`
        + `><span>${esc(b.text)}</span></button>`).join('');
      modalButtons = buttons;
    } else {
      acts.innerHTML =
        `<button class="btn-skew" id="modal-cancel" data-mbtn="cancel"${showCancel ? '' : ' style="display:none"'}><span>${esc(cancelText)}</span></button>`
        + `<button class="btn-solid" id="modal-ok" data-mbtn="ok"><span>${esc(okText)}</span></button>`;
      modalButtons = null;
    }
    $('#modal-mask').classList.add('show');
    // 弹窗开着的时候，任务面板先让到弹窗下面（见 style.css 里的 body.modal-open）
    document.body.classList.add('modal-open');
    modalCollect = collect;
    modalOnEnter = onEnter;
    return new Promise((resolve) => { modalResolve = resolve; });
  }

  let modalButtons = null;
  let modalOnEnter = null;

  // 在弹窗的输入框里按回车 = 走这个窗的"主动作"（建标签之类的）
  $('#modal-mask').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || typeof modalOnEnter !== 'function') return;
    const tag = ((e.target || {}).tagName || '').toLowerCase();
    if (tag !== 'input') return;
    e.preventDefault();
    modalOnEnter();
  });

  $('#modal-actions').addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-mbtn]');
    if (!b || b.disabled) return;
    const which = b.dataset.mbtn;
    if (which === 'ok') { okClicked(); return; }
    if (which === 'cancel') { closeModal(false); return; }
    const def = modalButtons && modalButtons[Number(which)];
    if (!def) return;
    if (typeof def.onClick === 'function') def.onClick();
    else closeModal(true);
  });

  // 右上角那个 ×，等同于点「算了」
  $('#modal-x').addEventListener('click', () => closeModal(false));

  function closeModal(value) {
    $('#modal-mask').classList.remove('show');
    document.body.classList.remove('modal-open');
    modalCollect = null;
    if (modalResolve) { modalResolve(value); modalResolve = null; }
  }

  function okClicked() {
    if (modalCollect) {
      const value = modalCollect();
      if (value === false) return;   // 校验没过，窗不关
      closeModal(value);
      return;
    }
    closeModal(true);
  }

  function confirmBox(title, desc, okText = '确定') {
    return openModal({ title, desc, okText }).then((v) => v === true);
  }

  /* ---------------------------------------------------------------- 状态 */
  const S = {
    account: null,
    folders: [],
    copy: { source: null, target: null },
    sort: {
      folder: null,
      items: [],        // 线上原本就有的条目
      extra: [],        // 界面上新加的、还没提交的条目
      original: [],
      order: [],
      deleted: new Set(),   // 标记了要删除的 key
      stack: [],            // 本收藏夹完整本地快照，最多 60 步
      redo: [],             // 重做栈
      filter: '',
      /*
        关键词筛选的范围：
          'page'   = 只筛当前这一页（默认，跟以前一样）
          'folder' = 整个收藏夹一起筛（跨页，结果一次铺出来）
        只影响关键词；标签筛选和日期筛选还是老规矩。
      */
      filterScope: 'page',
      dateFrom: 0,          // 日期筛选：收藏时间 ≥ 这个时间戳（0 = 不限）
      dateTo: 0,            // 日期筛选：收藏时间 ≤ 这个时间戳（0 = 不限）
      editing: false,       // false = 预览（只读），true = 整理
      pageSize: 30,         // 默认「分页」：一页 30 个；0 = 平铺
      lastBoxSize: 30,      // 从「平铺」切回「分页」时用这个数
      page: 1,              // 当前第几页
      multi: false,         // 多选模式：点卡片是选中，选完右键批量处理
      picked: new Set(),    // 多选选中的 key（跨页保留）
      locked: new Set(),    // 锁定的页号（1 起）：锁住的页不会被挤开
      sortDim: { key: '', dir: 0, snapshot: null },   // 排序按钮的三态（升/降/还原）
      anchor: '',           // 多选时最近点过的那张（Shift 连选要从它开始）
      /*
        完整列表读取期间的标志。
        旧缓存或尚未返回的列表不能当作已核实的线上基线，所以这期间要把编辑锁住
        （拖拽、排序、提交都拦掉），免得用户对着半份列表拖来拖去。
      */
      loading: false,
      loadedCount: 0,
    },
    tags: [],               // 自建标签 [{ id, name, color }]
    itemTags: new Map(),    // 视频 key -> Set(标签 id)
    tagFilter: new Set(),   // 当前选中的标签（多个取并集）
    task: { since: 0, timer: null, busy: false, lastSeq: 0, stages: {}, state: 'idle' },
    qr: { timer: null, key: null, state: '' },
  };

  /* ================================================================ 路由 */
  const PAGES = ['copy', 'sort', 'menu', 'login'];

  function go(page, silent) {
    if (!PAGES.includes(page)) page = 'menu';
    // 这两块面板属于浏览页，离开时一起收回，避免挡住菜单。
    if (page !== 'sort') { closeDetail(); toggleBoxPanel(false); }
    $$('.navitem').forEach((el) => el.classList.toggle('on', el.dataset.page === page));
    $$('.page').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
    const sc = $('.page.active .scroll');
    if (sc) sc.scrollTop = 0;
    if (!silent) {
      try { history.replaceState(null, '', `#${page}`); } catch (_) {}
    }
    // 任务记录现在并进菜单页了，进菜单时顺手刷一下
    if (page === 'menu') { loadHistory(); renderShortcutRows(); applyFolds(); renderTaskViews(lastTaskData); }
  }

  $$('.navitem').forEach((el) => el.addEventListener('click', () => go(el.dataset.page)));
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-goto]');
    if (el) { go(el.dataset.goto); return; }
    if (e.target.closest && e.target.closest('[data-open-drawer]')) { toggleFavDrawer(true); return; }
    // 「任务记录」这类快捷入口：滚到对应面板
    const sc = e.target.closest && e.target.closest('[data-scroll-to]');
    if (sc) {
      const target = $(sc.dataset.scrollTo);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
  window.addEventListener('hashchange', () => {
    const want = (location.hash || '').replace('#', '');
    if (PAGES.includes(want)) go(want, true);
  });

  /* ============================================================== 账号 */
  // Failed user/UP images reveal the CSS placeholder instead of a broken-image icon.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.matches('.big-avatar > img, .dt-face > img, .up-face > img')) img.remove();
  }, true);
  function renderAccount() {
    const a = S.account;
    const loggedIn = !!(a && a.is_login);
    if (loggedIn) {
      $('#acct-name').textContent = a.uname || '已登录';
      $('#acct-sub').textContent = `UID ${a.mid}`;
      // 没有头像就留空 —— 占位图交给 CSS 的 background-image，
      // 免得 JS 里拼相对路径在别的目录（比如预览页）404
      $('#acct-face').innerHTML = a.face
        ? `<img src="${esc(httpsify(a.face))}" alt="" referrerpolicy="no-referrer">` : '';
      $('#acct-dot').className = 'dot on';
      $('#acct-tag').textContent = '已连接';
      $('#login-status').className = 'alert ok';
      $('#login-status-text').innerHTML = `已经登录啦，现在是 <b>${esc(a.uname)}</b>（UID ${a.mid}），本鱼听你指挥～`;
      $('#dash-greet').textContent = `你好呀 ${a.uname}，今天想搬点什么？`;
    } else {
      $('#acct-name').textContent = '还没登录';
      $('#acct-sub').textContent = '点这里去登录';
      $('#acct-face').innerHTML = '';
      $('#acct-dot').className = 'dot off';
      $('#acct-tag').textContent = '未连接';
      $('#login-status').className = 'alert warn';
      $('#login-status-text').textContent = '还没登录哦，本鱼不知道要帮谁搬东西呢…';
      $('#dash-greet').textContent = '本鱼已经准备好啦，先去登录一下？';
    }
    $('#login-logout').classList.toggle('hidden', !loggedIn);
  }

  async function refreshAccount() {
    try {
      const data = await api('/api/account');
      S.account = data.is_login ? data : null;
    } catch (err) {
      S.account = null;
    }
    renderAccount();
    return S.account;
  }

  async function requireLogin() {
    if (S.account && S.account.is_login) return true;
    const ok = await confirmBox(
      '还没登录呢 🐳',
      '搬运和整理都要往你自己的收藏夹里写东西，所以得先登录一下。<br>扫码登录不需要密码，很安全的～',
      '去登录'
    );
    if (ok) go('login');
    return false;
  }

  /* =========================================================== 扫码登录 */
  async function loadQr() {
    const box = $('#qr-box');
    const mask = $('#qr-mask');
    mask.classList.remove('show');
    box.querySelector('.spin')?.remove();
    box.querySelector('svg')?.remove();
    const spin = document.createElement('div');
    spin.className = 'spin';
    box.insertBefore(spin, mask);
    $('#qr-hint').textContent = '正在跟 B 站要二维码…';

    try {
      const data = await api('/api/login/qr');
      spin.remove();
      box.insertBefore(
        document.createRange().createContextualFragment(data.svg),
        mask
      );
      S.qr.key = data.key;
      S.qr.state = 'waiting';
      $('#qr-hint').textContent = '用 B 站 App 扫一扫～';
      startQrPolling();
    } catch (err) {
      spin.remove();
      $('#qr-hint').textContent = '二维码没拿到：' + err.message;
      toast(err.message, 'err');
    }
  }

  function qrExpired() {
    const mask = $('#qr-mask');
    mask.innerHTML = '<div><div style="font-size:26px">😴</div><div style="margin-top:8px">二维码过期啦<br><b>点这里换一张</b></div></div>';
    mask.classList.add('show');
    stopQrPolling();
  }

  function stopQrPolling() {
    if (S.qr.timer) { clearInterval(S.qr.timer); S.qr.timer = null; }
  }

  function startQrPolling() {
    stopQrPolling();
    S.qr.timer = setInterval(async () => {
      if (!S.qr.key) return;
      try {
        const data = await api(`/api/login/qr/poll?key=${encodeURIComponent(S.qr.key)}`);
        const st = data.state;
        if (st === 'success') {
          stopQrPolling();
          S.account = data.account;
          renderAccount();
          toast(`登录成功，欢迎回来 ${data.account.uname}～`, 'ok');
          $('#qr-hint').textContent = '登录成功！';
          await refreshFolders();
          setTimeout(() => go('dash'), 700);
        } else if (st === 'scanned') {
          $('#qr-hint').textContent = '扫到啦！在手机上点一下确认～';
        } else if (st === 'expired') {
          qrExpired();
        } else {
          $('#qr-hint').textContent = data.hint || '等你扫呢～';
        }
      } catch (err) {
        /* 轮询失败不打断，下一次继续 */
      }
    }, 1800);
  }

  $('#qr-refresh').addEventListener('click', loadQr);
  $('#qr-mask').addEventListener('click', () => { if (S.qr.state !== 'success') loadQr(); });

  /* 「退出登录」整行都是入口：点哪儿都行，键盘回车/空格也认 */
  async function doLogout() {
    if (!S.account) { toast('现在本来就是没登录的状态', 'warn'); return; }
    const ok = await confirmBox(
      '确定要退出登录吗？',
      '本机保存的登录信息会被删掉，下次要用得重新扫码或者重新贴 Cookie。<br>收藏夹里的东西不受影响。',
      '退出登录'
    );
    if (!ok) return;
    try {
      await api('/api/logout', {});
      S.account = null;
      S.folders = [];
      S.copy = { source: null, target: null };
      renderAccount();
      renderFolders();
      renderSortFolders();
      renderFavList();
      renderTopStats();
      toast('已经退出啦，本机保存的登录信息也清掉了', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  $('#login-logout').addEventListener('click', doLogout);

  $('#cookie-toggle').addEventListener('click', () => {
    $('#cookie-panel').classList.toggle('hidden');
  });

  $('#cookie-submit').addEventListener('click', async () => {
    const raw = $('#cookie-input').value.trim();
    if (!raw) { toast('先贴点东西进来呀', 'warn'); return; }
    try {
      const data = await api('/api/login/cookie', { cookie: raw });
      S.account = data.account;
      renderAccount();
      toast(`登录成功，欢迎回来 ${data.account.uname}～`, 'ok');
      $('#cookie-input').value = '';
      await refreshFolders();
    } catch (err) { toast(err.message, 'err', 6000); }
  });

  /* ============================================================ 收藏夹 */
  /** 按本机记的顺序排一遍；没记过的排在后面，保持原有先后 */
  function applyFolderOrder(list) {
    const order = PREFS.folder_order;
    if (!Array.isArray(order) || !order.length) return list;
    const rank = new Map(order.map((id, i) => [Number(id), i]));
    return list.slice().sort((a, b) => {
      const ra = rank.has(a.media_id) ? rank.get(a.media_id) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.media_id) ? rank.get(b.media_id) : Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
  }

  async function refreshFolders() {
    if (!S.account) { S.folders = []; renderFolders(); renderSortFolders(); return; }
    try {
      const data = await api('/api/folders/mine');
      S.folders = applyFolderOrder(data.folders || []);
    } catch (err) {
      S.folders = [];
      toast('读收藏夹列表失败：' + err.message, 'err');
    }
    renderFolders();
    renderSortFolders();
    renderTopStats();
    renderFavList();
  }

  function renderFolders() {
    const box = $('#copy-tgt-list');
    const keyword = ($('#copy-tgt-search').value || '').trim().toLowerCase();
    if (!S.account) {
      box.innerHTML = '<div class="empty"><span class="em">🔑</span><p>登录之后才能看到你的收藏夹哦</p></div>';
      return;
    }
    let list = S.folders;
    if (keyword) list = list.filter((f) => f.title.toLowerCase().includes(keyword));
    if (!list.length) {
      box.innerHTML = `<div class="empty"><span class="em">🫧</span><p>${S.folders.length ? '没搜到匹配的收藏夹' : '你还没有创建过收藏夹，点上面的「新建」建一个吧'}</p></div>`;
      return;
    }
    box.innerHTML = list.map((f) => `
      <div class="folder-item ${S.copy.target === f.media_id ? 'sel' : ''}" data-tgt="${f.media_id}">
        <b>${f.privacy === 1 ? '🔒 ' : ''}${esc(f.title)}</b>
        <span>${f.count} 条 · ID ${f.media_id}</span>
      </div>`).join('');
    $$('[data-tgt]', box).forEach((el) => el.addEventListener('click', () => {
      S.copy.target = Number(el.dataset.tgt);
      renderFolders();
      updateCopySummary();
    }));
  }

  $('#copy-tgt-search').addEventListener('input', renderFolders);
  $('#copy-tgt-refresh').addEventListener('click', async () => {
    if (!await requireLogin()) return;
    await refreshFolders();
    toast('收藏夹列表刷新好了', 'ok');
  });

  async function createFolderFlow() {
    if (!await requireLogin()) return null;
    const ok = await openModal({
      title: '新建一个收藏夹',
      desc: '建好了可以直接拿它当搬运目标，也能马上进去整理。',
      body: `
        <div class="field"><label>名字</label><input type="text" id="new-folder-title" placeholder="比如：宝藏 UP 的教程合集" maxlength="40"></div>
        <label class="switch"><input type="checkbox" id="new-folder-private"><span class="track"></span>
          <span class="txt">设为私密<small>只有自己能看见</small></span></label>`,
      okText: '建吧',
    });
    if (!ok) return null;
    const title = ($('#new-folder-title').value || '').trim();
    if (!title) { toast('得起个名字呀', 'warn'); return null; }
    try {
      const data = await api('/api/folder/create', {
        title,
        privacy: $('#new-folder-private').checked ? 1 : 0,
      });
      toast(`「${title}」建好啦`, 'ok');
      await refreshFolders();
      return data.folder || null;
    } catch (err) { toast(err.message, 'err', 6000); return null; }
  }

  $('#copy-tgt-new').addEventListener('click', async () => {
    const folder = await createFolderFlow();
    if (!folder || !folder.media_id) return;
    S.copy.target = folder.media_id;
    renderFolders();
    updateCopySummary();
  });

  /* ============================================================ 搬运页 */
  $('#copy-src-btn').addEventListener('click', resolveSource);
  $('#copy-src-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') resolveSource(); });

  /* ---------------- 从 UP 主找源收藏夹 ---------------- */
  /*
    填 UID（那串数字）直接查人，填别的当昵称搜。
    选定之后列他「公开」的收藏夹 —— 用的是 created/list-all，私密的本来就不在里面。
  */
  let upUsers = [];
  const upCache = new Map();   // mid -> 那个人的公开收藏夹

  async function doUpSearch() {
    const box = $('#up-result');
    const raw = ($('#up-input').value || '').trim();
    if (!raw) { toast('填个 UID 或者昵称吧', 'warn'); return; }
    box.innerHTML = '<div class="hint">正在找这个人…</div>';
    upUsers = [];
    try {
      const data = await api(`/api/up/search?input=${encodeURIComponent(raw)}`);
      upUsers = data.users || [];
      if (!upUsers.length) {
        box.innerHTML = `<div class="hint">${esc(data.hint || '没找到这个人')}</div>`;
        return;
      }
      box.innerHTML = `<div class="up-list">${upUsers.map(upCardHtml).join('')}</div>`;
      if (upUsers.length === 1) pickUp(upUsers[0]);   // 直查 UID 就一个，直接展开
    } catch (err) {
      box.innerHTML = `<div class="hint">${esc(err.message)}</div>`;
    }
  }

  function upCardHtml(u) {
    const v = u.official_type
      ? `<i class="vbadge${u.official_type === 2 ? ' org' : ''}" title="${esc(u.official || '认证')}">V</i>` : '';
    const vip = u.vip ? '<i class="vipbadge">大会员</i>' : '';
    return `<div class="up-card" data-up="${u.mid}">
      <div class="up-face">${u.face ? `<img src="${esc(httpsify(u.face))}" alt="" referrerpolicy="no-referrer">` : ''}</div>
      <div class="up-main">
        <div class="nm"><b>${esc(u.name)}</b>${v}${vip}</div>
        <div class="meta-line"><span>UID ${u.mid}</span><span>${fmtNum(u.fans)} 粉丝</span></div>
        ${u.sign ? `<div class="sign">${esc(u.sign)}</div>` : ''}
      </div>
      <span class="up-folder-go" style="color:var(--blue);font-size:11px;flex:none">看他收藏夹 →</span>
    </div>`;
  }

  async function pickUp(u) {
    $$('.up-card').forEach((el) => el.classList.toggle('on', Number(el.dataset.up) === u.mid));
    let box = $('#up-folders');
    if (!box) {
      $('#up-result').insertAdjacentHTML('beforeend', '<div class="up-folders" id="up-folders"></div>');
      box = $('#up-folders');
    }
    if (upCache.has(u.mid)) { renderUpFolders(upCache.get(u.mid)); return; }
    box.innerHTML = '<div class="hint">正在翻他的公开收藏夹…</div>';
    try {
      const data = await api(`/api/up/folders?mid=${u.mid}`);
      const folders = data.folders || [];
      upCache.set(u.mid, folders);
      renderUpFolders(folders);
    } catch (err) {
      box.innerHTML = `<div class="hint">${esc(err.message)}</div>`;
    }
  }

  function renderUpFolders(folders) {
    const box = $('#up-folders');
    if (!box) return;
    if (!folders.length) {
      box.innerHTML = '<div class="hint">这个人没有公开的收藏夹</div>';
      return;
    }
    box.innerHTML = folders.map((f) => `
      <div class="up-folder" data-up-folder="${f.media_id}">
        <span>📁</span>
        <b>${esc(f.title)}</b>
        <span class="cnt">${f.count} 条</span>
        <span class="go">选它</span>
      </div>`).join('');
  }

  /** 直接把某个 media_id 当源：还是走一遍 resolve，好把预览也拿到 */
  async function pickSourceFolder(mediaId) {
    const box = $('#copy-src-result');
    box.innerHTML = `<div class="alert info"><img class="ico-img" src="${READING_IMAGE}" alt=""><div>正在读这个收藏夹…</div></div>`;
    try {
      const data = await api('/api/folder/resolve', { input: String(mediaId) });
      S.copy.source = data.folder;
      renderSource(data.folder, data.preview || []);
      updateCopySummary();
      toast(`源选成「${data.folder.title}」了`, 'ok');
    } catch (err) {
      S.copy.source = null;
      updateCopySummary();
      box.innerHTML = `<div class="alert err"><span class="ico">😵</span><div>${esc(err.message)}</div></div>`;
    }
  }

  $('#up-btn').addEventListener('click', doUpSearch);
  $('#up-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doUpSearch(); });
  $('#up-result').addEventListener('click', (e) => {
    const card = e.target.closest && e.target.closest('[data-up]');
    if (card) {
      const u = upUsers.find((x) => x.mid === Number(card.dataset.up));
      if (u) pickUp(u);
      return;
    }
    const folder = e.target.closest && e.target.closest('[data-up-folder]');
    if (folder) pickSourceFolder(Number(folder.dataset.upFolder));
  });

  async function resolveSource() {
    const raw = $('#copy-src-input').value.trim();
    if (!raw) { toast('先贴个链接或者 ID 进来～', 'warn'); return; }
    const box = $('#copy-src-result');
    box.innerHTML = `<div class="alert info"><img class="ico-img" src="${READING_IMAGE}" alt=""><div>正在翻这个收藏夹…</div></div>`;
    try {
      const data = await api('/api/folder/resolve', { input: raw });
      S.copy.source = data.folder;
      renderSource(data.folder, data.preview || []);
      updateCopySummary();
    } catch (err) {
      S.copy.source = null;
      updateCopySummary();
      box.innerHTML = `<div class="alert err"><span class="ico">😵</span><div>${esc(err.message)}</div></div>`;
    }
  }

  function renderSource(folder, preview) {
    const previewHtml = preview.length ? `
      <div style="margin-top:12px">
        <div class="hint">前 ${preview.length} 条长这样：</div>
        <div class="mini-list" style="margin-top:7px">
          ${preview.map((it, i) => `
            <div class="mini-item">
              <span class="idx">${i + 1}</span>
              <span class="tt">${esc(it.title || '(无标题)')}</span>
              <span class="up">${esc(it.upper || '')}</span>
            </div>`).join('')}
        </div>
      </div>` : '';

    $('#copy-src-result').innerHTML = `
      <div class="src-result">
        <div class="src-thumb">📚</div>
        <div class="src-txt">
          <b>${esc(folder.title)}</b>
          <span>${folder.count} 条 · UP：${esc(folder.upper || '未知')} · ID ${folder.media_id}</span>
        </div>
        <span class="tag-ok">已读取</span>
      </div>${previewHtml}`;
  }

  function updateCopySummary() {
    const src = S.copy.source;
    const tgt = S.folders.find((f) => f.media_id === S.copy.target);
    const btn = $('#copy-start');
    const box = $('#copy-summary');
    if (src && tgt) {
      btn.disabled = false;
      box.innerHTML = `准备把 <b>${esc(src.title)}</b>（${src.count} 条）搬进 <b>${esc(tgt.title)}</b>`;
    } else {
      btn.disabled = true;
      box.textContent = !src ? '还没选源收藏夹' : '还没选目标收藏夹';
    }
  }

  $('#copy-start').addEventListener('click', async () => {
    if (!await requireLogin()) return;
    const src = S.copy.source, tgt = S.folders.find((f) => f.media_id === S.copy.target);
    if (!src || !tgt) { toast('源和目标都得选好', 'warn'); return; }

    const ok = await confirmBox(
      '要开始搬了哦 🐳',
      `把「${esc(src.title)}」里的内容搬进你的「${esc(tgt.title)}」。<br><br>
       搬的过程中可以随时暂停或者停掉，进度会存着，下次接着跑。<br>
       因为要限速，几百条大概得十几分钟，别着急～`,
      '出发'
    );
    if (!ok) return;

    try {
      await api('/api/copy/start', {
        source_media_id: src.media_id,
        target_media_id: tgt.media_id,
        options: {
          content_type: Number($('#copy-opt-type').value),
          order: $('#copy-opt-order').value,
          delay: Number($('#copy-opt-delay').value) || 1.5,
          prescan_target: $('#copy-opt-prescan').checked,
          skip_invalid: $('#copy-opt-skipinvalid').checked,
        },
      });
      toast('搬起来了！右上角「任务」里能看进度～', 'ok');
      resetTaskView();
      toggleTaskPop(true);
    } catch (err) { toast(err.message, 'err', 6000); }
  });

  /* ============================================================ 整理页 */
  function renderSortFolders() {
    const box = $('#sort-folder-list');
    if (!box) return;
    const html = S.account
      ? '<div class="empty"><span class="em">📁</span><p>从抽屉里挑一个来整理，也可以按里面的视频搜</p>'
        + '<button class="tbtn primary" data-open-drawer="1" style="margin-top:10px">打开收藏夹列表</button></div>'
      : '<div class="empty"><span class="em">🔑</span><p>先登录，才能看到自己的收藏夹</p>'
        + '<button class="tbtn primary" data-goto="login" style="margin-top:10px">去登录</button></div>';
    box.innerHTML = html;
  }

  /**
   * 列表上方挂一条"先显示了前 N 条、还在读剩下的"的提示。
   *
   * 挂在 #sort-list **外面** —— 里面每次重绘都会被清空，挂里面会一闪就没。
   * 完整数据回来时由调用方主动移除（见 loadSortFolder）。
   */
  function showLoadingHint(shown, hasMore) {
    const old = $('#sort-loading-hint');
    if (old) old.remove();
    const list = $('#sort-list');
    if (!list || !list.parentNode) return;
    // 只有一页的话没什么可等的，不用打扰
    if (!hasMore) return;
    const el = document.createElement('div');
    el.id = 'sort-loading-hint';
    el.className = 'loading-hint';
    el.innerHTML = '<span class="spin"></span>'
      + `<span>先显示了前 <b>${shown}</b> 条，正在读剩下的…（这期间先别动，读完就能编辑了）</span>`;
    list.parentNode.insertBefore(el, list);
  }

  /** 完整数据到了，把那条提示收掉 */
  function clearLoadingHint() {
    const el = $('#sort-loading-hint');
    if (el) el.remove();
  }

  /** 缓存铺上时的那条提示：告诉用户这是旧的、正在刷新 */
  function showCacheHint(age, refreshing = true) {
    const old = $('#sort-loading-hint');
    if (old) old.remove();
    const list = $('#sort-list');
    if (!list || !list.parentNode) return;
    let when;
    if (age < 60) when = '刚刚';
    else if (age < 3600) when = `${Math.floor(age / 60)} 分钟前`;
    else if (age < 86400) when = `${Math.floor(age / 3600)} 小时前`;
    else when = `${Math.floor(age / 86400)} 天前`;
    const el = document.createElement('div');
    el.id = 'sort-loading-hint';
    el.className = 'loading-hint';
    el.innerHTML = (refreshing ? '<span class="spin"></span>' : '')
      + `<span>${refreshing ? `先显示${when}的缓存，正在刷新…` : `已打开${when}的缓存；提交前会核对线上内容。`}</span>`
      + `<button class="lh-btn" id="sort-cache-reload">${refreshing ? '先使用缓存' : '重新读一遍'}</button>`;
    list.parentNode.insertBefore(el, list);
    const btn = $('#sort-cache-reload');
    if (btn) btn.addEventListener('click', () => {
      clearLoadingHint();
      const mid = S.sort.folder && S.sort.folder.media_id;
      if (mid) loadSortFolder(mid, !refreshing);
    });
  }

  /* 完整缓存直接打开并标明来源；只有首次打开或主动刷新才读取线上。
     缓存基线在提交前核对，避免每次切换都等待网络和重试。 */
  let sortLoadVersion = 0;
  let sortLoadPending = 0;
  let sortReadQueue = Promise.resolve();
  function readSortFolderRemote(mediaId, isCurrent) {
    // 快速连点时只保留最后一个等待中的读取；不并发排队拉取已经离开的收藏夹。
    const request = sortReadQueue.catch(() => {}).then(() => isCurrent()
      ? api(`/api/folder/items?media_id=${mediaId}`) : null);
    sortReadQueue = request.catch(() => {});
    return request;
  }
  async function loadSortFolder(mediaId, force = false) {
    if (sortModeSaving) { toast('正在保存整理，请稍等', 'info'); return; }
    if (force && sortLoadPending && Number(S.sort.folder?.media_id) === Number(mediaId)) {
      toast('这个收藏夹正在读取，请稍等；已有缓存时可以先使用缓存', 'info'); return;
    }
    const version = ++sortLoadVersion;
    if (!await requireLogin()) return;
    const isCurrent = () => version === sortLoadVersion;
    if (!isCurrent()) return;
    if (S.sort.folder && !S.sort.loading && !sortWriteBusy() && localDraftNeeded()
      && (draftTimer || currentDraftSignature() !== draftSavedSignature)) {
      if (!await saveDraftNow() || !isCurrent()) return;
    }
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    sortLoadPending = version;
    const meta = S.folders.find(f => Number(f.media_id) === Number(mediaId));
    $('#sort-picker').classList.add('hidden');
    $('#sort-workspace').classList.remove('hidden');
    $('#sort-folder-title').textContent = meta?.title || `收藏夹 ${mediaId}`;
    S.sort.loading = true;
    S.sort.loadedCount = 0;
    S.sort.fromCache = false;
    S.sort.folder = meta || {media_id: mediaId, title: `收藏夹 ${mediaId}`};
    resetSortMode();
    resetMulti(); S.tagFilter.clear();
    S.sort.filter = ''; S.sort.stack = []; S.sort.redo = []; S.sort.locked = new Set();
    $('#sort-filter').value = ''; resetDateFilter(true);
    clearLoadingHint();
    $('#sort-list').innerHTML = `<div class="empty"><img class="em-img em-img-lg" src="${READING_IMAGE}" alt="">
      <p>正在读取收藏夹…</p><p class="plain">首次读取或刷新需要等待 B 站返回，已缓存的收藏夹会优先打开。</p></div>`;
    let cached = null;
    try { cached = await api(`/api/folder/cache?media_id=${mediaId}`); } catch (_) {}
    if (!isCurrent()) return;
    const cacheUsable = cached?.hit && Array.isArray(cached.items);
    const fresh = !force && cacheUsable;
    if (cacheUsable && !fresh) {
      S.sort.items = cached.items; S.sort.original = cached.items.map(it => it.key);
      S.sort.order = S.sort.original.slice(); S.sort.extra = []; S.sort.deleted = new Set();
      renderSortList(); showCacheHint(cached.age || 0);
    }
    try {
      const data = fresh ? {folder: {...cached.folder, ...meta}, items: cached.items}
        : await readSortFolderRemote(mediaId, isCurrent);
      if (!isCurrent() || !data) return;
      clearLoadingHint();
      S.sort.folder = {...data.folder, media_id: Number(mediaId)};
      S.sort.items = data.items || [];
      S.sort.extra = []; S.sort.deleted = new Set();
      S.sort.original = S.sort.items.map(it => it.key); S.sort.order = S.sort.original.slice();
      S.sort.stack = []; S.sort.redo = []; S.sort.locked = new Set();
      S.sort.filter = ''; S.sort.fromCache = !!fresh;
      resetMulti(); S.tagFilter.clear(); loadTags();
      $('#sort-filter').value = ''; resetDateFilter(true); resetSortMode();
      $('#sort-folder-title').textContent = S.sort.folder.title || '收藏夹';
      await restoreDraft(mediaId, isCurrent);
      if (!isCurrent()) return;
      S.sort.loading = false;
      S.sort.loadedCount = S.sort.items.length;
      // 刚恢复的就是磁盘上那份状态，不再重复序列化并写回整份历史。
      draftSignature = currentDraftSignature();
      draftSavedSignature = draftSignature;
      renderSortChips(); renderSortList(); updateSortStats(); renderFavList();
      if (fresh) showCacheHint(cached.age || 0, false);
      lsSave('bilifav.lastFolder', String(mediaId), '上次打开的收藏夹');
      if (!S.sort.order.length) $('#sort-list').innerHTML = '<div class="empty"><span class="em">🫧</span><p>这个收藏夹还是空的，先点「开始整理」，再添加视频吧</p></div>';
      refreshRollback();
    } catch (err) {
      if (!isCurrent()) return;
      if (cacheUsable) {
        toast(`刷新没有完成：${err.message}。已保留本地缓存`, 'warn');
        await loadSortFolder(mediaId);
        return;
      }
      // 不把过期缓存伪装成已核实、可提交的完整新基线。
      S.sort.loading = true;
      clearLoadingHint();
      $('#sort-list').innerHTML = `<div class="empty"><span class="em">😵</span><p>${esc(err.message)}</p><p>请用收藏夹栏的刷新重试。</p></div>`;
    } finally {
      if (isCurrent()) sortLoadPending = 0;
    }
  }

  // 标题条左侧那块斜切的「收藏夹名」：点一下就把抽屉拉开换一个
  $('.page[data-page="sort"] .plate').addEventListener('click', () => toggleFavDrawer(true));

  // （标题条上原来那个刷新按钮撤了，活并进「我的收藏夹」栏的刷新里）

  /* -------- 添加视频 -------- */
  /** 把若干条视频塞进列表最前面（自动去重），返回真加进去的条数 */
  function addVideosToList(items, atEnd) {
    const existing = new Set([
      ...S.sort.items.map((x) => x.key),
      ...(S.sort.extra || []).map((x) => x.key),
    ]);
    const fresh = [];
    const additions = [];
    (items || []).forEach((it) => {
      if (!it || !it.key || existing.has(it.key)) return;
      existing.add(it.key);
      additions.push(it);
      fresh.push(it.key);
    });
    if (!fresh.length) return 0;
    if (!pushHistory()) return;
    S.sort.extra.push(...additions);
    // 整理模式下排最前面（好拖）；非整理模式就安静地加在末尾
    if (atEnd) S.sort.order.push(...fresh);
    else S.sort.order.unshift(...fresh);
    if (S.sort.pageSize) {
      // 跳到它落在的那一页，好歹让你看见加哪儿了
      const { pages } = pageSlice();
      S.sort.page = atEnd ? pages : 1;
    }
    updatePageUI();
    resetSortDim();
    renderSortList();
    updateSortStats();
    return fresh.length;
  }

  /* -------- 添加视频：贴链接，或者直接搜 -------- */
  let addPane = 'paste';
  let addSearchRows = [];
  const addSearch = { kw: '', page: 0, hasMore: false, busy: false };

  /** more=false 是新的一次搜索（从头），true 是接着往后翻 */
  async function doAddSearch(more) {
    const inp = $('#add-search-input');
    const box = $('#add-search-result');
    if (!inp || !box) return;
    const kw = (inp.value || '').trim();
    if (!kw) { toast('想搜点啥？', 'warn'); return; }
    if (addSearch.busy) return;

    const nextPage = (more && addSearch.kw === kw) ? addSearch.page + 1 : 1;
    addSearch.busy = true;
    if (nextPage === 1) {
      addSearchRows = [];
      box.innerHTML = '<div class="hint">正在搜…</div>';
    } else {
      const btn = $('#add-more');
      if (btn) { btn.disabled = true; btn.textContent = '正在加载…'; }
    }

    try {
      const data = await api(
        `/api/video/search?keyword=${encodeURIComponent(kw)}&page=${nextPage}`
      );
      const rows = data.videos || [];
      addSearchRows = addSearchRows.concat(rows);
      addSearch.kw = kw;
      addSearch.page = nextPage;
      addSearch.hasMore = !!data.has_more && rows.length > 0;
      renderAddSearch();
    } catch (err) {
      if (nextPage === 1) box.innerHTML = `<div class="hint">${esc(err.message)}</div>`;
      else toast(err.message, 'err');
      const btn = $('#add-more');
      if (btn) { btn.disabled = false; btn.textContent = '再加载 20 条'; }
    } finally {
      addSearch.busy = false;
    }
  }

  function renderAddSearch() {
    const box = $('#add-search-result');
    if (!box) return;
    if (!addSearchRows.length) {
      box.innerHTML = '<div class="hint">没搜到，换个词试试？</div>';
      return;
    }
    box.innerHTML = `<div class="add-results">${addSearchRows.map(addResultHtml).join('')}</div>`
      + (addSearch.hasMore
        ? `<button class="tbtn block" id="add-more" style="margin-top:9px">再加载 20 条（已经 ${addSearchRows.length} 条）</button>`
        : `<div class="hint" style="text-align:center;margin-top:8px">就这些了，一共 ${addSearchRows.length} 条</div>`);
  }

  function addResultHtml(v) {
    const inList = S.sort.order.includes(v.key)
      || (S.sort.extra || []).some((x) => x.key === v.key);
    return `<div class="add-item${inList ? ' done' : ''}" data-add-v="${esc(v.key)}">
      <div class="pic">${v.cover ? `<img src="${esc(httpsify(v.cover))}" alt="" referrerpolicy="no-referrer">` : ''}</div>
      <div class="info">
        <b>${esc(v.title || '(无标题)')}</b>
        <span>${esc(v.upper || '未知 UP')} · ${fmtNum(v.play)} 播放 · ${fmtDuration(v.duration)}</span>
      </div>
      <span class="plus">${inList ? '已在列表' : '＋ 加进来'}</span>
    </div>`;
  }

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const tab = t.closest('#add-tabs .add-tab');
    if (tab) {
      addPane = tab.dataset.addTab;
      $$('#add-tabs .add-tab').forEach((el) => el.classList.toggle('on', el === tab));
      const panePaste = $('#add-pane-paste');
      const paneSearch = $('#add-pane-search');
      if (panePaste) panePaste.classList.toggle('hidden', addPane !== 'paste');
      if (paneSearch) paneSearch.classList.toggle('hidden', addPane !== 'search');
      const ok = $('#modal-ok');
      if (ok) ok.textContent = addPane === 'search' ? '知道了' : '查一下';
      if (addPane === 'search') setTimeout(() => $('#add-search-input')?.focus(), 60);
      return;
    }
    if (t.closest('#add-search-btn')) { doAddSearch(false); return; }
    if (t.closest('#add-more')) { doAddSearch(true); return; }
    const hit = t.closest('#add-search-result [data-add-v]');
    if (hit) {
      const v = addSearchRows.find((x) => x.key === hit.dataset.addV);
      if (!v) return;
      if (addVideosToList([v], !S.sort.editing)) {
        toast(`「${v.title}」加进来啦`, 'ok');
        hit.classList.add('done');
        const plus = hit.querySelector('.plus');
        if (plus) plus.textContent = '已在列表';
      } else {
        toast('这条已经在列表里了', 'warn');
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.id === 'add-search-input') {
      e.preventDefault();
      doAddSearch(false);
    }
  });

  $('#sort-add').addEventListener('click', async () => {
    if (!S.sort.folder) { toast('先挑个收藏夹吧', 'warn'); return; }
    // 预览模式下也能加，只是会安静地排到末尾去
    const atEnd = !S.sort.editing;
    addPane = 'paste';
    addSearchRows = [];
    addSearch.kw = '';
    addSearch.page = 0;
    addSearch.hasMore = false;

    const raw = await openModal({
      title: '添加视频到这个收藏夹',
      desc: '贴 BV 号 / 链接，或者直接搜标题 —— 搜到的点一下就能加进来。',
      body: `
        <div class="add-tabs" id="add-tabs">
          <button class="add-tab on" data-add-tab="paste">贴链接 / BV 号</button>
          <button class="add-tab" data-add-tab="search">搜标题</button>
        </div>
        <div id="add-pane-paste">
          <div class="field">
            <textarea id="add-video-input" placeholder="BV1GJ411x7h7
https://www.bilibili.com/video/BV1xx411c7mD
av12345"></textarea>
            <div class="hint">一次最多 50 个，换行、空格分开都行。查好之后会出现在列表最前面。</div>
          </div>
        </div>
        <div id="add-pane-search" class="hidden">
          <div class="inp-row">
            <input class="inp" type="text" id="add-search-input" placeholder="输入视频标题的关键词…">
            <button class="tbtn primary" id="add-search-btn">
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round"><use href="#i-search"/></svg>
              搜一下
            </button>
          </div>
          <div id="add-search-result"></div>
        </div>`,
      okText: '查一下',
      collect: () => {
        if (addPane === 'search') return 'search';   // 搜索是点一条加一条，确定就是关窗
        const text = ($('#add-video-input')?.value || '').trim();
        if (!text) { toast('先贴点东西进来呀', 'warn'); return false; }
        return text;
      },
    });
    if (!raw || raw === 'search') return;

    // 一次贴几十个的时候拆成小批问 —— 这样有进度可看，某一批出错也不影响别的。
    // （服务端那边对只读接口放宽了限速，一批 10 个大约三秒。）
    const parts = String(raw).split(/[\s,，、;；]+/).filter(Boolean);
    const BATCH = 10;
    const rounds = Math.max(1, Math.ceil(parts.length / BATCH));
    const found = [];
    const failed = [];
    toast(rounds > 1 ? `正在问 B 站…（0 / ${rounds} 批）` : '正在问 B 站这些视频是什么…',
      'info', 0, 'resolve');
    try {
      for (let i = 0; i < parts.length; i += BATCH) {
        if (rounds > 1) {
          toast(`正在问 B 站…（${Math.floor(i / BATCH)} / ${rounds} 批，已经认出来 ${found.length} 个）`,
            'info', 0, 'resolve');
        }
        const data = await api('/api/video/resolve', { input: parts.slice(i, i + BATCH).join('\n') });
        found.push(...(data.found || []));
        failed.push(...(data.failed || []));
      }
      toast(`问完了：认出 ${found.length} 个${failed.length ? `，${failed.length} 个没认出来` : ''}`,
        'ok', 3200, 'resolve');

      const added = addVideosToList(found, atEnd);
      if (added) {
        toast(`加进来 ${added} 个，拖到想要的位置吧～`, 'ok');
      } else if (!failed.length) {
        toast(found.length ? '这些都已经在列表里了' : '没查到可用的视频', 'warn');
      }

      if (failed.length) {
        const lines = failed.slice(0, 8)
          .map((f) => `<div>· <b>${esc(f.input)}</b>：${esc(f.why)}</div>`).join('');
        await openModal({
          title: `${failed.length} 个没能加进来`,
          desc: '这几个查不到或者号不对，其余的都处理好了：',
          body: `<div style="font-size:12.5px;line-height:1.9;color:var(--txt-2)">${lines}</div>`,
          okText: '知道了',
          showCancel: false,
        });
      }
    } catch (err) {
      toast(err.message, 'err', 6000, 'resolve');
    }
  });

  /* -------- 一键删除失效项 --------
     把它放在排序按钮组里（原来叫「失效的沉底」，右上角那个「标记失效项」撤了）。
     注意它是**标记成待删除**，不是立刻删 —— 编辑模式下的改动都要点「提交改动」
     才会上 B 站，这样误点了也还有得救。真要立刻清掉，走收藏夹右键里的
     「一键清理失效内容」（那是 B 站自己的清理接口）。 */
  /**
   * 只把失效的标上"待删"，先不决定怎么处理。
   *
   * 返回标了多少个（0 表示没标到东西）。
   * 跟原来的 markAllInvalidDeleted 的区别：那个连"接下来怎么办"都替用户定了。
   */
  /**
   * 把一批视频加进另一个收藏夹。
   *
   * 走后端 /api/folder/add-items —— 它内部是 B 站的批量收藏接口，
   * 一次能加多张。**加完直接就在目标夹里了**，不需要再点「提交改动」
   * （提交那套是管"顺序"的，跟这个不是一回事）。
   *
   * 只加不删：源收藏夹里原来那份还在。用户要的是"拖过去"，
   * 但"拖过去"和"搬过去"在 B 站那边是两个动作，删源要另走删除流程。
   * 所以这里先稳妥地"复制过去"，并在提示里说明白 —— 想删源就选中它们按 Ctrl+X。
   */
  /**
   * 「直接复制到…／直接剪切到…」
   *
   * 跟剪贴板那条路子的分工：
   *   · 剪贴板（Ctrl+C → 切过去 → Ctrl+V）：适合"我想挑个位置"，
   *     粘的时候能落在目标夹的某一页（拖到页目录也行）
   *   · 这个：选个收藏夹就**直接排到它最后面**，一步到位，
   *     不用切过去再粘 —— 图的就是快
   *
   * cut=true 时顺带把源收藏夹里那份删掉（后端只删确实加成功的）。
   */
  async function askQuickToFolder(keys, cut) {
    if (!keys.length) {
      toast('先选几张卡片（或者把详情打开，复制眼前这一个）', 'warn', 4000);
      return;
    }
    const cur = currentFolderId();
    const others = (S.folders || []).filter((f) => f.media_id !== cur);
    if (!others.length) {
      toast('你只有这一个收藏夹，没别的地方可放', 'warn', 4200);
      return;
    }

    const rows = others.map((f) => `
      <button class="folder-item" data-qto="${esc(String(f.media_id))}"
              data-qname="${esc(f.title || '')}">
        <b>${esc(f.title || '未命名')}</b>
        <span>${esc(String(f.count || 0))} 条</span>
      </button>`).join('');

    await openModal({
      title: `${cut ? '剪切' : '复制'} ${keys.length} 张到…`,
      desc: cut
        ? '选一个收藏夹，这批就**直接排到它最后面**，同时从当前收藏夹移出。<br>'
          + '想挑落在目标夹的哪一页，就用「复制（Ctrl+C）→ 切过去 → 粘贴」那条路。'
        : '选一个收藏夹，这批就**直接排到它最后面**，不用切过去再粘。<br>'
          + '想挑落在目标夹的哪一页，就用「复制（Ctrl+C）→ 切过去 → 粘贴」那条路。',
      body: `<div class="folder-grid" id="quick-targets">${rows}</div>`,
      buttons: [{ id: 'modal-cancel', text: '算了', kind: 'plain', onClick: () => closeModal(false) }],
    });

    const box = $('#quick-targets');
    if (box) {
      box.querySelectorAll('[data-qto]').forEach((el) => el.addEventListener('click', () => {
        closeModal(false);
        copyPickedToFolder(keys, Number(el.dataset.qto), el.dataset.qname, !!cut);
      }));
    }
  }

  async function copyPickedToFolder(keys, toId, toName, cut) {
    const sourceId = currentFolderId();
    if (cut && sortTouched()) { toast('当前夹还有未提交改动，请先提交或还原，再直接移到其他收藏夹', 'warn', 6500); return; }
    const map = itemMap();
    const res = [];
    keys.forEach((k) => {
      const it = map.get(k);
      if (it && it.avid) res.push({ avid: Number(it.avid), type: Number(it.type || 2) });
    });
    if (!res.length) { toast('这几张拿不到 avid，搬不了', 'warn', 4200); return; }

    const label = toName || `收藏夹 ${toId}`;
    toast(`正在把这 ${res.length} 张加到「${label}」…`, 'info', 2400, 'copy-to-folder');
    if (cut) directFolderWrite = true;
    try {
      const d = await api('/api/folder/add-items', {
        media_id: toId, items: res,
        // 剪切时顺手把源收藏夹里那份也删掉（后端只删"确实加成功"的那部分）
        remove_from: cut ? sourceId : 0,
      });
      if (!d.ok) { toast(d.error || '加不进去', 'err', 6000, 'copy-to-folder'); return; }
      const okN = Number(d.added ?? res.length);
      const failN = Number(d.failed || 0);
      const rm = Number(d.removed || 0);
      let msg;
      if (failN) msg = `${cut ? '剪切' : '复制'}到「${label}」：成功 ${okN} 张，失败 ${failN} 张`;
      else if (cut) msg = `已经把这 ${okN} 张剪到「${label}」了（排在它最后面）`;
      else msg = `已经把这 ${okN} 张复制到「${label}」了（排在它最后面）`;
      if (cut && rm) msg += `，源收藏夹里移出了 ${rm} 张`;
      toast(msg, failN ? 'warn' : 'ok', 5600, 'copy-to-folder');
      // 目标夹的条数变了，侧栏数字跟着刷新一下
      refreshFolders();
    } catch (err) {
      toast(err.message, 'err', 6000, 'copy-to-folder');
    } finally {
      if (cut) {
        // 即使响应丢失也可能已写入一部分，以重新读取的远程状态为准。
        try {
          if (currentFolderId() === sourceId) {
            S.sort.stack = []; S.sort.redo = [];
            await clearDraft(sourceId);
            await loadSortFolder(sourceId, true);
          }
        } finally { directFolderWrite = false; }
      }
    }
  }

  function markAllInvalid() {
    const dead = invalidKeySet();
    const inList = new Set(S.sort.order);
    const targets = [];
    dead.forEach((k) => {
      if (!inList.has(k) || S.sort.deleted.has(k)) return;
      targets.push(k);
    });
    if (!targets.length) return 0;

    if (!pushHistory()) return;
    targets.forEach((k) => S.sort.deleted.add(k));
    renderSortList();
    updateSortStats();
    renderSortChips();
    return targets.length;
  }

  /**
   * 一键标记失效项 —— 标完接着问"怎么处理"。
   *
   * 三个去处：删掉（走提交）、搬到别的收藏夹、新建一个收藏夹来放。
   * 后两个都走搬运，需要用户已经在「搬运」页选好源收藏夹的那套流程，
   * 所以这里只把目标告诉它，具体动作交给搬运页。
   */
  async function handleInvalidMark() {
    if (!S.sort.editing) { toast('先点「开始整理」才能改', 'warn', 4000); return; }
    const n = markAllInvalid();
    if (!n) {
      toast(S.sort.items.some((it) => it.invalid)
        ? '失效的都已经标上了' : '这个收藏夹里没有失效的条目', 'info', 4000);
      return;
    }

    const others = (S.folders || []).filter((f) => f.media_id !== currentFolderId());
    const rows = others.slice(0, 12).map((f) => `
      <button class="folder-item" data-inv-to="${esc(String(f.media_id))}"
              data-inv-name="${esc(f.title || '')}">
        <b>${esc(f.title || '未命名')}</b>
        <span>${esc(String(f.count || 0))} 条</span>
      </button>`).join('');

    await openModal({
      title: `标好了 ${n} 个失效视频`,
      desc: '它们现在是「待删除」状态（卡片上会打叉），**还没真删** —— '
        + '删掉要点的「提交改动」才生效。<br>想留着的话，也可以搬到别的收藏夹去。',
      body: `
        <div class="hint" style="margin-bottom:10px">搬去哪个收藏夹：</div>
        <div class="folder-grid" id="inv-targets">
          ${rows || '<div class="hint">你只有这一个收藏夹</div>'}
          <button class="folder-item new" id="inv-new-folder">＋ 新建一个来放</button>
        </div>`,
      buttons: [
        { id: 'modal-cancel', text: '先这样，我自己看着办', kind: 'plain',
          onClick: () => closeModal(false) },
      ],
    });

    const box = $('#inv-targets');
    if (box) {
      box.querySelectorAll('[data-inv-to]').forEach((el) => el.addEventListener('click', () => {
        closeModal(false);
        handOffToCopy(Number(el.dataset.invTo), el.dataset.invName);
      }));
    }
    const nf = $('#inv-new-folder');
    if (nf) {
      nf.addEventListener('click', async () => {
        closeModal(false);
        const name = await openModal({
          title: '新建收藏夹',
          desc: '建好之后，这批失效的就会搬进去（搬运要选源和目标，所以接下来会带你去「搬运」页确认一下）。',
          body: `<div class="field"><label>名字（最多 20 字）</label>
            <input type="text" id="nf-name" maxlength="20" placeholder="比如：失效视频"></div>`,
          collect: () => (($('#nf-name') || {}).value || '').trim(),
          okText: '建好并搬过去',
          onEnter: null,
        });
        if (!name) return;
        try {
          const d = await api('/api/folder/create', { title: name });
          if (!d.ok) { toast(d.error || '建不出来', 'err', 6000); return; }
          const mid = d.folder && d.folder.media_id;
          toast(`建好了「${name}」`, 'ok', 3500);
          await refreshFolders();
          if (mid) handOffToCopy(Number(mid), name);
        } catch (err) {
          toast(err.message, 'err', 6000);
        }
      });
    }
  }

  /**
   * 把"要把这批待删的搬走"这件事交给搬运页。
   *
   * 搬运是**另一个页面的活**（要选源、选目标、跑任务），在这儿重写一遍
   * 只会多一套会走样的逻辑。所以切过去、把参数填好，让用户按开始。
   */
  function handOffToCopy(targetId, targetName) {
    const dead = Array.from(S.sort.deleted);
    const folder = S.sort.folder;
    if (!dead.length || !folder) return;
    // 记到 stash 里，搬运页读到就自动填源和目标
    try {
      sessionStorage.setItem('bilifav.handoff', JSON.stringify({
        source: folder.media_id,
        sourceName: folder.title || '',
        target: targetId,
        targetName: targetName || '',
        count: dead.length,
      }));
    } catch (_) { /* 存不下就算了，用户手动选也一样 */ }
    go('copy');
    toast(`去「搬运」页看看 —— 源已经选了「${folder.title || '当前收藏夹'}」，`
      + `目标选了「${targetName || '刚选的'}」。注意那边搬的是**整个收藏夹**，`
      + '不是只搬这几十个失效的。', 'info', 9000);
  }

  function markAllInvalidDeleted() {
    if (!S.sort.editing) { toast('先点「开始整理」才能改', 'warn'); return; }
    const dead = invalidKeySet();
    const inList = new Set(S.sort.order);
    const targets = [];
    dead.forEach((k) => {
      if (!inList.has(k) || S.sort.deleted.has(k)) return;
      targets.push(k);
    });
    if (!targets.length) {
      toast(S.sort.items.some((it) => it.invalid) ? '失效的都已经标上了' : '这个收藏夹里没有失效的条目',
        'info');
      return;
    }
    if (!pushHistory()) return;
    targets.forEach((k) => S.sort.deleted.add(k));
    renderSortList();
    updateSortStats();
    toast(`标了 ${targets.length} 个失效的待删除 —— 点「提交改动」才会真的从 B 站删掉`, 'ok', 6500);
  }

  /* -------- 清除所有标记 -------- */
  $('#sort-clear-marks').addEventListener('click', () => {
    if (!pushHistory()) return;
    S.sort.deleted = new Set();
    S.sort.extra = [];
    S.sort.order = S.sort.original.slice();
    renderSortList();
    updateSortStats();
    toast('标记都清掉啦，顺序也还原成刚加载的样子');
  });

  /*
    一键排序的按钮组。

    每个维度只有一个按钮：按一次升序、再按一次降序、第三次**还原** ——
    还原回到的是"第一次按它之前"的顺序，所以连点三下等于什么都没做。
    换个维度会重新记一次快照。
  */
  /* ==========================================================================
     新手教程
     ==========================================================================

     每个板块一份，写在下面这个表里。内容刻意写得像"有人在旁边教你"，
     而不是功能清单 —— 第一次打开的人最需要知道的是"我该先点哪里"。
  */
  // 每一步只讲一个高亮目标；页面教程和局部帮助共用有名字的步骤。
  const focusStep = (page, target, heading, text, options = {}) => [heading, text, { page, target, ...options }];
  const TUTORIAL_STEPS = {
    account: focusStep('menu', '#acct-login', '查看当前账号', '这里显示当前账号。点击头像或昵称进入登录页，中间留白不会跳转。'),
    browse: focusStep(null, '.navitem[data-page="sort"]', '进入浏览页面', '点底部「浏览」，查看和整理自己的收藏夹。'),
    copyNav: focusStep(null, '.navitem[data-page="copy"]', '进入搬运页面', '点底部「搬运」，把公开收藏夹的内容批量收藏到自己的账号。'),
    tasksOpen: focusStep(null, '#top-task', '打开任务面板', '点顶栏「任务」，展开当前任务的进度和日志。'),
    theme: focusStep('menu', '#appear-btn', '选择主题色', '点调色盘按钮，打开主题色设置。'),
    skin: focusStep(null, '#top-skin', '切换白天与夜晚', '点这个按钮切换界面的明暗。它可以与已经选择的主题色搭配使用。'),
    history: focusStep('menu', '#history-panel > .panel-h', '展开任务记录', '点这一行，查看本机保存的搬运任务记录。'),
    historyList: focusStep('menu', '#history-body', '查看任务存档', '这里显示已保存的搬运进度。可按记录提供的操作继续任务，继续时会实际写入 B 站。', { fold: 'history-panel' }),
    keys: focusStep('menu', '#keys-panel > .panel-h', '展开快捷键', '点这一行，查看各个功能当前使用的快捷键。'),
    keyEdit: focusStep('menu', '#keys-body', '修改一个快捷键', '在这组键位中点要修改的按钮，再按新的组合键。带锁的 Esc 和固定 Ctrl+C/X/V 不可占用；同一作用域的冲突会拒绝保存。', { fold: 'keys-panel' }),
    keyReset: focusStep('menu', '#keys-reset', '恢复默认键位', '这个按钮会将自定义快捷键恢复为默认设置。', { fold: 'keys-panel' }),
    data: focusStep('menu', '#data-panel > .panel-h', '展开数据设置', '点这一行，查看数据目录、任务存档和运行日志。'),
    dataPath: focusStep('menu', '#menu-datadir', '备份本机数据', '这里是软件实际使用的数据目录。退出软件后复制该目录，可备份标签、草稿、任务记录和设置；其中含登录凭证，请勿随意分享。', { fold: 'data-panel' }),
    logout: focusStep('menu', '#login-logout', '退出当前账号', '退出会清除本机登录凭证，下次使用需重新登录。关闭软件窗口不会自动退出账号。'),

    foldersOpen: focusStep(null, '#fav-drawer-open', '打开收藏夹', '点左上角「收藏夹」，在展开的列表里选择要查看的收藏夹。'),
    folderChoose: focusStep(null, '#fav-list [data-fav]', '选择一个收藏夹', '点击要查看的收藏夹，优先打开近期的完整缓存；首次读取需等待 B 站返回完整内容。', { panel: 'folders' }),
    folderSearch: focusStep(null, '#fav-search', '先查本地收藏夹缓存', '输入关键词，先查收藏夹名称和已缓存视频的标题 / UP 主。下方会标明缓存覆盖范围和时间；未缓存及最新变动可用「在线补查」查询。', { panel: 'folders', include: '#fav-scan-online' }),
    folderOrder: focusStep(null, '#fav-list [data-fav]', '调整收藏夹列表顺序', '清空搜索后，可拖动收藏夹条目调整列表顺序。这里只保存软件内的顺序，不修改 B 站网页或 App 上的收藏夹排列。', { panel: 'folders' }),
    folderNew: focusStep(null, '#fav-list [data-fav-new]', '新建收藏夹', '点这里填写名称等信息，确认后创建线上收藏夹。', { panel: 'folders' }),
    folderMenu: focusStep(null, '#fav-list [data-fav]', '右键管理收藏夹', '在收藏夹上点右键，可找到改名、简介、清理、合并和删除入口。这些操作按各自确认流程直接执行。', { panel: 'folders' }),
    folderRefresh: focusStep(null, '#fav-refresh', '刷新收藏夹', '这个按钮重新读取收藏夹列表，也会重读当前打开的收藏夹。', { panel: 'folders' }),
    folderClean: focusStep(null, '#fav-clean-all', '清理所有收藏夹的失效内容', '此处清理自己所有收藏夹中的失效内容，先核对确认框。确认后直接执行线上清理，不等整理页统一提交。', { panel: 'folders' }),
    preview: focusStep('sort', '#sort-mode', '预览与整理怎么切换', '显示「开始整理」时，点它进入编辑；显示「保存整理」时，点它保存本机草稿并回到预览。保存不会同步到 B 站。'),
    search: focusStep('sort', '#sort-filter', '按标题或 UP 主筛选', '在这里输入关键词，保留标题或 UP 主匹配的视频。清空关键词可取消这一项筛选。'),
    filterScope: focusStep('sort', '#sort-scope', '切换关键词筛选范围', '有关键词时，「本页」只筛当前页；「本收藏夹」跨页显示全部关键词命中。关键词为空时仍保留分页。切换会保留关键词。'),
    filterDate: focusStep('sort', '#sort-dateflt', '按收藏日期筛选', '按收藏时间筛选，不是投稿时间。只填一端表示另一端不限；缺少收藏时间的视频不会命中日期筛选。', { wide: true }),
    tagsOpen: focusStep('sort', '#sort-tag-manage', '打开标签管理', '点「标签」，打开本机标签的管理窗口。'),
    tagCreate: focusStep('sort', '#tag-name', '创建一个标签', '输入名称后按回车创建，最多 5 个字。标签按收藏夹保存，只在本机使用。', { panel: 'tags' }),
    tagColor: focusStep('sort', '#tag-colors', '选择标签颜色', '在这里为新标签选择颜色，也可以使用自定义颜色。', { panel: 'tags' }),
    tagPin: focusStep('sort', '#tag-list [data-tagpin]', '优先显示常用标签', '置顶后优先排在「全部」右侧，标签较多时优先显示。取消置顶不会改变标签颜色。', { panel: 'tags' }),
    tagCopy: focusStep('sort', '#tag-list [data-tagcopy]', '复制标签本身', '「复制到…」复制标签名称和颜色，不复制视频，也不复制视频与标签的对应关系。', { panel: 'tags' }),
    tagSync: focusStep('sort', '#modal-ok2', '匹配站内同名标签', '这个按钮读取视频的站内标签，与已创建的本机标签同名时才贴上，不会把所有站内标签都新建进来。', { panel: 'tags' }),
    /*
      多选原来拆成了四步（开多选 / 点卡片 / 全选本页 / 取消选择），
      四步讲的是同一件事，用户的原话是"多选这里就有好几步是重复的"。
      并成一步，只留真正用得上的：怎么选、怎么连选、怎么退出。
    */
    multi: focusStep('sort', '#sort-multi', '选择和批量处理', '开启后点卡片选中或取消，Shift + 点击连选，Ctrl + Shift + 点击取消一段。翻页和筛选会保留选择；选完在卡片上点右键批量处理，再点这里退出多选。', { include: '#sort-select-all, #sort-pick-clear' }),
    durationAll: focusStep('sort', '[data-duration="scope"]', '全部或筛选结果时长', '这组统计跨所有页计算；设置筛选后，只计算符合筛选条件的视频。待删除和失效视频不计入，未知时长另行标明。'),
    durationPage: focusStep('sort', '[data-duration="page"]', '本页时长', '这组统计只计算当前页显示的视频，同样排除待删除和失效项。'),
    durationPicked: focusStep('sort', '[data-duration="picked"]', '已选视频的跨页时长', '这组统计合计全部已选视频，包含其他页及当前筛选之外的选择。待删除和失效视频不计入。'),
    detailOpen: focusStep('sort', '#sort-list .card', '打开视频详情', '点击卡片，在左侧查看视频资料和我的标签。详情与收藏夹列表共用左侧栏，右侧页目录独立开关。', { requiresSingle: true }),
    detailInfo: focusStep('sort', '#detail .dt-meta', '查看视频资料', '这里列出当前视频的 UP 主、投稿日期、收藏日期和时长等资料。', { panel: 'detail' }),
    cumulative: focusStep('sort', '#dt-cumulative', '查看累计至此的时长', '按完整清单顺序累加到当前视频，包含本条，不随筛选缩短；不计待删除和失效视频。', { panel: 'detail' }),
    itemTags: focusStep('sort', '#dt-mine-tags', '给当前视频贴标签', '在「我的标签」里点击标签可贴上或取消，只修改本机分类。', { panel: 'detail' }),
    detailCopy: focusStep('sort', '#detail-copy', '复制视频条目', '这里复制的是软件内的视频条目，可粘贴到另一个收藏夹作为待新增。它不是视频文件。', { panel: 'detail' }),
    pagesOpen: focusStep('sort', '#sort-boxes', '打开页目录', '点「页目录」，展开分页设置和各页目录。'),
    pageWidth: focusStep('sort', '#boxpanel-resizer', '调整页目录宽度', '按住页目录左边的细线拖动，可调宽或调窄；页格会自动重新排列，宽度记在本机。', { panel: 'pages' }),
    pageSize: focusStep('sort', '#page-size-opts', '设置每页条数', '这里可选每页 20、30、50 条、自定义或无限平铺。分页按完整清单的位置切分。', { panel: 'pages' }),
    pageJump: focusStep('sort', '#boxpanel-grid .boxcell', '跳到指定页', '点页格可跳到对应页。页数多时在目录内部滚动；拖动卡片或整页到目录上下边缘会自动滚动。筛选后不会重新凑满每页。', { panel: 'pages' }),
    pageLock: focusStep('sort', '#boxpanel-grid [data-lockpage]', '限制向这一页放入视频', '锁定后，向这一页拖入或发送视频前需先解锁。它不是冻结整页：全局排序、前面页面的增删仍可能改变本页内容。', { panel: 'pages' }),
    drag: focusStep('sort', '#sort-list .card', '拖动卡片调整顺序', '整理模式下可以拖动这类卡片，根据落点提示换位置。可先关闭说明再练习拖动。', { requiresEdit: true }),
    sortChips: focusStep('sort', '#sort-chips', '按一个维度排序', '这些按钮按对应维度排序。同一维度依次为升序、降序、还原到点击前的顺序。', { requiresEdit: true }),
    add: focusStep('sort', '#sort-add', '添加视频', '输入 BV 号、av 号或链接，也可切到「搜标题」。新增先留在本地清单，提交后才收藏到 B 站。', { requiresEdit: true }),
    import: focusStep('sort', '#sort-import', '从文件导入视频', '选择 CSV、TXT 或 MD 文件，按文件中的编号和链接顺序添加，已有视频会跳过。不会重排已有视频或恢复标签；新增仍需提交。', { requiresEdit: true }),
    clipboardCopy: focusStep('sort', '#ctx-menu [data-clip-copy]', '复制视频条目', '复制软件内的视频条目，方便换位置或跨收藏夹粘贴；多选后会复制选中的整批。这和「复制视频链接」不同。', { panel: 'cardMenu' }),
    clipboardPaste: focusStep('sort', '#ctx-menu [data-clip-paste]', '选择粘贴位置', '用「粘贴到此卡前 / 后」选择右键卡片的哪一侧。同夹粘贴只移动、不重复新增；跨夹粘贴先留作待新增，仍需提交。', { panel: 'cardMenu', include: '#ctx-menu [data-clip-paste-after]', requiresEdit: true, needsClip: true }),
    delete: focusStep('sort', '#sort-list .card [data-cact="delete"]', '标记视频待删除', '卡片垃圾桶先标记待删除，提交前可以取消；提交后才会移出线上收藏夹。', { requiresEdit: true }),
    save: focusStep('sort', '#sort-mode', '保存整理到本机', '点「保存整理」，等待写入成功后返回预览。默认 Ctrl+S 可立即保存草稿并继续整理；都只写入本机，不同步到 B 站。改键以「菜单 → 快捷键」为准。', { requiresEdit: true }),
    saveState: focusStep('sort', '#sort-save-state', '确认草稿保存状态', '这里显示本机草稿的保存结果。失败时保留窗口并重试，确认成功后再退出。', { requiresEdit: true }),
    submit: focusStep('sort', '#sort-apply', '提交改动到 B 站', '点「提交改动」后核对确认框。确认后依次执行线上删除、添加和排序，已完成部分不会因中断而自动撤回。', { requiresEdit: true }),
    undo: focusStep('sort', '#sort-undo', '撤销一次本地操作', '恢复上一步的顺序、增删标记、标签和页锁。最多保留 60 步并随草稿保存；不能撤销已经写入 B 站的操作。', { requiresEdit: true }),
    redo: focusStep('sort', '#sort-redo', '重做一次本地操作', '恢复刚撤销的本地状态。撤销后再做新的整理操作，会清空重做分支；已提交的线上操作不属于这份历史。', { requiresEdit: true }),
    reset: focusStep('sort', '#sort-reset', '还原清单与增删标记', '恢复加载时的清单顺序，清除待删除和新增标记；本机标签保留。这一步本身也能撤销。', { requiresEdit: true }),
    rollback: focusStep('sort', '#sort-rollback', '回滚上次提交的顺序', '有可用记录时才显示。它只恢复上次提交前的顺序，不恢复那次删除的收藏。', { requiresEdit: true, optional: true }),
    export: focusStep('sort', '#sort-export', '导出当前清单', '导出完整当前清单为 CSV，包含未提交状态，保存到 data/exports/。不是只导出已选视频，也不会下载视频。'),

    sourceInput: focusStep('copy', '#copy-src-input', '填写源收藏夹', '在这里粘贴公开收藏夹链接或 ID。'),
    sourceRead: focusStep('copy', '#copy-src-btn', '读取源收藏夹', '填写来源后点「读取」，查看识别到的收藏夹与预览。读取不会开始搬运。'),
    upInput: focusStep('copy', '#up-input', '按 UP 主查找来源', '也可以在这里填写 UP 主 UID 或昵称。'),
    upRead: focusStep('copy', '#up-btn', '查找 UP 主的公开收藏夹', '填写 UID 或昵称后，点「找 UP 主」查找可用来源。'),
    target: focusStep('copy', '#copy-tgt-list', '选择目标收藏夹', '在这一区选择自己账号下的收藏夹，确认视频将收藏到哪里。'),
    targetNew: focusStep('copy', '#copy-tgt-new', '新建目标收藏夹', '需要空收藏夹时，点「新建」并核对创建信息。'),
    copyType: focusStep('copy', '#copy-opt-type', '选择搬运范围', '这里决定搬运视频、音频、合集或全部内容。'),
    copyOrder: focusStep('copy', '#copy-opt-order', '选择抓取顺序', '这里决定按收藏时间、投稿时间或播放量读取源内容。'),
    copyDelay: focusStep('copy', '#copy-opt-delay', '设置请求间隔', '这里设置每条操作之间的等待秒数。初次使用建议保留默认间隔。'),
    copyPrescan: focusStep('copy', '#copy-opt-prescan-label', '预扫描目标收藏夹', '保留此项可预先识别目标中已有的条目，减少重复添加。'),
    copyInvalid: focusStep('copy', '#copy-opt-skipinvalid-label', '跳过失效稿件', '保留此项可跳过已经失效的内容，减少无效请求。'),
    copyStart: focusStep('copy', '#copy-start', '确认开始搬运', '核对源与目标后点「开始搬运」。确认后会逐步写入 B 站，不需要另行提交。'),
    taskProgress: focusStep(null, '#task-bar', '查看任务进度', '这里显示当前任务的执行进度。接口限速和失效条目会影响速度及结果。', { panel: 'tasks' }),
    taskPause: focusStep(null, '#task-pause', '暂停或继续任务', '按任务当前提供的状态暂停或继续。暂停不会撤回已经完成的线上操作。', { panel: 'tasks' }),
    taskStop: focusStep(null, '#task-stop', '停止当前任务', '停止前核对确认提示。已经完成的线上操作会保留。', { panel: 'tasks' }),

    qr: focusStep('login', '#qr-box', '用 B 站手机 App 扫码', '扫描这个二维码，再在手机上确认登录。软件不需要账号密码。'),
    qrRefresh: focusStep('login', '#qr-refresh', '更换过期二维码', '二维码过期或读取失败时，点「换一张」重新获取。'),
    cookieOpen: focusStep('login', '#cookie-toggle', '展开备用登录方式', '扫码无法使用时，点这里展开 Cookie 登录。'),
    cookieInput: focusStep('login', '#cookie-input', '填写自己的 Cookie', '按输入框示例填写自己的凭证。Cookie 相当于登录通行证，请勿发给他人。', { panel: 'cookie' }),
    cookieSubmit: focusStep('login', '#cookie-submit', '使用 Cookie 登录', '确认输入正确后，点这个按钮验证登录。', { panel: 'cookie' }),
  };
  for (const [id, step] of Object.entries(TUTORIAL_STEPS)) step[2].id = id;
  const focusSteps = (...ids) => ids.map(id => TUTORIAL_STEPS[id]);
  const TUTORIALS = {
    menu: { title: '菜单 · 使用教程', steps: focusSteps('account', 'browse', 'copyNav', 'tasksOpen', 'theme', 'skin', 'history', 'keys', 'data') },
    // 页面教程讲主要路径；独立控件的细节放在所在板块的问号里。
    sort: { title: '浏览与整理 · 使用教程', steps: focusSteps('foldersOpen', 'detailOpen', 'search', 'tagsOpen', 'multi', 'pagesOpen', 'preview', 'sortChips', 'add', 'delete', 'save', 'submit', 'export') },
    copy: { title: '搬运收藏夹 · 使用教程', steps: focusSteps('sourceInput', 'sourceRead', 'target', 'copyType', 'copyOrder', 'copyDelay', 'copyPrescan', 'copyInvalid', 'copyStart', 'tasksOpen', 'history') },
    login: { title: '登录 · 使用教程', steps: focusSteps('qr', 'qrRefresh', 'cookieOpen', 'cookieInput', 'cookieSubmit') },
  };
  const HELP_TOPICS = {
    folders: { title: '收藏夹', steps: focusSteps('folderChoose', 'folderSearch', 'folderOrder', 'folderNew', 'folderMenu', 'folderRefresh', 'folderClean') },
    filters: { title: '筛选与多选', steps: focusSteps('search', 'filterScope', 'filterDate', 'multi') },
    sorting: { title: '排序与增删', steps: focusSteps('drag', 'sortChips', 'add', 'import', 'delete', 'clipboardCopy', 'clipboardPaste') },
    saving: { title: '保存与提交', steps: focusSteps('save', 'saveState', 'submit', 'undo', 'redo', 'reset', 'rollback') },
    duration: { title: '时长统计', steps: focusSteps('durationAll', 'durationPage', 'durationPicked') },
    pages: { title: '页目录', steps: focusSteps('pageWidth', 'pageSize', 'pageJump', 'pageLock') },
    tags: { title: '标签', steps: focusSteps('tagColor', 'tagCreate', 'tagPin', 'tagCopy', 'tagSync') },
    detail: { title: '视频详情', steps: focusSteps('detailInfo', 'cumulative', 'itemTags', 'detailCopy') },
    account: { title: '账号与外观', steps: focusSteps('account', 'theme', 'skin', 'logout') },
    tasks: { title: '当前任务', steps: focusSteps('tasksOpen', 'taskProgress', 'taskPause', 'taskStop') },
    history: { title: '任务记录', steps: focusSteps('historyList') },
    keys: { title: '快捷键', steps: focusSteps('keyEdit', 'keyReset') },
    data: { title: '本机数据', steps: focusSteps('dataPath') },
    source: { title: '源收藏夹', steps: focusSteps('sourceInput', 'sourceRead', 'upInput', 'upRead') },
    target: { title: '目标收藏夹', steps: focusSteps('target', 'targetNew') },
    options: { title: '搬运选项', steps: focusSteps('copyType', 'copyOrder', 'copyDelay', 'copyPrescan', 'copyInvalid', 'copyStart') },
    qr: { title: '扫码登录', steps: focusSteps('qr', 'qrRefresh') },
    cookie: { title: 'Cookie 登录', steps: focusSteps('cookieInput', 'cookieSubmit') },
  };

  function tutorialFor(key) { return HELP_TOPICS[key] || TUTORIALS[key]; }
  function tutorialSteps(key) {
    return tutorialFor(key).steps.filter(step => {
      const spec = step[2];
      if (spec.when === 'visible' && !tutFind(spec.target)) return false;
      if (key === 'sort' && spec.requiresEdit && !S.sort.editing) return false;
      return true;
    });
  }
  function tutRefreshSteps() {
    if (!tutState) return false;
    const next = tutorialSteps(tutState.page);
    if (next.length === tutState.steps.length && next.every((s, i) => s[2].id === tutState.steps[i][2].id)) return false;
    const currentId = tutState.steps[tutState.idx]?.[2].id;
    const current = next.findIndex(s => s[2].id === currentId);
    tutState.steps = next;
    tutState.idx = current < 0 ? Math.min(tutState.idx, next.length - 1) : current;
    return true;
  }
  function sectionHelpHtml(key, text) {
    const label = `${tutorialFor(key).title}：查看说明`;
    // 默认只有一个问号；传了 text 就写成一个带字的小牌（时长那一行用）。
    const face = text ? esc(text) : '?';
    const cls = text ? 'section-help with-text' : 'section-help';
    return `<button type="button" class="${cls}" data-tut-open="${esc(key)}" title="${esc(label)}" aria-label="${esc(label)}">${face}</button>`;
  }
  let tutState = null;          // { page, idx, anchor }  anchor 是触发它的那个按钮

  /*
    教程"看过没"的记录**存在 data/ 里，不走 localStorage**。

    用户要求这类缓存别留在浏览器里。所以：读的时候从 PREFS.ui 拿，
    写的时候走 savePrefs → /api/prefs/set，落在 data/config/prefs.json。
    完整教程的阅读记录保留在这里；小板块说明不额外写入阅读记录。
  */
  function tutSeen() {
    try {
      const raw = (PREFS.ui && PREFS.ui.tutSeen) || '';
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch (_) { return {}; }
  }

  function tutMarkSeen(page) {
    const all = tutSeen();
    all[page] = 1;
    queueUiSave('tutSeen', JSON.stringify(all));
  }

  /** 当前在哪个板块 —— 教程内容跟着它走 */
  function tutCurrentPage() {
    const act = document.querySelector('.page.active');
    return act ? act.dataset.page : 'menu';
  }

  function tutRender() {
    if (!tutState) return;
    const t = tutorialFor(tutState.page);
    if (!t) return;
    const steps = tutState.steps;
    const total = steps.length;
    $('#tut-card').classList.toggle('tut-single', total === 1);
    const i = Math.max(0, Math.min(total - 1, tutState.idx));

    $('#tut-title').textContent = t.title;
    $('#tut-step').textContent = `第 ${i + 1} / ${total} 步`;
    $('#tut-bar-fill').style.width = `${((i + 1) / total) * 100}%`;
    const [h, d] = steps[i];
    $('#tut-h').textContent = h;
    $('#tut-p').innerHTML = d;
    $('#tut-prev').disabled = i === 0;
    $('#tut-next').textContent = i === total - 1 ? '知道了' : '下一步';
    tutPlace(true);
  }

  function tutVisible(el) {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    if (el.closest('.drawer:not(.show), .detail:not(.show), .boxpanel:not(.show)')) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  }

  // 按书写顺序选择可见目标，而非按 DOM 顺序；例如先找标签窗口里的输入框。
  function tutFind(selector) {
    for (const part of (selector || '').split(',')) {
      if (!part.trim()) continue;
      const el = $$(part.trim()).find(tutVisible);
      if (el) return el;
    }
    return null;
  }

  // 目标尚未出现时，只讲当前需要完成的准备操作，不混入下一控件的说明。
  function tutResolve(step) {
    const [heading, text, spec] = step;
    const pending = (selector, h, d) => ({ target: tutFind(selector), heading: h, text: d, pending: true });
    const target = tutFind(spec.target);
    const modal = $('#modal-mask.show');
    if (modal && (!target || !modal.contains(target)) && !(spec.panel === 'tags' && $('#tag-name'))) {
      return pending('#modal-x', '先关闭当前窗口', '点这个关闭按钮，返回当前教程所需的界面。');
    }
    if (spec.page && tutCurrentPage() !== spec.page) {
      if (spec.page === 'login') {
        if (tutCurrentPage() === 'menu') return pending('#acct-login', '先进入登录页', '点头像或昵称，进入登录页面。');
        return pending('.navitem[data-page="menu"]', '先回到菜单', '点底部「菜单」，再从账号区域进入登录页。');
      }
      const name = { sort: '浏览', copy: '搬运', menu: '菜单' }[spec.page];
      return pending(`.navitem[data-page="${spec.page}"]`, `先进入${name}页面`, `点底部「${name}」，再继续这一步。`);
    }
    if (spec.requiresEdit && !S.sort.folder) return pending('#fav-drawer-open', '先选择一个收藏夹', '点「收藏夹」打开列表，再选择要整理的收藏夹。');
    if (spec.requiresEdit && !S.sort.editing) return pending('#sort-mode', '先进入整理模式', '点「开始整理」，打开本步所需的编辑工具。');
    if (spec.requiresMulti && !S.sort.multi) return pending('#sort-multi', '先开启多选', '点「多选」，开启视频的批量选择。');
    if (spec.needsClip && !(clip && clip.items.length)) {
      if (tutFind('#ctx-menu [data-clip-copy]')) return pending('#ctx-menu [data-clip-copy]', '先复制视频条目', '点这里复制当前视频或已选条目，再在目标卡片上点右键粘贴。');
      return pending('#sort-list .card', '先复制视频条目', '先在要复制的卡片上点右键，再选择「复制」。');
    }
    if (spec.needsPicked && !S.sort.picked.size) return pending('#sort-list .card', '先选择一个视频', '点击一张卡片，将它加入选择。');
    if (S.sort.multi && (spec.requiresSingle || (spec.panel === 'detail' && !target))) {
      return pending('#sort-multi', '先退出多选', '点「多选」关闭批量选择，再点击卡片打开视频详情。');
    }
    if (target) return { target, heading, text, pending: false };
    if (spec.fold) return pending(`#${spec.fold} > .panel-h`, '先展开这个板块', '点这一行，展开本步要使用的内容。');
    if (spec.panel === 'tags') {
      if (!$('#modal-mask').classList.contains('show')) return pending('#sort-tag-manage', '先打开标签管理', '点「标签」，打开管理窗口。');
      return pending('#tag-name', '先创建一个标签', '输入名称后按回车创建，最多 5 个字。');
    }
    const panels = {
      folders: ['#fav-drawer-open', '先打开收藏夹列表', '点「收藏夹」，展开左侧列表。'],
      pages: ['#sort-boxes', '先打开页目录', '点「页目录」，展开分页面板。'],
      detail: ['#sort-list .card', '先打开视频详情', '点击一张卡片，打开它的详情。'],
      tasks: ['#top-task', '先打开任务面板', '点「任务」，展开任务进度面板。'],
      cookie: ['#cookie-toggle', '先展开 Cookie 登录', '点「二维码扫不了？直接贴 Cookie」，展开输入区域。'],
      cardMenu: ['#sort-list .card', '先打开卡片右键菜单', '在这张卡片上点鼠标右键，打开条目操作菜单。'],
    };
    if (spec.panel && panels[spec.panel]) {
      if (spec.panel === 'folders' && $('#fav-drawer').classList.contains('show')) {
        return pending('#fav-search', '列表里暂时没有可用收藏夹', '可以清空搜索词后再查看；未登录时需先登录账号。');
      }
      return pending(...panels[spec.panel]);
    }
    const anchor = tutVisible(tutState.anchor) ? tutState.anchor : tutFind('.page.active .titlebar [data-tut-open]');
    if (spec.wide) return { target: anchor, heading: '放宽窗口以显示日期筛选', text: '当前窗口较窄，日期筛选已收起。放宽窗口后，本步会指向日期框。', pending: true };
    if (spec.optional) return { target: anchor, heading: '当前没有可回滚的记录', text: '只有存在上次提交的可用记录时，才会显示回滚按钮。可继续下一步。', pending: true };
    if (spec.page === 'sort' && !S.sort.folder) return pending('#fav-drawer-open', '先选择一个收藏夹', '点「收藏夹」打开列表，再选择要查看的收藏夹。');
    return { target: anchor, heading: '当前没有可展示的内容', text: '这个功能暂时没有可展示的内容，可继续下一步，或稍后重新查看。', pending: true };
  }

  /** 说明贴着本步骤的实际控件，遮罩为控件留出可点击的窗口。 */
  function tutPlace(scrollTarget = false) {
    const card = $('#tut-card');
    if (!card || !tutState) return;
    const step = tutState.steps[tutState.idx];
    const spec = step[2] || {};
    const resolved = tutResolve(step);
    const target = resolved.target;
    tutState.target = target;
    card.dataset.step = spec.id;
    card.dataset.pending = String(resolved.pending);
    $('#tut-h').textContent = resolved.heading;
    $('#tut-p').textContent = resolved.text;
    const hint = $('#tut-target-note');
    hint.textContent = '';
    hint.hidden = true;
    if (scrollTarget && target) target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    let r = target ? target.getBoundingClientRect()
      : { top: 60, bottom: 60, left: innerWidth - 30, right: innerWidth - 30 };
    // 徽章会露出按钮边框；高亮和可点击区域需包含整个可见图标。
    if (target?.classList.contains('navitem') || target?.id === 'sort-mode') {
      const badge = Array.from(target.querySelectorAll('.nav-badge, .mode-icon .theme-icon-canvas, .mode-icon img')).find(tutVisible);
      if (badge) {
        const b = badge.getBoundingClientRect();
        r = { top: Math.min(r.top, b.top), bottom: Math.max(r.bottom, b.bottom),
          left: Math.min(r.left, b.left), right: Math.max(r.right, b.right) };
      }
    }
    if (spec.include && target && !resolved.pending) {
      for (const extra of $$(spec.include).filter(tutVisible)) {
        const b = extra.getBoundingClientRect();
        r = { top: Math.min(r.top, b.top), bottom: Math.max(r.bottom, b.bottom),
          left: Math.min(r.left, b.left), right: Math.max(r.right, b.right) };
      }
    }
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const margin = 10;
    const gap = 18;
    const clampX = x => Math.max(margin, Math.min(x, innerWidth - cw - margin));
    const clampY = y => Math.max(margin, Math.min(y, innerHeight - ch - margin));
    const candidates = [
      { left: clampX(r.left), top: r.bottom + gap },
      { left: clampX(r.right - cw), top: r.bottom + gap },
      { left: clampX(r.left), top: r.top - ch - gap },
      { left: clampX(r.right - cw), top: r.top - ch - gap },
      { left: r.right + gap, top: clampY(r.top) },
      { left: r.left - cw - gap, top: clampY(r.top) },
    ];
    const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const scored = candidates.map((p, index) => {
      const left = clampX(p.left), top = clampY(p.top);
      const bounds = { left, top, right: left + cw, bottom: top + ch };
      const outside = Math.abs(left - p.left) + Math.abs(top - p.top);
      return { left, top, score: overlap(bounds, r) * 100 + outside * 20 + index };
    });
    const best = scored.sort((a, b) => a.score - b.score)[0];
    card.style.top = `${Math.round(best.top)}px`;
    card.style.left = `${Math.round(best.left)}px`;
    card.style.right = 'auto';
    card.style.bottom = 'auto';

    const spot = $('#tut-spotlight');
    const x = Math.max(4, r.left - 6), y = Math.max(4, r.top - 6);
    const right = Math.min(innerWidth - 4, r.right + 6), bottom = Math.min(innerHeight - 4, r.bottom + 6);
    const visible = !!target && right > x && bottom > y;
    spot.classList.toggle('show', visible);
    spot.dataset.target = visible ? (target.id || spec.target || '') : '';
    if (visible) {
      Object.assign(spot.style, { left: `${x}px`, top: `${y}px`, width: `${right - x}px`, height: `${bottom - y}px` });
      $('#tut-mask').style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${x}px ${y}px, ${x}px ${bottom}px, ${right}px ${bottom}px, ${right}px ${y}px, ${x}px ${y}px)`;
    } else {
      $('#tut-mask').style.clipPath = '';
    }
  }

  function tutOpen(page, force, anchor) {
    const p = tutorialFor(page) ? page : 'menu';
    if (!force && tutSeen()[p]) return;
    const steps = tutorialSteps(p);
    if (!steps.length) return;
    tutState = { page: p, idx: 0, anchor: anchor || null, steps };
    document.body.classList.add('tutorial-open');
    $('#tut-card').inert = false;
    tutRender();
    $('#tut-mask').classList.add('show');
    $('#tut-card').classList.add('show');
    $('#tut-card').focus({ preventScroll: true });
  }

  function tutClose(markSeen) {
    const anchor = tutState && tutState.anchor;
    if (tutState && markSeen !== false && TUTORIALS[tutState.page]) tutMarkSeen(tutState.page);
    tutState = null;
    document.body.classList.remove('tutorial-open');
    $('#tut-mask').classList.remove('show');
    $('#tut-card').classList.remove('show');
    $('#tut-card').inert = true;
    $('#tut-spotlight').classList.remove('show');
    $('#tut-spotlight').dataset.target = '';
    $('#tut-mask').style.clipPath = '';
    if (anchor && anchor.isConnected) anchor.focus({ preventScroll: true });
  }

  function tutGo(delta) {
    if (!tutState) return;
    tutRefreshSteps();
    const next = tutState.idx + delta;
    if (next < 0) return;
    if (next >= tutState.steps.length) { tutClose(true); return; }
    tutState.idx = next;
    tutRender();
  }

  function bindTutorial() {
    const entries = [
      ...['sort', 'copy', 'menu', 'login'].map(p => [`[data-page="${p}"] .titlebar .tb-tools`, p]),
      ['.dw-head', 'folders', '#fav-close'], ['.tp-head', 'tasks', '#taskpop-close'],
      ['.sortbar-tools', 'filters'], ['.sortbar-sort', 'sorting'],
      ['.sort-status-actions', 'saving', '#sort-save-state'],
      ['.dt-head', 'detail', '#detail-close'], ['.bp-head', 'pages', '#boxpanel-close'],
      ['[data-help="account"]', 'account'], ['[data-help="tasks"]', 'tasks'],
      ['#history-panel > .panel-h', 'history'], ['#keys-panel > .panel-h', 'keys'],
      ['#data-panel > .panel-h', 'data'],
      ['[data-help="source"]', 'source'], ['[data-help="target"]', 'target'],
      ['[data-help="options"]', 'options'],
      ['[data-page="login"] .panel-h', 'qr'], ['#cookie-panel .field > label', 'cookie'],
    ];
    for (const [selector, key, before] of entries) {
      const host = $(selector);
      if (!host) continue;
      const button = document.createElement('template');
      button.innerHTML = sectionHelpHtml(key);
      host.insertBefore(button.content.firstElementChild, before ? host.querySelector(before) : null);
    }
    // 任务等浮层会拦截冒泡，说明入口统一在捕获阶段处理。
    document.addEventListener('click', (e) => {
      const button = e.target.closest('[data-tut-open]');
      if (!button) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const key = button.dataset.tutOpen;
      tutOpen(tutorialFor(key) ? key : tutCurrentPage(), true, button);
    }, true);
    document.addEventListener('keydown', (e) => {
      if (!tutState) return;
      // 修改键位时，让这次按键交给键位录入，而不是教程翻页。
      if (capturingKey) return;
      if (keySpec(e) === shortcutOf('quickSave')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      // 聚焦在高亮控件里时保留它本来的输入、选择和确认行为。
      if (!['Escape', 'Tab'].includes(e.key) && tutState.target && tutState.target.contains(e.target)) return;
      // 说明打开时，按键只用于这张卡片，避免触发后面的整理快捷键。
      e.stopImmediatePropagation();
      if (['Escape', 'ArrowRight', 'ArrowLeft'].includes(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === 'Escape') tutClose(true);
        else tutGo(e.key === 'ArrowRight' ? 1 : -1);
      } else if (e.key === 'Tab') {
        const controls = Array.from($('#tut-card').querySelectorAll('button:not(:disabled)')).filter(el => el.offsetParent !== null);
        const target = tutState.target;
        if (tutVisible(target) && target.matches('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')) controls.push(target);
        const index = controls.indexOf(document.activeElement);
        e.preventDefault();
        controls[(index + (e.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
      }
    }, true);
    let frame = 0;
    const update = () => {
      if (!tutState || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; if (tutState) tutPlace(); });
    };
    window.addEventListener('scroll', update, { capture: true, passive: true });
    window.addEventListener('transitionend', update, true);
    window.addEventListener('animationend', update, true);
    new MutationObserver(update).observe($('.app'), { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
    // 弹窗在 .app 外；跟踪开关和内容替换，保持输入框等目标的位置准确。
    new MutationObserver(update).observe($('#modal-mask'), { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
    new MutationObserver(update).observe($('#ctx-menu'), { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
    document.addEventListener('click', update, true);
    document.addEventListener('contextmenu', update, true);
  }

  const CHIP_DIMS = [
    { key: 'fav_time', label: '收藏时间', field: 'fav_time' },
    { key: 'pubtime', label: '投稿时间', field: 'pubtime' },
    { key: 'play', label: '播放量', field: 'play' },
    { key: 'danmaku', label: '弹幕', field: 'danmaku' },
    { key: 'duration', label: '时长', field: 'duration' },
    { key: 'title', label: '标题', field: 'py', text: true },
    { key: 'upper', label: 'UP 主', field: 'py_upper', text: true },
  ];
  const CHIP_ACTIONS = [
    { key: 'reverse', label: '整体反转' },
    { key: 'invalid_mark', label: '一键标记失效项' },
  ];

  function renderSortChips() {
    const st = S.sort.sortDim;
    const parts = CHIP_DIMS.map((d) => {
      const on = st.key === d.key && st.dir !== 0;
      const tip = `${d.label}：按一下${d.text ? ' A→Z' : '从小到大'}，再按${d.text ? ' Z→A' : '从大到小'}，第三下还原`;
      return `<div class="chip dim${on ? ' on' : ''}" data-dim="${d.key}" title="${esc(tip)}">`
        + `${esc(d.label)}${on ? `<i class="dir">${st.dir > 0 ? '↑' : '↓'}</i>` : ''}</div>`;
    });
    parts.push('<span class="chip-sep"></span>');
    CHIP_ACTIONS.forEach((a) => {
      parts.push(`<div class="chip act" data-chip="${a.key}">${esc(a.label)}</div>`);
    });
    $('#sort-chips').innerHTML = parts.join('');
  }

  /** 排序按钮的状态复位（外面改过顺序之后调，免得快照对不上） */
  function resetSortDim() {
    S.sort.sortDim = { key: '', dir: 0, snapshot: null };
    renderSortChips();
  }

  /** 按某个维度排一遍。稳定排序：值相同的保持原来的先后 */
  function sortByDim(dim, asc) {
    const map = itemMap();
    const arr = S.sort.order.map((k, i) => [k, map.get(k), i]);
    arr.sort((a, b) => {
      if (!a[1] || !b[1]) return a[2] - b[2];
      let c;
      if (dim.text) {
        const sa = String(a[1][dim.field] || ''), sb = String(b[1][dim.field] || '');
        c = sa === sb ? 0 : (sa < sb ? -1 : 1);
      } else {
        const na = Number(a[1][dim.field]) || 0, nb = Number(b[1][dim.field]) || 0;
        c = na === nb ? 0 : (na < nb ? -1 : 1);
      }
      if (c !== 0) return asc ? c : -c;
      return a[2] - b[2];
    });
    return arr.map((x) => x[0]);
  }

  function applySortDim(key) {
    if (!S.sort.editing) { toast('预览模式不给排序，先点「开始整理」', 'warn'); return; }
    const dim = CHIP_DIMS.find((d) => d.key === key);
    if (!dim) return;
    const st = S.sort.sortDim;

    if (st.key !== key) {
      // 换了个维度：重新记快照，从升序开始
      st.key = key;
      st.dir = 1;
      st.snapshot = S.sort.order.slice();
    } else if (st.dir === 1) {
      st.dir = -1;
    } else if (st.dir === -1) {
      // 第三下：还原成第一次按它之前的样子
      const back = st.snapshot;
      st.key = '';
      st.dir = 0;
      st.snapshot = null;
      if (back && back.length === S.sort.order.length) {
        if (!pushHistory()) return;
        S.sort.order = back.slice();
        renderSortChips();
        renderSortList();
        updateSortStats();
        toast('顺序还原成按之前的样子了', 'info', 2600);
        return;
      }
      renderSortChips();
      return;
    }

    if (!pushHistory()) return;
    S.sort.order = sortByDim(dim, st.dir > 0);
    renderSortChips();
    renderSortList();
    updateSortStats();
    const way = st.dir > 0
      ? (dim.text ? 'A→Z' : '从小到大')
      : (dim.text ? 'Z→A' : '从大到小');
    toast(`${dim.label}：${way}（再按一下还能翻过来）`, 'info', 2600);
  }

  $('#sort-chips').addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const act = t.closest('[data-chip]');
    if (act) {
      if (act.dataset.chip === 'invalid_mark') handleInvalidMark();
      else applyStrategy(act.dataset.chip);
      return;
    }
    const dim = t.closest('[data-dim]');
    if (dim) applySortDim(dim.dataset.dim);
  });

  function itemMap() {
    const old = itemMap.cache;
    if (old && old.items === S.sort.items && old.extra === S.sort.extra
      && old.count === S.sort.items.length + (S.sort.extra || []).length) return old.map;
    const map = new Map();
    S.sort.items.forEach((it) => map.set(it.key, it));
    (S.sort.extra || []).forEach((it) => map.set(it.key, it));
    itemMap.cache = { items: S.sort.items, extra: S.sort.extra, count: S.sort.items.length + (S.sort.extra || []).length, map };
    return map;
  }

  function applyStrategy(strategy) {
    if (!S.sort.editing) { toast('预览模式不给排序，先点「开始整理」', 'warn'); return; }
    const map = itemMap();
    const items = S.sort.order.map((k) => map.get(k)).filter(Boolean);

    // 数值排序：相等时按"原来的相对位置"保持稳定，不额外打乱
    const numSort = (field, desc) => {
      const arr = items.map((it, i) => [it, i]);
      arr.sort((a, b) => {
        const va = Number(a[0][field]) || 0, vb = Number(b[0][field]) || 0;
        if (va !== vb) return desc ? vb - va : va - vb;
        return a[1] - b[1];
      });
      return arr.map((x) => x[0].key);
    };

    // 文本排序：比较的其实是后端算好的拼音串（纯 ASCII）
    const textSort = (field, desc) => {
      const arr = items.map((it, i) => [it, i]);
      arr.sort((a, b) => {
        const va = String(a[0][field] || ''), vb = String(b[0][field] || '');
        if (va !== vb) {
          const c = va < vb ? -1 : 1;
          return desc ? -c : c;
        }
        return a[1] - b[1];
      });
      return arr.map((x) => x[0].key);
    };

    const table = {
      fav_time_desc: () => numSort('fav_time', true),
      fav_time_asc: () => numSort('fav_time', false),
      pubtime_desc: () => numSort('pubtime', true),
      pubtime_asc: () => numSort('pubtime', false),
      title_asc: () => textSort('py', false),
      title_desc: () => textSort('py', true),
      upper_asc: () => textSort('py_upper', false),
      upper_desc: () => textSort('py_upper', true),
      play_desc: () => numSort('play', true),
      danmaku_desc: () => numSort('danmaku', true),
      collect_desc: () => numSort('collect', true),
      duration_asc: () => numSort('duration', false),
      duration_desc: () => numSort('duration', true),
      reverse: () => items.map((it) => it.key).reverse(),
      invalid_last: () => [
        ...items.filter((i) => !i.invalid),
        ...items.filter((i) => i.invalid),
      ].map((i) => i.key),
    };

    const run = table[strategy];
    if (!run) return;

    if (!pushHistory()) return;
    S.sort.order = run();
    resetSortDim();
    renderSortList();
    updateSortStats();
    toast('排好了，看看顺不顺眼～', 'ok');
  }

  // 不包含远程写入和系统剪贴板；条目元数据视为不可变，快照只复制可变部分。
  function localSnapshot() {
    return {
      order: S.sort.order.slice(), deleted: [...S.sort.deleted], extra: S.sort.extra.slice(),
      locked: [...S.sort.locked], pageSize: S.sort.pageSize, page: S.sort.page, lastBoxSize: S.sort.lastBoxSize,
      tags: S.tags.map(t => ({...t})), itemTags: [...S.itemTags].map(([k,v]) => [k,[...v]]),
      picked: [...S.sort.picked], anchor: S.sort.anchor,
    };
  }

  let localHistoryRevision = 0;
  let directFolderWrite = false;
  let sortSubmitPending = false;
  function pushHistory() {
    if (!S.sort.folder || S.sort.loading || sortWriteBusy()) return false;
    S.sort.stack.push(localSnapshot());
    if (S.sort.stack.length > 60) S.sort.stack.shift();
    S.sort.redo.length = 0;
    localHistoryRevision += 1;
    return true;
  }

  function sortWriteBusy() { return directFolderWrite || sortSubmitPending || (S.task.busy && S.task.kind !== 'copy'); }

  function sortTouched() {
    return S.sort.order.join(',') !== S.sort.original.join(',')
      || S.sort.deleted.size > 0 || S.sort.extra.length > 0;
  }

  function localDraftNeeded() {
    return sortTouched() || S.sort.stack.length > 0 || S.sort.redo.length > 0 || S.sort.locked.size > 0;
  }

  function applyOrder(next) {
    S.sort.order = next;
    resetSortDim(); renderSortList(); updateSortStats(); renderBoxPanelIfOpen();
  }

  function restoreLocalSnapshot(snapshot) {
    // 兼容升级前内存里仅含顺序的历史。
    if (Array.isArray(snapshot)) { applyOrder(snapshot.slice()); return; }
    S.sort.order = snapshot.order.slice();
    S.sort.deleted = new Set(snapshot.deleted);
    S.sort.extra = snapshot.extra.slice();
    S.sort.locked = new Set(snapshot.locked);
    S.sort.pageSize = snapshot.pageSize;
    S.sort.lastBoxSize = snapshot.lastBoxSize || snapshot.pageSize || 30;
    S.sort.page = snapshot.page;
    S.tags = snapshot.tags.map(t => ({...t}));
    S.itemTags = new Map(snapshot.itemTags.map(([k,v]) => [k,new Set(v)]));
    const restoredKeys = new Set(S.sort.order);
    S.sort.picked = new Set((snapshot.picked || []).filter(k => restoredKeys.has(k)));
    S.sort.anchor = snapshot.anchor || '';
    S.tagFilter = new Set([...S.tagFilter].filter(id => S.tags.some(t => t.id === id)));
    lsSave('bilifav.pageSize', String(S.sort.pageSize), '每页数量');
    saveTags(); resetSortDim(); renderSortList(); updateSortStats(); updatePickedUI();
    renderBoxPanelIfOpen();
    if (detailKey && !itemMap().has(detailKey)) closeDetail();
    else if (detailKey && $('#detail').classList.contains('show')) openDetail(detailKey);
    const list = $('#tag-list'); if (list) list.innerHTML = tagListHtml();
  }

  function undoSort() {
    if (sortWriteBusy() || S.sort.loading) { toast('任务运行或列表读取时暂不能撤销', 'warn'); return; }
    if (!S.sort.stack.length) { toast('没有可以撤销的啦', 'warn'); return; }
    S.sort.redo.push(localSnapshot());
    localHistoryRevision += 1;
    if (S.sort.redo.length > 60) S.sort.redo.shift();
    restoreLocalSnapshot(S.sort.stack.pop()); toast('已撤销一步本地操作');
  }

  function redoSort() {
    if (sortWriteBusy() || S.sort.loading) { toast('任务运行或列表读取时暂不能重做', 'warn'); return; }
    if (!S.sort.redo.length) { toast('没有可以重做的啦', 'warn'); return; }
    S.sort.stack.push(localSnapshot());
    localHistoryRevision += 1;
    restoreLocalSnapshot(S.sort.redo.pop()); toast('已重做一步本地操作');
  }

  function resetSort() {
    if (!sortTouched()) { toast('本来就跟线上一样，不用还原', 'warn'); return; }
    if (!pushHistory()) return;
    S.sort.order = S.sort.original.slice();
    S.sort.deleted = new Set();
    S.sort.extra = [];
    applyOrder(S.sort.order);
    toast('已经还原成线上的样子（顺序和增删标记都清掉了）');
  }

  $('#sort-undo').addEventListener('click', undoSort);
  $('#sort-redo').addEventListener('click', redoSort);
  $('#sort-reset').addEventListener('click', resetSort);

  /**
   * 焦点是不是在"能打字的地方"（输入框 / 文本域 / 下拉 / contenteditable）。
   *
   * 剪贴板快捷键得先问这一句：往「添加视频」的框里粘链接，本来就该是
   * 把文字粘进去。全局那条 Ctrl+V 要是不分场合地拦下来，就会变成
   * "粘贴卡片"，链接死活进不了输入框（用户报的就是这个问题）。
   */
  function keyInTypingBox(e) {
    const t = e.target;
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (t.isContentEditable) return true;
    return !!(t.closest && t.closest('[contenteditable="true"]'));
  }

  // 固定的卡片剪贴板键；撤销、重做统一由后面的可配置快捷键分发。
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || capturingKey) return;
    const act = document.querySelector('.page.active');
    if (!act || act.dataset.page !== 'sort') return;
    if (SHORTCUT_DEFS.some(d => !d.locked && (d.modes & currentShortcutMode()) && shortcutOf(d.id) === keySpec(e))) return;
    /*
      两种情况一律让路，让输入框 / 弹窗自己处理这几个键：
        · 焦点在能打字的控件里 —— 复制粘贴撤销是文本框自己的事
        · 弹窗开着 —— 那时候用户在跟弹窗打交道，改卡片剪贴板没道理
    */
    if (keyInTypingBox(e)) return;
    if ($('#modal-mask').classList.contains('show')) return;
    const k = (e.key || '').toLowerCase();
    // 卡片剪贴板。只在整理模式下生效 —— 预览模式本来就不给改东西，
    // 在那儿按 Ctrl+X 结果卡片被标成待删，会很莫名其妙。
    if (k === 'c' && !e.shiftKey) {
      /*
        复制：只读操作，预览模式也能用。

        优先级 —— **多选优先**：
        多选模式下点卡片会"顺手把详情打开"（这是原有设计），所以详情开着
        完全不代表用户只想复制那一个。反过来，只要多选里有东西，
        那就是用户明确挑过的，按 Ctrl+C 该复制这一批。
        没多选、纯看详情时，才复制眼前这一个。
        （详情头部那个「复制」按钮不受此限，点它永远只复制这一个。）
      */
      e.preventDefault();
      if (pickedList().length) clipTake(false, '');
      else {
        const dtEl = $('#detail');
        if (detailKey && dtEl && dtEl.classList.contains('show')) clipTakeOne(detailKey);
        else clipTake(false, '');
      }
    } else if (k === 'x' && !e.shiftKey) {
      // 剪切会改东西（标记待删），不在整理模式就顺手切进去 ——
      // 拦下来让用户再点一次按钮太别扭了
      if (!S.sort.editing) setSortMode(true);
      e.preventDefault();
      clipTake(true, '');
    } else if (k === 'v' && !e.shiftKey) {
      // 粘贴同理。跨收藏夹复制时尤其需要：切个收藏夹模式就重置了
      // （loadSortFolder 会调 resetSortMode），不自动切的话用户
      // 刚复制完切过去，按 Ctrl+V 却被要求先点按钮。
      if (!S.sort.editing) setSortMode(true);
      e.preventDefault();
      clipPaste('');
    }
  });

  let filterTimer = null;
  $('#sort-filter').addEventListener('input', (e) => {
    S.sort.filter = e.target.value.trim().toLowerCase();
    // 范围选「本收藏夹」时，关键词一清空，底下的翻页/页码得跟着回来
    updatePageUI();
    // 输入的时候等一下再重建列表，别每敲一个字就把上千行重来一遍
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { renderSortList(); updateSortStats(); }, 130);
  });

  /*
    筛选范围开关：本页 / 本收藏夹。
    默认「本页」—— 跟以前一模一样，只是多了一个能跨页找的选项。
    这个选择记在本机（跟每页多少个、侧栏宽度一样走 lsSave），下次进来还是它。
  */
  try {
    const savedScope = localStorage.getItem('bilifav.filterScope');
    if (savedScope === 'folder' || savedScope === 'page') S.sort.filterScope = savedScope;
  } catch (_) { /* 读不到就用默认的本页 */ }
  $('#sort-scope').addEventListener('click', () => {
    const next = S.sort.filterScope === 'folder' ? 'page' : 'folder';
    S.sort.filterScope = next;
    lsSave('bilifav.filterScope', next, '筛选范围');
    S.sort.page = 1;
    updatePageUI();
    renderSortList();
    updateSortStats();
    toast(next === 'folder'
      ? '筛选范围：本收藏夹 —— 整个夹子一起筛，命中的一次全铺出来'
      : '筛选范围：本页 —— 只筛眼前这一页',
      'info', 3200);
  });

  /* -------- 日期筛选（按收藏日期挑一段） -------- */
  /** <input type="date"> 的值 → 时间戳（起头取当天 0 点，末尾取当天最后一秒） */
  function dateInputToTs(value, isEnd) {
    if (!value) return 0;
    const d = new Date(`${value}T${isEnd ? '23:59:59' : '00:00:00'}`);
    return Number.isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
  }

  function resetDateFilter(quiet) {
    S.sort.dateFrom = 0;
    S.sort.dateTo = 0;
    const a = $('#sort-date-from');
    const b = $('#sort-date-to');
    if (a) a.value = '';
    if (b) b.value = '';
    const box = $('#sort-dateflt');
    if (box) box.classList.remove('on');
    const clr = $('#sort-date-clear');
    if (clr) clr.classList.add('hidden');
    if (!quiet) { renderSortList(); updateSortStats(); }
  }

  function applyDateFilter() {
    S.sort.dateFrom = dateInputToTs(($('#sort-date-from') || {}).value || '', false);
    S.sort.dateTo = dateInputToTs(($('#sort-date-to') || {}).value || '', true);
    const on = !!(S.sort.dateFrom || S.sort.dateTo);
    $('#sort-dateflt').classList.toggle('on', on);
    $('#sort-date-clear').classList.toggle('hidden', !on);
    S.sort.page = 1;
    renderSortList();
    updateSortStats();
    // 说一句筛出多少，免得看到空列表以为收藏夹被清空了
    if (on) {
      const map = itemMap();
      const n = S.sort.order.filter((k) => matchDateFilter(map.get(k) || {})).length;
      toast(n ? `这个日期段里有 ${n} 条` : '这个日期段里一条都没有', n ? 'ok' : 'warn', 3000);
    }
  }

  $('#sort-date-from').addEventListener('change', applyDateFilter);
  $('#sort-date-to').addEventListener('change', applyDateFilter);
  $('#sort-date-clear').addEventListener('click', () => {
    resetDateFilter(true);
    applyDateFilter();
    toast('日期筛选清掉了', 'info', 2400);
  });

  /* -------- 卡片网格渲染 + 拖拽 -------- */
  /*
    整理页是一屏卡片。拖动分两种：
      · 落到两张卡之间的缝隙 → 插入（光柱提示 + 两侧卡片收窄让位）
      · 落到某张卡的中心     → 交换（那张卡高亮 + 浮出 ⇄）
    序号、时长、失效角标都画在卡片上；本次改动用左上角序号变色 + 缎带表示。

    大收藏夹上千张卡时，卡不卡就看这三条：
      1. 渲染一次性拼 HTML，序号和"是否挪过"都在循环外用 Map/Set 查，整体 O(n)；
      2. 卡片上的按钮和拖拽全走事件委托，列表重建之后不用重挂监听；
      3. 拖动时复用卡片快照；侧栏动画或窗口变化使网格移动 / 缩放时才重拍，
         判定结果没变就不重复修改落点提示。
  */
  const sortGrid = $('#sort-list');
  const cardElOf = new Map();      // key -> 卡片元素
  const cnumElOf = new Map();      // key -> 序号元素

  function newKeySet() {
    const s = new Set();
    (S.sort.extra || []).forEach((it) => s.add(it.key));
    return s;
  }

  /** 选中的标签取并集：有其中任意一个就算命中；一个都没选就全放行 */
  function matchTagFilter(k) {
    if (!S.tagFilter.size) return true;
    const mine = S.itemTags.get(k);
    if (!mine || !mine.size) return false;
    for (const id of S.tagFilter) if (mine.has(id)) return true;
    return false;
  }

  /**
   * 日期筛选：按**收藏时间**挑一段。
   *
   * 没有收藏时间的条目（失效稿件、接口没给时间的）在开了日期筛选时不显示 ——
   * 没时间就无从判断它在不在你选的范围里，与其猜不如藏起来。
   */
  function matchDateFilter(it) {
    if (!S.sort.dateFrom && !S.sort.dateTo) return true;
    const t = Number(it.fav_time || 0);
    if (!t) return false;
    if (S.sort.dateFrom && t < S.sort.dateFrom) return false;
    if (S.sort.dateTo && t > S.sort.dateTo) return false;
    return true;
  }

  function matchSortFilter(k, it) {
    const kw = S.sort.filter;
    return matchTagFilter(k) && matchDateFilter(it)
      && (!kw || String(it.title || '').toLowerCase().includes(kw)
        || String(it.upper || '').toLowerCase().includes(kw));
  }

  /**
   * 这次筛选是「只筛本页」还是「整个收藏夹」？
   *
   * 关键词空着的时候两者没区别，一律按本页走：
   * 不然空筛选也会把整个收藏夹铺出来，页码还停在「第 1 页」，看着像坏了。
   */
  function filterAllScope() {
    return S.sort.filterScope === 'folder' && !!S.sort.filter;
  }

  /**
   * 这一屏该铺哪些条目。
   *
   * 整夹筛选时不存在"页"这回事 —— 命中的全部铺出来。卡片的序号仍然是
   * 它在完整清单里的原始位次，所以看完能顺着号回去找它。
   */
  function renderSlice() {
    if (filterAllScope()) return { from: 0, to: S.sort.order.length, pages: 1 };
    return pageSlice();
  }

  function durationTotal(keys, map) {
    let count = 0, seconds = 0, unknown = 0;
    for (const k of keys) {
      const it = map.get(k);
      if (!it || it.invalid || S.sort.deleted.has(k)) continue;
      count += 1;
      const duration = Number(it.duration);
      if (Number.isFinite(duration) && duration > 0) seconds += duration;
      else unknown += 1;
    }
    return { count, seconds, unknown };
  }

  function sameDataSignature(a, b) { return !!a && a.length === b.length && a.every((v,i) => v === b[i]); }

  function sortDurationIndex(map) {
    const signature = [S.sort.items,S.sort.extra,S.sort.extra.length,S.sort.order,S.sort.order.length,
      S.sort.deleted,S.sort.deleted.size,localHistoryRevision];
    if (sameDataSignature(sortDurationIndex.cache?.signature, signature)) return sortDurationIndex.cache;
    const n = S.sort.order.length, seconds = new Float64Array(n+1), unknown = new Uint32Array(n+1), count = new Uint32Array(n+1);
    const indices = new Map();
    for (let i = 0; i < n; i++) {
      const key = S.sort.order[i], it = map.get(key), valid = it && !it.invalid && !S.sort.deleted.has(key);
      const duration = Number(it?.duration);
      indices.set(key,i); seconds[i+1] = seconds[i]; unknown[i+1] = unknown[i]; count[i+1] = count[i];
      if (valid) { count[i+1]++; if (Number.isFinite(duration) && duration > 0) seconds[i+1] += duration; else unknown[i+1]++; }
    }
    return sortDurationIndex.cache = {signature,seconds,unknown,count,indices};
  }

  function updateDurationSummary(map = itemMap()) {
    const box = $('#sort-duration-summary');
    if (!box) return;
    if (!S.sort.folder) { box.textContent = ''; return; }
    const base = sortDurationIndex(map), slice = renderSlice();
    const signature = [base,S.sort.filter,S.sort.dateFrom,S.sort.dateTo,[...S.tagFilter].join(','),
      S.itemTags,S.itemTags.size,slice.from,slice.to,filterAllScope()];
    let cached = updateDurationSummary.cache;
    if (!sameDataSignature(cached?.signature,signature)) {
      const matching = S.sort.order.filter(k => { const it = map.get(k); return it && matchSortFilter(k,it); });
      cached = updateDurationSummary.cache = {signature,scope: durationTotal(matching,map),
        page: durationTotal(matching.filter(k => {const i=base.indices.get(k);return i>=slice.from&&i<slice.to}),map)};
    }
    const filtered = !!(S.sort.filter || S.tagFilter.size || S.sort.dateFrom || S.sort.dateTo);
    const picked = [...S.sort.picked].filter(k => base.indices.has(k));
    const rows = [['scope',filtered?'筛选结果':'全部',cached.scope],
      ['page',filterAllScope()?'当前显示':'本页',cached.page],['picked','已选（跨页）',durationTotal(picked,map)]];
    const html = rows.map(([id,label,stat]) =>
      `<span data-duration="${id}" title="不含待删除和失效视频；已选时长包含其他页及筛选外的选择">${label} <b>${stat.count} 条 · ${fmtDuration(stat.seconds)}</b>${stat.unknown?`（${stat.unknown} 条时长未知）`:''}</span>`
    ).join('') + sectionHelpHtml('duration','时长怎么算');
    if (box._summaryHtml !== html || !box.firstElementChild) { box.innerHTML = html; box._summaryHtml = html; }
    const cumulative = $('#dt-cumulative');
    if (cumulative) {
      const end = (base.indices.get(cumulative.dataset.key) ?? -1) + 1;
      cumulative.textContent = `${fmtDuration(base.seconds[end])}${base.unknown[end]?`（${base.unknown[end]} 条时长未知）`:''}`;
    }
  }

  /** 当前搜索词之下，真正显示出来的 key（顺序同 order） */

  /*
    一页 30 张，排几列？

    只允许两个答案：6 列（6×5）或 5 列（5×6）—— 乘起来都是 30，正好一页。
    取 6 列的条件是"每张至少 178px 宽"，窄了就退回 5 列（卡片反而更大）。

    侧边栏拉开/收起会改变可用宽度，所以抽屉开关、拖侧栏、窗口缩放
    都要重算一次 —— 这就是"卡片随侧边栏变大变小"。
  */
  /*
    每页多少 → 排成几列几行。

    档位是固定的排布（用户要的）：
       20 个 → 5×4      30 个 → 6×5      50 个 → 10×5
    自定义 = 自己填每页多少，列数按可用宽度算（跟原来那套一样）
    无限   = 平铺，全部铺出来，列数也按宽度算

    注意：档位是**每页多少个**，不是"多少页" —— 面板上写的是"20 个 / 5×4"，
    免得看岔。
  */
  const CARD_MIN_W = 150;

  /** 当前档位要固定几列（返回 0 表示按宽度自适应） */
  function fixedColsForSize(size) {
    if (size === 20) return 5;
    if (size === 30) return 6;
    if (size === 50) return 10;
    return 0;
  }

  function calcGridCols() {
    // 先看档位有没有规定死列数
    const fixed = fixedColsForSize(S.sort.pageSize);
    if (fixed) return fixed;

    const box = $('#sort-list');
    if (!box) return 6;
    const cs = getComputedStyle(box);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const gap = 10;
    const avail = box.clientWidth - pad;
    // 自定义 / 无限：按可用宽度分开，每张至少 CARD_MIN_W
    return Math.max(2, Math.floor((avail + gap) / (CARD_MIN_W + gap)));
  }

  function applyGridCols() {
    if (!sortGrid) return;
    const cols = calcGridCols();
    if (sortGrid.dataset.cols === String(cols)) return;
    sortGrid.dataset.cols = String(cols);
    sortGrid.style.setProperty('--cols', String(cols));
  }

  function sortCardHtml(k, i, it, moved, newSet) {
      const isNew = newSet.has(k);
      const isDel = S.sort.deleted.has(k);

      const changed = moved.has(k);
      const bar = tagBarHtml(k);
      const picked = S.sort.picked.has(k);
      const cls = 'card'
        + (it.invalid ? ' invalid' : '')
        + (isDel ? ' deleted' : '')
        + (isNew ? ' isnew' : '')
        + (changed ? ' dirty' : '')
        + (picked ? ' picked' : '')
        + (bar ? ' has-tags' : '');
      // 预览模式下也保留 draggable —— 长按拖动会自动切进整理模式，
      // 到底给不给拖在 dragstart 里判断。
      const canDrag = true;

      // 卡片左上角的按钮：平时藏着，鼠标放上去才露出来，不抢封面的戏
      // 预览模式下整组都不生成
      const cact = !S.sort.editing ? ''
        : isNew
          ? '<span class="cact" data-cact="drop-new" title="不放这个了"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round"><use href="#i-x"/></svg></span>'
          : isDel
            ? '<span class="cact" data-cact="undelete" title="不删了，留下它"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-undo"/></svg></span>'
            : '<span class="cact" data-cact="delete" title="从这个收藏夹里删掉（提交后才真的删）"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-trash"/></svg></span>';

      // 注意：待删除不再挂一条「待删除」缎带 —— 卡片变灰 + 划线 + 右上角换成撤销键，
      // 已经够明显了，再来一条横幅反而把封面压得看不清。
      return `<div class="${cls}" data-key="${esc(k)}" draggable="${canDrag ? 'true' : 'false'}">
        ${isNew ? '<span class="newflag">新追加</span>' : ''}
        <div class="thumb">
          <span class="cnum">${i + 1}</span>
          ${it.invalid ? '<span class="ban"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.6" stroke-linecap="round"><use href="#i-ban"/></svg></span>' : ''}
          ${cact}
          ${it.cover ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(httpsify(it.cover))}" alt="">` : '<span class="ph">🎬</span>'}
          <span class="dur">${fmtDuration(it.duration)}</span>
          ${bar}
        </div>
        <div class="title">${esc(it.title || '(无标题)')}</div>
        <div class="meta"><span>${esc(it.upper || '未知 UP')}</span><span>${fmtNum(it.play)}</span></div>
      </div>`;
  }

  let sortVirtual = null;
  let virtualFrame = null;

  function renderVirtualWindow(refresh = false) {
    const view = sortVirtual;
    if (!view) return;
    const style = getComputedStyle(sortGrid);
    const cols = Number(sortGrid.dataset.cols) || 6;
    const left = parseFloat(style.paddingLeft) || 0, right = parseFloat(style.paddingRight) || 0;
    const top = parseFloat(style.paddingTop) || 0, gap = parseFloat(style.columnGap) || 10;
    const width = Math.max(1, (sortGrid.clientWidth - left - right - gap * (cols - 1)) / cols);
    const changed = view.width !== width || view.cols !== cols;
    if (changed) {
      // 固定两行标题与一行 UP 资料，行高随封面宽度变化，保持原卡片造型。
      view.height = Math.ceil(Math.max(0, width - 14) * 10 / 16 + 62);
      view.width = width; view.cols = cols;
      sortGrid.style.setProperty('--virtual-card-h', view.height + 'px');
    }
    const stride = view.height + gap, rows = Math.ceil(view.entries.length / cols);
    view.space.style.height = Math.max(0, rows * stride - gap) + 'px';
    const start = Math.max(0, Math.floor((sortGrid.scrollTop - top) / stride) - 3) * cols;
    const end = Math.min(view.entries.length, (Math.ceil((sortGrid.scrollTop + sortGrid.clientHeight - top) / stride) + 3) * cols);
    if (!refresh && !changed && view.start === start && view.end === end) return;
    view.start = start; view.end = end;
    const needed = new Set(view.entries.slice(start, end).map(e => e.key));
    if (dragState?.key && view.positions.has(dragState.key)) needed.add(dragState.key);
    for (const [key, el] of view.nodes) {
      if (needed.has(key)) continue;
      el.remove(); view.nodes.delete(key); cardElOf.delete(key); cnumElOf.delete(key);
    }
    const template = document.createElement('template');
    for (const key of needed) {
      const position = view.positions.get(key), entry = view.entries[position];
      let el = view.nodes.get(key);
      if (!el || (refresh && key !== dragState?.key)) {
        template.innerHTML = sortCardHtml(key, entry.index, view.map.get(key), view.moved, view.newSet);
        const card = template.content.firstElementChild;
        if (!el) { el = card; view.nodes.set(key, el); sortGrid.appendChild(el); }
        else { el.className = card.className; el.innerHTML = card.innerHTML; }
      }
      el.style.left = (left + position % cols * (width + gap)) + 'px';
      el.style.top = (top + Math.floor(position / cols) * stride) + 'px';
      el.style.width = width + 'px';
      el.querySelector('.cnum').textContent = String(entry.index + 1);
      el.classList.toggle('picked', S.sort.picked.has(key));
      el.classList.toggle('dirty', view.moved.has(key));
      cardElOf.set(key, el); cnumElOf.set(key, el.querySelector('.cnum'));
    }
    if (dragState?.key) {
      clearDragMarks();
      const shot = snapshotGrid();
      dragState.snap = shot.snap; dragState.list = shot.list; dragState.gridRect = shot.gridRect;
      dragState.lastKey = '';
    }
  }

  function renderSortList() {
    applyGridCols();
    const map = itemMap(), order = S.sort.order, slice = renderSlice();
    const moved = movedKeySet(), newSet = newKeySet();
    updateDurationSummary(map);
    const entries = [];
    for (let i = slice.from; i < slice.to; i++) {
      const key = order[i], it = map.get(key);
      if (it && matchSortFilter(key, it)) entries.push({key, index: i});
    }
    if (entries.length > 180) {
      sortGrid.classList.add('virtual-grid');
      let nodes = sortVirtual?.nodes || new Map();
      let space = sortVirtual?.space;
      if (!space || space.parentNode !== sortGrid) {
        sortGrid.replaceChildren(); cardElOf.clear(); cnumElOf.clear(); nodes = new Map();
        space = document.createElement('div'); space.className = 'virtual-space'; sortGrid.appendChild(space);
      }
      sortVirtual = {entries, nodes, space, map, moved, newSet, positions: new Map(entries.map((e,i) => [e.key,i]))};
      ensureDropline(); renderVirtualWindow(true);
      return;
    }
    sortVirtual = null; sortGrid.classList.remove('virtual-grid');
    cardElOf.clear(); cnumElOf.clear();
    if (!entries.length) {
      const why = S.sort.filter ? (filterAllScope() ? '整个收藏夹里没筛出东西来' : '这一页没筛出东西来')
        : S.tagFilter.size ? '这个标签下还没有视频' : '收藏夹是空的';
      sortGrid.innerHTML = `<div class="empty"><span class="em">${S.sort.filter || S.tagFilter.size ? '🔍' : '🫧'}</span><p>${why}</p></div>`;
    } else {
      sortGrid.innerHTML = entries.map(e => sortCardHtml(e.key, e.index, map.get(e.key), moved, newSet)).join('');
      for (const el of sortGrid.children) {
        cardElOf.set(el.dataset.key, el); cnumElOf.set(el.dataset.key, el.querySelector('.cnum'));
      }
    }
    ensureDropline();
  }

  sortGrid.addEventListener('scroll', () => {
    if (!sortVirtual || virtualFrame !== null) return;
    virtualFrame = requestAnimationFrame(() => { virtualFrame = null; renderVirtualWindow(); });
  }, {passive: true});
  const virtualResize = new ResizeObserver(() => { applyGridCols(); if (sortVirtual) renderVirtualWindow(); });
  virtualResize.observe(sortGrid);

  /* 卡片左上角按钮：删除 / 不删了 / 放弃新增（委托一次） */
  let downInCact = false;
  sortGrid.addEventListener('mousedown', (e) => {
    downInCact = !!(e.target.closest && e.target.closest('.cact'));
  }, true);

  sortGrid.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-cact]');
    if (!btn) return;
    e.stopPropagation();
    e.preventDefault();
    const card = btn.closest('.card');
    const k = card && card.dataset.key;
    if (!k) return;
    const act = btn.dataset.cact;
    if (!S.sort.editing || S.sort.loading || sortWriteBusy()) return;
    if (!pushHistory()) return;
    if (act === 'delete') {
      S.sort.deleted.add(k);
    } else if (act === 'undelete') {
      S.sort.deleted.delete(k);
    } else if (act === 'drop-new') {
      S.sort.extra = (S.sort.extra || []).filter((x) => x.key !== k);
      S.sort.order = S.sort.order.filter((x) => x !== k);
      S.sort.deleted.delete(k);
      S.sort.picked.delete(k);
    }
    renderSortList();
    updateSortStats();
  });

  /* ---------------- 拖拽 ---------------- */
  const dropLine = document.createElement('div');
  dropLine.className = 'dropline';
  const dragGhost = document.createElement('div');
  dragGhost.className = 'drag-ghost';
  document.body.appendChild(dragGhost);

  let dragState = null;

  function ensureDropline() {
    if (dropLine.parentNode !== sortGrid) sortGrid.appendChild(dropLine);
  }

  function cardsNow() {
    const out = [];
    for (const el of sortGrid.children) {
      if (el.classList.contains('card')) out.push(el);
    }
    if (sortVirtual) out.sort((a,b) => sortVirtual.positions.get(a.dataset.key) - sortVirtual.positions.get(b.dataset.key));
    return out;
  }

  /** 卡片用布局坐标，避免落点提示的 transform 动画影响判定。 */
  function snapshotGrid() {
    const gridRect = sortGrid.getBoundingClientRect();
    const list = cardsNow();
    const snap = list.map((c) => {
      const w = c.offsetWidth, h = c.offsetHeight;
      const l = c.offsetLeft, t = c.offsetTop;
      return { left: l, top: t, right: l + w, bottom: t + h, width: w, height: h, el: c, key: c.dataset.key };
    });
    return { gridRect, snap, list };
  }

  function refreshDragGeometry() {
    if (!dragState?.key) return;
    // 页目录自动展开有 240ms 让位动画。只比较网格外框，实际移动或缩放时
    // 才重拍卡片；不能一直沿用 dragstart 那一刻的宽度和视口位置。
    const rect = sortGrid.getBoundingClientRect();
    const old = dragState.gridRect;
    if (old && ['left', 'top', 'width', 'height'].every(k => Math.abs(rect[k] - old[k]) < 0.1)) return;
    clearDragMarks();
    const shot = snapshotGrid();
    dragState.snap = shot.snap;
    dragState.list = shot.list;
    dragState.gridRect = shot.gridRect;
    dragState.lastKey = '';
  }

  function toLocal(x, y) {
    /*
      鼠标给的是**视口坐标**，快照里的 left/top 是**内容坐标**
      （offsetLeft/offsetTop，不受滚动影响）。网格自己会滚，
      所以这里必须把滚过的距离加回来。

      以前忘了加：网格一滚，判定就整体往上偏了一屏滚动量 ——
      每页 20 / 30 那种卡片大、内容比可视区高的档位一定滚，
      于是最后一排永远够不着（它的 offsetTop 比可视高度还大），
      落点也总是落在目标上面一行，看着就是"拖乱了"。
    */
    return {
      x: x - dragState.gridRect.left + sortGrid.scrollLeft,
      y: y - dragState.gridRect.top + sortGrid.scrollTop,
    };
  }

  function nearestCard(x, y) {
    const snap = dragState.snap;
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < snap.length; i++) {
      const r = snap[i];
      const cx = Math.max(r.left, Math.min(x, r.right));
      const cy = Math.max(r.top, Math.min(y, r.bottom));
      const dx = x - cx, dy = y - cy;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = { idx: i, box: r, dist: Math.sqrt(d) }; }
    }
    return best;
  }

  /** 这次落在哪儿、是插入还是交换 */
  function decide(clientX, clientY) {
    if (!dragState) return null;
    if (sortVirtual) renderVirtualWindow();
    refreshDragGeometry();
    const p = toLocal(clientX, clientY);
    const n = nearestCard(p.x, p.y);
    const block = (dragState.block && dragState.block.length) ? dragState.block : [dragState.key];
    if (!n || block.includes(n.box.key)) return null;

    const r = n.box;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    /*
      落点只有三种：left（插到这张前面）、right（插到这张后面）、swap（跟这张对调）。

      这里**故意不返回 top / bottom**：曾经返过，结果 paintTarget 只认 left/right，
      上缘下缘就掉进"画在卡片正中"的兜底分支里 —— 竖线跑到卡片中间，
      看着像要插到缝里，松开却因为判定的是插入而让人以为没反应。
      上下缘本来就是"插到前面 / 后面"，直接归一成 left / right，视觉和行为就一致了。
    */
    if (n.dist > 1) {
      // 落在卡片外面（缝里 / 空白）→ 一律当插入
      const hx = Math.abs(p.x - cx) / r.width;
      const hy = Math.abs(p.y - cy) / r.height;
      if (hx > hy) return { key: r.key, mode: p.x < cx ? 'left' : 'right' };
      return { key: r.key, mode: p.y < cy ? 'left' : 'right' };
    }

    const dl = p.x - r.left, dr = r.right - p.x, dt = p.y - r.top, db = r.bottom - p.y;
    const tx = r.width * 0.28, ty = r.height * 0.24;
    const m = Math.min(dl, dr, dt, db);
    if (m === dl && dl < tx) return { key: r.key, mode: 'left' };
    if (m === dr && dr < tx) return { key: r.key, mode: 'right' };
    if (m === dt && dt < ty) return { key: r.key, mode: 'left' };    // 上缘 = 插到前面
    if (m === db && db < ty) return { key: r.key, mode: 'right' };   // 下缘 = 插到后面
    return { key: r.key, mode: 'swap' };
  }

  function clearDragMarks() {
    if (dragState && dragState.marked) {
      dragState.marked.forEach((el) => el.classList.remove('gap-left', 'gap-right', 'swap-target'));
      dragState.marked.length = 0;
    }
  }

  function paintTarget(res, fallbackEl) {
    const gridRect = dragState.gridRect;
    if (res.mode === 'swap') {
      const el = cardElOf.get(res.key) || fallbackEl;
      if (el) { el.classList.add('swap-target'); dragState.marked.push(el); }
      dropLine.style.display = 'none';
      return;
    }

    const el = cardElOf.get(res.key);
    if (!el) { dropLine.style.display = 'none'; return; }
    // 两侧卡片收窄让位；位置一律按快照算，免得读布局
    const idx = dragState.snap.findIndex((s) => s.key === res.key);
    const box = idx >= 0 ? dragState.snap[idx] : null;

    if (res.mode === 'left') {
      el.classList.add('gap-right');
      dragState.marked.push(el);
      const prev = idx > 0 ? cardElOf.get(dragState.snap[idx - 1].key) : null;
      if (prev && prev !== dragState.el) { prev.classList.add('gap-left'); dragState.marked.push(prev); }
    } else {
      // right：让出右边
      el.classList.add('gap-left');
      dragState.marked.push(el);
      const next = idx >= 0 && idx + 1 < dragState.snap.length ? cardElOf.get(dragState.snap[idx + 1].key) : null;
      if (next && next !== dragState.el) { next.classList.add('gap-right'); dragState.marked.push(next); }
    }

    // 光柱钉在缝隙正中：用快照坐标（跟让位动画的 transform 无关，不会左右跳）。
    // decide 已经把落点归一成 left / right，所以这里只有两种，
    // 不再有"兜底画在卡片正中"的分支 —— 那正是之前竖线跑偏的原因。
    const GAP = 6;
    const cx = box ? (res.mode === 'left' ? box.left - GAP : box.right + GAP) : 0;
    const top = box ? box.top : 0;
    const h = box ? box.height : 0;
    dropLine.style.left = (cx - 7) + 'px';
    dropLine.style.top = (top + 6) + 'px';
    dropLine.style.height = Math.max(0, h - 12) + 'px';
    dropLine.style.display = 'block';
    /*
      光柱是网格的子元素、跟着内容一起滚，所以它要的本来就是内容坐标 ——
      快照给的就是内容坐标，**不用**再减 scrollTop。
      （以前减了一次，等于双重补偿：滚过之后光柱反而比目标高出一屏。）
    */
    dropLine.style.transform = '';
  }

  function attachDrag() {
    dragState = {
      key: null,
      el: null,
      block: [],          // 这次拖的是哪几张（单张时就是 [key]）
      snap: [],
      list: [],
      gridRect: null,
      gridTop: 0,
      marked: [],
      lastKey: '',
      scrollDir: 0,
      edgeDist: 0,
      lastX: 0,
      lastY: 0,
    };
  }

  /* -------- 长按拖动：预览模式下按住一会儿就能直接拖 -------- */
  /*
    预览本来是只读的。但"想挪一下"是很自然的动作，所以做成：
    按住卡片约 380ms（这时卡片会亮一圈，提示可以拖了），再拖就自动切进整理模式。
    短拖一概不理会 —— 免得只是想滚动、或者随手点一下，就被切进编辑态。
  */
  const LONG_PRESS_MS = 380;
  let cardPressAt = 0;
  let cardPressTimer = null;
  // 预览模式下长按拖动：拖完这一下再切整理模式（拖的过程中切会把拖拽搞没）
  let switchAfterDrag = false;

  function clearLongPress() {
    cardPressAt = 0;
    if (cardPressTimer) { clearTimeout(cardPressTimer); cardPressTimer = null; }
    $$('#sort-list .card.drag-ready').forEach((el) => el.classList.remove('drag-ready'));
  }

  sortGrid.addEventListener('mousedown', (e) => {
    if (S.sort.editing || e.button !== 0) return;
    const card = e.target.closest && e.target.closest('.card');
    if (!card) return;
    if (downInCact || (e.target.closest && e.target.closest('.cact'))) return;
    cardPressAt = Date.now();
    if (cardPressTimer) clearTimeout(cardPressTimer);
    cardPressTimer = setTimeout(() => {
      cardPressTimer = null;
      if (cardPressAt) card.classList.add('drag-ready');
    }, LONG_PRESS_MS);
  }, true);

  sortGrid.addEventListener('mouseup', clearLongPress, true);
  window.addEventListener('blur', clearLongPress);

  sortGrid.addEventListener('dragstart', (e) => {
    let card = e.target.closest && e.target.closest('.card');
    if (!card || !sortGrid.contains(card)) return;
    // 还在读完整列表，不能基于旧缓存或未核实的数据计算落点
    if (S.sort.loading) { e.preventDefault(); return; }
    if (downInCact || (e.target.closest && e.target.closest('.cact'))) {
      e.preventDefault();
      return;
    }
    // 预览模式：短拖不给动；按住够久了就允许拖
    if (!S.sort.editing) {
      const held = cardPressAt ? Date.now() - cardPressAt : 0;
      if (held < LONG_PRESS_MS) { e.preventDefault(); return; }
      clearLongPress();
      /*
        这里**绝对不能**切模式。
        切模式（setSortMode）会重建整个网格，源元素一被替换掉，
        浏览器当场就把这次拖拽取消了 —— 表现就是"长按了、手也能拖，
        但落点没提示线、松手什么都没发生"。
        所以只记个标记，等这次拖拽彻底结束（dragend）再切。
      */
      switchAfterDrag = true;
      toast('松手之后就切到整理模式', 'ok', 4000);
    }
    // 左边已经在用时，把详情切成收藏夹列表；收起时不额外弹出。
    // 不重建卡片，也不把输入焦点抢进搜索框，否则浏览器会取消拖放。
    if (FAV.open || $('#detail').classList.contains('show')) {
      toggleFavDrawer(true, { dragging: true });
    }
    attachDrag();
    /*
      一提起卡片就把页目录摊开 —— 用户要的效果是"拖着卡片往页目录里丢"，
      那页目录得先在眼前。

      **只在它还没开的时候才开**：toggleBoxPanel 内部会调 renderBoxPanel
      把所有格子重建一遍，已经开着还去开一次的话，鼠标正悬停的那一格
      会被换成新节点 —— 表现就是拖到一半高亮凭空消失、也放不下去。
    */
    if (!$('#boxpanel').classList.contains('show')) toggleBoxPanel(true);
    const shot = snapshotGrid();
    dragState.key = card.dataset.key;
    dragState.el = card;
    // 多选模式下抓住一张已选中的卡片 = 把整批一起提起来
    dragState.block = (S.sort.multi && S.sort.picked.has(dragState.key))
      ? pickedList()
      : [dragState.key];
    dragState.snap = shot.snap;
    dragState.list = shot.list;
    dragState.gridRect = shot.gridRect;
    dragState.gridTop = shot.gridRect.top;
    dragState.block.forEach((k) => {
      const el = cardElOf.get(k);
      if (el) el.classList.add('dragging');
    });
    card.classList.add('dragging');
    dropLine.style.display = 'none';
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragState.key);
    } catch (_) {}
    const t = card.querySelector('.title');
    dragGhost.textContent = dragState.block.length > 1
      ? `${dragState.block.length} 个一起挪`
      : (t ? t.textContent.trim() : '移到此处');
    try { e.dataTransfer.setDragImage(dragGhost, 0, 0); } catch (_) {}
  });

  /**
   * 按某个屏幕坐标重画落点提示。
   *
   * 单独抽出来是因为自动滚动时也要用：内容在鼠标底下滚过去了，
   * 但浏览器不会因为"东西挪了"就补发一个 dragover。
   */
  function paintDropAt(x, y) {
    if (!dragState || !dragState.key) return;
    const res = decide(x, y);
    const key = res ? (res.key + ':' + res.mode) : '';
    if (key === dragState.lastKey) return;
    dragState.lastKey = key;
    clearDragMarks();
    dropLine.style.display = 'none';
    if (res) paintTarget(res);
  }

  sortGrid.addEventListener('dragover', (e) => {
    if (!dragState || !dragState.key) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    dragState.lastX = e.clientX;
    dragState.lastY = e.clientY;

    paintDropAt(e.clientX, e.clientY);
    updateAutoScroll(e.clientY);
  });

  sortGrid.addEventListener('dragleave', (e) => {
    if (!dragState || !dragState.key) return;
    if (e.relatedTarget && sortGrid.contains(e.relatedTarget)) return;
    clearDragMarks();
    dropLine.style.display = 'none';
    dragState.lastKey = '';
    dragState.scrollDir = 0;
  });

  sortGrid.addEventListener('drop', (e) => {
    if (!dragState || !dragState.key) return;
    e.preventDefault();
    const res = decide(e.clientX, e.clientY);
    const block = (dragState.block && dragState.block.length) ? dragState.block.slice() : [dragState.key];
    clearDragMarks();
    dropLine.style.display = 'none';
    dragState.lastKey = '';
    if (!res) return;
    // 一般情况走同步这条路，拖拽手感不受影响；
    // 只有落点压在锁定的那一页上，才需要先问一句要不要解锁。
    const page = landPage(res);
    if (page && S.sort.locked.has(page)) {
      const folder = currentFolderId();
      askUnlockForPage(page, block.length).then((ok) => { if (ok && currentFolderId() === folder) applyBlockDrop(block, res); });
      return;
    }
    applyBlockDrop(block, res);
  });

  /** 这次落点会落在第几页（没开分页就返回 0） */
  function landPage(res) {
    const size = S.sort.pageSize || 0;
    if (!size) return 0;
    const list = S.sort.order;
    let land;
    if (res.mode === 'swap') {
      land = list.indexOf(res.key);
    } else {
      const at = list.indexOf(res.key);
      if (at < 0) return 0;
      land = at + (res.mode === 'right' ? 1 : 0);
    }
    if (land < 0) return 0;
    return Math.floor(land / size) + 1;
  }

  sortGrid.addEventListener('dragend', endCardDrag);

  function endCardDrag() {
    stopBoxAutoScroll();
    // 卡片松手了，不管落在哪都把页目录上的高亮收掉
    if (typeof clearCardHover === 'function') clearCardHover();
    lastDragEndAt = Date.now();
    if (dragState) {
      if (dragState.block && dragState.block.length) {
        dragState.block.forEach((k) => {
          const el = cardElOf.get(k);
          if (el) el.classList.remove('dragging');
        });
      }
      if (dragState.el) dragState.el.classList.remove('dragging');
      clearDragMarks();
      dropLine.style.display = 'none';
      dragState.key = null;
      dragState.el = null;
      dragState.block = [];
      dragState.snap = [];
      dragState.list = [];
      dragState.lastKey = '';
      dragState.scrollDir = 0;
    }
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
    if (sortVirtual) { sortVirtual.start = -1; renderVirtualWindow(); }

    // 预览模式下长按拖动的那一次：拖完了才切整理模式。
    // 在这儿切是安全的 —— drop 已经处理完、顺序也落地了，这时候重建网格不影响谁。
    if (switchAfterDrag) {
      switchAfterDrag = false;
      setTimeout(() => {
        setSortMode(true);
        toast('已经切到整理模式，接着调整吧～', 'ok', 4600);
      }, 80);
    }
  }

  /** 一叠卡片整体落地；单张时转交给 applyDrop，手感跟以前一样 */
  function applyBlockDrop(block, res) {
    const list = S.sort.order;
    const moving = list.filter((k) => block.includes(k));
    if (moving.length <= 1) {
      applyDrop(moving[0] || block[0], res);
      return;
    }
    if (moving.includes(res.key)) return;     // 落点就在自己这批里
    const set = new Set(moving);
    const rest = list.filter((k) => !set.has(k));
    const at = rest.indexOf(res.key);
    if (at < 0) return;
    if (!pushHistory()) return;
    S.sort.locked.delete(landPage(res));
    let out;
    if (res.mode === 'swap') {
      // 替换：整批占住目标那一格，目标卡片跟在这批后面
      out = rest.slice(0, at).concat(moving, [res.key], rest.slice(at + 1));
    } else {
      const after = (res.mode === 'right');
      const pos = after ? at + 1 : at;
      out = rest.slice(0, pos).concat(moving, rest.slice(pos));
    }
    S.sort.order = out;
    // 整批挪动牵连的卡片多，直接重建最省事
    resetSortDim();
    renderSortList();
    updateSortStats();
    renderSortTagTabs();
  }

  function applyDrop(fromKey, res) {
    const list = S.sort.order;
    const from = list.indexOf(fromKey);
    if (from < 0) return;

    if (res.mode === 'swap') {
      const to = list.indexOf(res.key);
      if (to < 0 || to === from) return;
      if (!pushHistory()) return;
      S.sort.locked.delete(landPage(res));
      list[from] = res.key;
      list[to] = fromKey;
      const fromEl = cardElOf.get(fromKey);
      const toEl = cardElOf.get(res.key);
      if (fromEl && toEl && fromEl.parentNode && toEl.parentNode) {
        const mark = document.createElement('span');
        fromEl.parentNode.insertBefore(mark, fromEl);
        toEl.parentNode.insertBefore(fromEl, toEl);
        mark.parentNode.insertBefore(toEl, mark);
        mark.remove();
      }
      refreshCardMarks(Math.min(from, to), Math.max(from, to));
    } else {
      if (!pushHistory()) return;
      S.sort.locked.delete(landPage(res));
      list.splice(from, 1);
      let to = list.indexOf(res.key);
      if (to < 0) { list.splice(from, 0, fromKey); return; }
      const after = (res.mode === 'right');
      if (after) to += 1;
      list.splice(to, 0, fromKey);
      const fromEl = cardElOf.get(fromKey);
      const toEl = cardElOf.get(res.key);
      if (fromEl && toEl && toEl.parentNode) {
        if (after) toEl.after(fromEl);
        else toEl.before(fromEl);
      }
      refreshCardMarks(Math.min(from, to), Math.max(from, to));
    }
    resetSortDim();
    updateSortStats();
  }

  /** 失效条目的 key —— 它们本来就该沉底，不该算进"移动过" */
  function invalidKeySet() {
    const s = new Set();
    S.sort.items.forEach((it) => { if (it.invalid) s.add(it.key); });
    (S.sort.extra || []).forEach((it) => { if (it.invalid) s.add(it.key); });
    return s;
  }

  /**
   * 算出「哪些条目真的挪过位置」。
   *
   * 只比线上原本就有、且没被标记删除的那些条目的先后 —— 这样新加一条、
   * 或者删掉一条导致的「整体顺延」不算移动，只有真的被挪动的才亮。
   *
   * 失效的也不参与：点「失效的沉底」只是把坏掉的挪到最后，那是清理，
   * 不是"把好视频挪走了"，不该让半屏卡片都亮成"已挪"。
   */
  function movedKeySet() {
    const dead = invalidKeySet();
    const baseRank = new Map();
    let n = 0;
    S.sort.original.forEach((k) => {
      if (S.sort.deleted.has(k) || dead.has(k)) return;
      baseRank.set(k, n++);
    });
    const moved = new Set();
    let seen = 0;
    for (const k of S.sort.order) {
      const r = baseRank.get(k);
      if (r === undefined) continue;
      if (r !== seen) moved.add(k);
      seen += 1;
    }
    return moved;
  }

  /** 放下之后只动该动的：序号 + 「已挪」状态，按受影响区间刷 */
  function refreshCardMarks(lo, hi) {
    if (sortVirtual) { renderSortList(); return; }
    const moved = movedKeySet();
    const newSet = newKeySet();
    for (let i = lo; i <= hi; i++) {
      const k = S.sort.order[i];
      const el = cardElOf.get(k);
      if (!el) continue;
      const cnum = cnumElOf.get(k);
      if (cnum && cnum.textContent !== String(i + 1)) cnum.textContent = String(i + 1);
      el.classList.toggle('dirty', moved.has(k));
    }
  }

  /* 拖动到网格上下边缘时自动滚动（只在边缘才跑 rAF，平时零开销） */
  let scrollRaf = null;
  function autoScrollStep() {
    scrollRaf = null;
    if (!dragState || !dragState.key || !dragState.scrollDir) return;
    const before = sortGrid.scrollTop;
    sortGrid.scrollTop = before + dragState.scrollDir * (dragState.edgeDist < 24 ? 22 : 11);
    if (sortGrid.scrollTop !== before) {
      // 内容滚上去了、鼠标没动 —— 得按新位置自己重算一次落点
      if (sortVirtual) renderVirtualWindow();
      paintDropAt(dragState.lastX, dragState.lastY);
    }
    scrollRaf = requestAnimationFrame(autoScrollStep);
  }

  function updateAutoScroll(clientY) {
    const rect = dragState.gridRect;
    const edge = 56;
    let dir = 0, dist = 0;
    if (clientY - rect.top < edge) { dir = -1; dist = clientY - rect.top; }
    else if (rect.bottom - clientY < edge) { dir = 1; dist = rect.bottom - clientY; }
    dragState.scrollDir = dir;
    dragState.edgeDist = Math.max(0, dist);
    if (dir && !scrollRaf) scrollRaf = requestAnimationFrame(autoScrollStep);
  }

  /* -------- 移动次数计算（跟后端同一套算法） -------- */
  function buildMoveOps(original, target) {
    const cur = original.slice();
    const ops = [];
    for (let i = 0; i < target.length; i++) {
      const want = target[i];
      if (i >= cur.length) break;
      if (cur[i] === want) continue;
      const j = cur.indexOf(want, i);
      if (j < 0) continue;
      ops.push([i > 0 ? cur[i - 1] : null, want]);
      cur.splice(j, 1);
      cur.splice(i, 0, want);
    }
    return ops;
  }

  // 与 buildMoveOps 的贪心过程完全同义，只计数，不反复搜索、搬动大数组。
  // 提交时仍使用原来的操作生成器；这里仅加速界面的统计。
  function countMoveOps(original, target) {
    const n = original.length;
    if (target.length !== n) return buildMoveOps(original, target).length;
    const positions = new Map(original.map((key, i) => [key, i]));
    if (positions.size !== n) return buildMoveOps(original, target).length;
    const prev = new Int32Array(n), next = new Int32Array(n), used = new Uint8Array(n);
    for (let i = 0; i < n; i++) { prev[i] = i - 1; next[i] = i + 1; }
    let head = 0, moved = 0;
    for (const key of target) {
      const i = positions.get(key);
      if (i === undefined || used[i]) return buildMoveOps(original, target).length;
      used[i] = 1;
      if (i !== head) moved += 1;
      const left = prev[i], right = next[i];
      if (left < 0) head = right;
      else next[left] = right;
      if (right < n) prev[right] = left;
    }
    return moved;
  }

  function updateSortStats() {
    const pendingNew = newKeySet();
    const del = [...S.sort.deleted].filter(k => !pendingNew.has(k)).length;
    const add = (S.sort.extra || []).filter(it => !S.sort.deleted.has(it.key)).length;
    const total = S.sort.order.length;

    // 没有增删时，移动次数是能精确算的；
    // 一旦有增删，新条目最终落在哪儿得等提交时重读线上顺序才知道，
    // 所以这里只能按"排除新增项"估一个数，界面上会加 ≈ 表示估算。
    let moved;
    if (del || add) {
      const newSet = newKeySet();
      const before = S.sort.original.filter((k) => !S.sort.deleted.has(k));
      const after = S.sort.order.filter((k) => !S.sort.deleted.has(k) && !newSet.has(k));
      moved = countMoveOps(before, after);
    } else {
      moved = countMoveOps(S.sort.original, S.sort.order);
    }

    $('#sort-stat-total').textContent = total;
    $('#sort-stat-moved').textContent = (del || add) ? `≈${moved}` : moved;
    $('#sort-stat-del').textContent = del;
    $('#sort-stat-add').textContent = add;

    renderSortTagTabs();   // 标签页上的计数跟着一起刷

    const parts = [];
    if (del) parts.push(`删掉 <b>${del}</b> 条`);
    if (add) parts.push(`加进 <b>${add}</b> 条`);
    if (moved) parts.push(`移动约 <b>${moved}</b> 次`);

    const hint = $('#sort-ops-hint');
    if (!S.sort.editing) {
      hint.className = 'ops preview';
      if (!S.sort.folder) {
        hint.textContent = '还没选收藏夹';
      } else if (sortTouched()) {
        // 退出整理后改动还在本地，得说清楚它没上传
        hint.textContent = '本地整理尚未同步到 B 站；进入整理后可提交改动';
      } else {
        hint.textContent = '预览中：只能看和筛，想改顺序点上面的「开始整理」';
      }
      hint.title = '';
    } else {
      hint.className = 'ops';
      if (!parts.length) {
        hint.innerHTML = '还没动过，顺序跟线上一样。';
      } else if (del || add) {
        hint.innerHTML = `提交时会：${parts.join('、')}（先删 → 再加 → 最后排）`;
      } else {
        hint.innerHTML = `提交时会发 <b>${moved}</b> 次移动指令，分 ${Math.max(1, Math.ceil(moved / 200))} 批发`;
      }
      hint.title = '提交顺序：先删除 → 再添加 → 最后排序；加进去的视频不管落在哪儿都会帮你排到位。';
    }

    $('#sort-apply-label').textContent = (del || add)
      ? `提交改动（删 ${del} / 加 ${add}）`
      : '提交改动';
    $('#sort-apply').disabled = !del && !add && !moved;
    $('#sort-clear-marks').classList.toggle('hidden', !del && !add);

    // 撤销 / 重做 / 还原：没得动就灰着，省得点了个寂寞
    $('#sort-undo').disabled = !S.sort.stack.length;
    $('#sort-redo').disabled = !S.sort.redo.length;
    $('#sort-reset').disabled = !sortTouched();

    updatePageUI();   // 页码 / 页目录按钮跟着条数一起刷
    scheduleDraftSave();   // 有改动就防抖存一份草稿，误关窗口也不怕
  }

  /* ---------------- 回滚上一次提交 ---------------- */
  /*
    「撤销一步」只在**没提交**时管用。提交完才发现排错了，就得靠这个 ——
    后端每次提交成功都留了一份"改动前"的快照，这里把顺序倒回去。

    只在**确实有可回滚的记录、而且属于当前这个收藏夹**的时候才露出来，
    平时不占地方。回滚只倒顺序：那次提交如果删过视频，删掉的回不来，
    确认弹窗里会说清楚。
  */
  let rollbackInfo = null;

  async function refreshRollback() {
    const btn = $('#sort-rollback');
    if (!btn) return;
    rollbackInfo = null;
    if (!S.sort.folder) { btn.classList.add('hidden'); return; }
    try {
      const d = await api('/api/commits');
      const mine = (d.commits || []).find(
        (c) => !c.rolled_back && Number(c.media_id) === Number(S.sort.folder.media_id));
      if (!mine) { btn.classList.add('hidden'); return; }
      rollbackInfo = mine;
      btn.classList.remove('hidden');
      const when = mine.ts ? new Date(mine.ts * 1000).toLocaleString('zh-CN', { hour12: false }) : '';
      btn.title = `把 ${when} 那次提交的顺序倒回去`
        + `（${mine.count} 条，移动 ${mine.ops} 次）`
        + (mine.deleted ? `。注意：那次删了 ${mine.deleted} 条，删掉的回不来` : '');
    } catch (_) {
      btn.classList.add('hidden');
    }
  }

  $('#sort-rollback').addEventListener('click', async () => {
    if (!rollbackInfo || !S.sort.folder) return;
    if (!await requireLogin()) return;
    const c = rollbackInfo;
    const when = c.ts ? new Date(c.ts * 1000).toLocaleString('zh-CN', { hour12: false }) : '上次';
    const warn = c.deleted
      ? `<div class="rb-warn">⚠️ 那次提交还删掉了 <b>${c.deleted}</b> 条视频 —— `
        + 'B 站没有"恢复已删除视频"这回事，<b>顺序能倒回来，删掉的回不来</b>。</div>'
      : '';
    const ok = await openModal({
      title: '回滚上一次提交？',
      desc: `把「${esc(c.title)}」倒回 ${when} 提交之前的样子，共 ${c.count} 条、要移动 ${c.ops} 次。`,
      body: `<div style="font-size:12.5px;line-height:1.9;color:var(--txt-2)">
          <div>· 只倒<b>顺序</b>，不会碰你的标签和收藏内容</div>
          <div>· 倒完就不能再"重做"回这次提交了</div>
          ${warn}
        </div>`,
      okText: '倒回去',
      cancelText: '算了',
    });
    if (!ok) return;

    try {
      await api('/api/sort/rollback', { id: c.id });
      toast('开始往回倒了…', 'info', 2600);
      await pollTask();
      // 倒完之后顺序变了，重新加载一份，并把按钮收起来
      if (S.sort.folder) await loadSortFolder(S.sort.folder.media_id, true);
      await refreshRollback();
    } catch (err) {
      toast(err.message, 'err', 6000);
    }
  });

  $('#sort-apply').addEventListener('click', async () => {
    if (!S.sort.folder) return;
    if (sortWriteBusy()) { toast('正在写入，请等待当前操作完成', 'warn'); return; }
    if (S.sort.loading) { toast('还在读完整列表，读完再提交～', 'warn', 4200); return; }
    if (!await requireLogin()) return;
    const revision = localHistoryRevision, mediaId = currentFolderId();

    const pendingNew = newKeySet();
    const target = S.sort.order.filter(k => !S.sort.deleted.has(k));
    const deletions = [...S.sort.deleted].filter(k => !pendingNew.has(k));
    const additions = (S.sort.extra || []).filter(it => !S.sort.deleted.has(it.key)).map((it) => ({
      key: it.key, avid: it.avid, type: it.type, bvid: it.bvid, title: it.title,
    }));
    const ops = (deletions.length || additions.length)
      ? null
      : buildMoveOps(S.sort.original, target);

    if (!deletions.length && !additions.length && (!ops || !ops.length)) {
      toast('什么都没改呀，不用提交', 'warn');
      return;
    }

    const lines = [];
    if (deletions.length) lines.push(`从收藏夹里<b>删掉 ${deletions.length} 条</b>`);
    if (additions.length) lines.push(`<b>添加 ${additions.length} 条</b>新视频`);
    if (ops && ops.length) lines.push(`执行 <b>${ops.length}</b> 次移动`);
    else if (!ops) lines.push('然后把整体顺序排成你看到的样子');

    const ok = await confirmBox(
      '确认提交这些改动？',
      `这次会：<br>· ${lines.join('<br>· ')}<br><br>
       提交后立刻在 B 站生效。中途被打断的话，前面做完的部分不会回滚，
       可以重新加载一遍看看实际到哪一步了。`,
      '提交'
    );
    if (!ok) return;
    if (revision !== localHistoryRevision || mediaId !== currentFolderId()) { toast('本地清单已变化，请重新确认提交', 'warn'); return; }
    if (!await saveDraftNow()) return;
    if (revision !== localHistoryRevision || mediaId !== currentFolderId()) { toast('本地清单已变化，请重新确认提交', 'warn'); return; }
    sortSubmitPending = true;
    try {
      await api('/api/sort/apply', {
        media_id: S.sort.folder.media_id,
        original: S.sort.original,
        target,
        baseline_cached: !!S.sort.fromCache,
        deletions,
        additions,
        batch_size: 200,
      });
      toast('开始提交了，右上角「任务」里能看进度～', 'ok');
      // 草稿在任务成功或实际写入后才清除；校验拒绝时仍保留全部本地改动。
      resetTaskView();
      S.task.busy = true;
      S.task.kind = 'sort';
      toggleTaskPop(true);
    } catch (err) { toast(err.message, 'err', 6000); }
    finally { sortSubmitPending = false; }
  });

  /* ============================================================ 任务状态 */
  function resetTaskView() {
    taskPollGeneration += 1;
    taskRenderKey = ''; dashRenderKey = ''; lastTaskData = null;
    S.task.since = 0;
    S.task.lastSeq = 0;
    S.task.stages = {};
    $('#task-log').innerHTML = '';
    startTaskPolling();
  }

  function appendLog(ev) {
    const box = $('#task-log');
    const line = document.createElement('div');
    line.className = `line ${ev.level || 'info'}`;
    line.innerHTML = `<span class="t">${fmtClock(ev.ts)}</span><span class="m">${esc(ev.text || '')}</span>`;
    box.appendChild(line);
    while (box.childElementCount > 800) box.removeChild(box.firstChild);
    if ($('#task-autoscroll').checked) scrollLogToEnd();
  }

  function scrollLogToEnd() {
    const box = $('#task-log');
    box.scrollTop = box.scrollHeight;
  }

  const STATE_TEXT = {
    idle: ['待命', ''],
    running: ['进行中', 'blue'],
    paused: ['已暂停', 'warn'],
    done: ['已完成', 'ok'],
    failed: ['出错了', 'err'],
    cancelled: ['已停止', 'warn'],
  };

  function renderTaskStatus(data) {
    S.task.state = data.state;
    const [text, cls] = STATE_TEXT[data.state] || ['未知', ''];
    $('#task-state-tag').textContent = text;
    $('#task-state-tag').className = 'tag ' + cls;
    $('#nav-task-badge').textContent = text;
    $('#nav-task-badge').className = 'dotred' + (data.busy ? '' : ' idle');
    $('#task-title').textContent = data.label || '没有任务在跑';
    if (!taskPop.classList.contains('show')) return;

    const extra = data.extra || {};
    const stats = [];
    if (data.kind === 'copy') {
      const st = extra.stats || {};
      stats.push(['清单总数', st.total ?? '—', '']);
      stats.push(['已新增', st.done ?? '—', 'ok']);
      stats.push(['已存在跳过', st.duplicate ?? '—', '']);
      stats.push(['失效跳过', st.invalid ?? '—', 'warn']);
      stats.push(['失败', st.failed ?? '—', st.failed ? 'err' : '']);
      stats.push(['剩余', st.remaining ?? '—', 'blue']);
    } else if (data.kind === 'sort') {
      const st = S.task.stages || {};
      const del = st.delete || { done: 0, total: 0 };
      const add = st.add || { done: 0, total: 0 };
      const srt = st.sort || { done: 0, total: 0 };
      if (del.total) stats.push(['删除', `${del.done}/${del.total}`, del.done >= del.total ? 'ok' : 'warn']);
      if (add.total) stats.push(['添加', `${add.done}/${add.total}`, add.done >= add.total ? 'ok' : 'warn']);
      if (srt.total) {
        stats.push(['移动', `${srt.done}/${srt.total}`, 'ok']);
        stats.push(['剩余', Math.max(0, srt.total - srt.done), 'blue']);
      }
      if (!stats.length) stats.push(['状态', text, '']);
    }

    $('#task-stats').innerHTML = stats.length
      ? stats.map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('')
      : '<div class="stat"><div class="k">状态</div><div class="v">' + esc(text) + '</div></div>';

    let total, done;
    if (data.kind === 'sort') {
      // 整理任务由「删除 → 添加 → 排序」三段组成，进度条按三段合起来算
      const st = S.task.stages || {};
      const parts = ['delete', 'add', 'sort'].map((k) => st[k] || { done: 0, total: 0 });
      total = parts.reduce((a, p) => a + p.total, 0);
      done = parts.reduce((a, p) => a + p.done, 0);
    } else {
      total = extra.stats?.total || 0;
      done = (extra.stats?.done || 0) + (extra.stats?.duplicate || 0)
        + (extra.stats?.invalid || 0) + (extra.stats?.failed || 0);
    }
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : (data.state === 'done' ? 100 : 0);
    const bar = $('#task-bar');
    bar.querySelector('i').style.width = pct + '%';
    bar.classList.toggle('ok', data.state === 'done');

    $('#task-elapsed').textContent = data.elapsed ? `已跑 ${fmtElapsed(data.elapsed)}` : '';

    const paused = data.state === 'paused';
    const pauseTxt = paused ? '继续' : '暂停';
    const pauseIcon = paused ? 'i-play' : 'i-pause';
    const canPause = data.busy && data.can_pause;
    $('#task-pause').disabled = !canPause;
    $('#task-pause').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linejoin="round"><use href="#${pauseIcon}"/></svg>${pauseTxt}`;
    $('#task-stop').disabled = !data.busy;
  }

  let taskPollInFlight = null;
  let taskPollAgain = false;
  let taskPollingStarted = false;
  let taskPollGeneration = 0;
  let lastTaskData = null;
  let taskRenderKey = '';
  let dashRenderKey = '';

  function taskPollDelay() { return document.hidden ? 15000 : S.task.busy ? 900 : 5000; }
  function scheduleTaskPoll(delay = taskPollDelay()) {
    if (!taskPollingStarted) return;
    clearTimeout(S.task.timer);
    S.task.timer = setTimeout(() => pollTask(), delay);
  }
  function renderTaskViews(data) {
    if (!data || document.hidden) return;
    const key = JSON.stringify([data.state,data.kind,data.label,data.busy,data.can_pause,data.extra,
      data.result,data.elapsed,S.task.stages]);
    // 顶栏状态很轻；详细统计和菜单卡片只在可见且内容变化时更新。
    if (key !== taskRenderKey || taskPop.classList.contains('show')) {
      if (key !== taskRenderKey) { renderTaskStatus(data); taskRenderKey = key; }
    }
    if (document.querySelector('.page.active')?.dataset.page === 'menu' && key !== dashRenderKey) {
      renderDashTask(data); dashRenderKey = key;
    }
  }
  function pollTask() {
    if (taskPollInFlight) { taskPollAgain = true; return taskPollInFlight; }
    clearTimeout(S.task.timer);
    taskPollInFlight = pollTaskOnce().finally(() => {
      taskPollInFlight = null;
      const immediate = taskPollAgain; taskPollAgain = false;
      scheduleTaskPoll(immediate ? 0 : taskPollDelay());
    });
    return taskPollInFlight;
  }
  async function pollTaskOnce() {
    try {
      const generation = taskPollGeneration;
      const data = await api(`/api/task/status?since=${S.task.since}`);
      if (generation !== taskPollGeneration) { taskPollAgain = true; return; }
      (data.events || []).forEach((ev) => {
        if (ev.type === 'log') appendLog(ev);
        else if (ev.type === 'sort_stage') {
          // 整理任务分「删除 / 添加 / 排序」三段，各自的进度都是全量上报的
          S.task.stages = S.task.stages || {};
          S.task.stages[ev.stage] = { done: ev.done || 0, total: ev.total || 0 };
        }
      });
      S.task.since = data.seq || S.task.since;
      S.task.state = data.state;
      S.task.kind = data.kind;
      lastTaskData = data;
      renderTaskViews(data);

      const kindLabel = data.kind === 'copy' ? '复制' : data.kind === 'sort' ? '整理' : '';

      if (!data.busy && S.task.busy) {
        // 刚结束
        const r = data.result || {};
        if (r.ok) {
          toast(r.message || (kindLabel + '完成啦～'), 'ok', 6000);
          if (data.kind === 'copy') refreshFolders();
          if (data.kind === 'sort' && S.sort.folder) {
            // 增删之后线上的内容和顺序都变了，老老实实重新拉一遍最稳
            const mid = S.sort.folder.media_id;
            await clearDraft(mid);
            S.sort.deleted = new Set();
            S.sort.extra = [];
            S.sort.stack = []; S.sort.redo = []; S.sort.locked.clear();
            S.sort.order = S.sort.original.slice();
            S.task.stages = {};
            loadSortFolder(mid, true);
          }
        } else if (r.reason && r.reason !== 'noop') {
          toast(r.message || '任务没能跑完', 'err', 7000);
          // 做到一半失败的话，线上状态已经变了，也得重新读一遍
          if (data.kind === 'sort' && S.sort.folder && (r.deleted || r.added || r.ops)) {
            const mid = S.sort.folder.media_id;
            await clearDraft(mid);
            S.sort.deleted = new Set();
            S.sort.extra = [];
            S.sort.stack = []; S.sort.redo = []; S.sort.locked.clear();
            S.sort.order = S.sort.original.slice();
            loadSortFolder(mid, true);
          }
        }
      }
      S.task.busy = !!data.busy;
      renderTaskViews(data);
    } catch (err) {
      /* 轮询失败静默重试 */
    }
  }

  function renderDashTask(data) {
    const box = $('#dash-task');
    if (!box) return;
    if (!data || !data.kind || (data.state === 'idle')) {
      // 没有任务在跑的时候，给两个最常用的去处 —— 样式跟别处的斜切按钮一致
      box.innerHTML = `
        <div class="empty" style="padding:20px 10px">
          <span class="em">💤</span>
          <p>现在没有任务在跑，想做点什么？</p>
          <div class="dash-acts">
            <button class="btn-solid" data-goto="sort" title="把收藏夹里的顺序捋顺：拖、排序、增删"><span>收藏整理</span></button>
            <button class="btn-skew" data-goto="copy" title="把别人公开收藏夹里的视频搬进自己的"><span>收藏搬运</span></button>
          </div>
        </div>`;
      return;
    }
    const [text, cls] = STATE_TEXT[data.state] || ['未知', ''];
    const st = data.extra?.stats || {};
    const pct = data.kind === 'copy' && st.total
      ? Math.min(100, Math.round(((st.done + st.duplicate + st.invalid + st.failed) / st.total) * 100))
      : (data.state === 'done' ? 100 : 0);
    box.innerHTML = `
      <div class="task-head">
        <b>${esc(data.label || '')}</b>
        <span class="tag ${cls}">${text}</span>
        <span style="flex:1"></span>
        <button class="btn-skew" data-taskpop="1" type="button"><span>查看详情</span></button>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="plain" style="margin-top:10px;font-size:12px">
        ${data.kind === 'copy' ? `已新增 ${st.done || 0} · 跳过 ${(st.duplicate || 0) + (st.invalid || 0)} · 剩余 ${st.remaining ?? '—'}` : ''}
        ${data.elapsed ? `　已跑 ${fmtElapsed(data.elapsed)}` : ''}
      </div>`;
  }

  function startTaskPolling() {
    taskPollingStarted = true;
    pollTask();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) scheduleTaskPoll();
    else { renderTaskViews(lastTaskData); pollTask(); }
  });
  window.addEventListener('focus', () => { if (taskPollingStarted) pollTask(); if (uiSaveFailed) flushUiSave(); });

  $('#task-pause').addEventListener('click', () => taskControl('toggle'));
  $('#task-stop').addEventListener('click', () => taskStopAsk());

  /* ============================================================ 记录页 */
  async function loadHistory() {
    const box = $('#history-body');
    box.innerHTML = `<div class="empty"><img class="em-img" src="${READING_IMAGE}" alt=""><p>翻本子中…</p></div>`;
    try {
      const data = await api('/api/tasks');
      const list = data.tasks || [];
      renderHistoryStats(list);
      if (!list.length) {
        box.innerHTML = '<div class="empty"><span class="em">📭</span><p>还没有搬运过什么呢</p></div>';
        return;
      }
      box.innerHTML = `
        <table class="tbl">
          <thead><tr>
            <th>源 → 目标</th><th>进度</th><th>总计</th><th>更新时间</th><th></th>
          </tr></thead>
          <tbody>
            ${list.map((t) => {
              const done = t.done + t.duplicate + t.invalid;
              const pct = t.total ? Math.round((done / t.total) * 100) : 0;
              return `<tr>
                <td><b>${esc(t.source || '?')}</b> → ${esc(t.target || '?')}</td>
                <td class="num">
                  <span class="rowbar">
                    <span class="bar-mini"><i style="width:${pct}%"></i></span>
                    ${done} / ${t.total}
                    ${t.failed ? `<span class="tag err">失败 ${t.failed}</span>` : ''}
                    ${pct === 100 ? '<span class="tag ok">已搬完</span>' : ''}
                  </span>
                </td>
                <td class="num">${t.total}</td>
                <td>${esc(t.updated_at || '')}</td>
                <td><button class="btn-skew" data-export="${esc(t.name)}" type="button"><span>导出 CSV</span></button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
      $$('[data-export]', box).forEach((el) => el.addEventListener('click', async () => {
        try {
          const r = await api('/api/export/csv', { name: el.dataset.export });
          toast('导出好啦：' + r.path, 'ok', 8000);
        } catch (err) { toast(err.message, 'err'); }
      }));
    } catch (err) {
      box.innerHTML = `<div class="empty"><span class="em">😵</span><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderHistoryStats(list) {
    let copied = 0;
    (list || []).forEach((t) => { copied += (t.done || 0) + (t.duplicate || 0) + (t.invalid || 0); });
    const n = (list || []).length;
    $('#dash-stat-tasks').textContent = n;
    $('#dash-stat-copied').textContent = fmtNum(copied);
    $('#menu-task-count').textContent = `${n} 个`;
    $('#history-stat').innerHTML = n
      ? `共 <b>${n}</b> 个任务存档 · 累计处理 <b>${copied}</b> 条`
      : '还没搬过什么';
  }

  /** 只为了把存档数填上，省得「菜单」和「总览」在没进过记录页时一直显示 0 */
  async function refreshTaskStats() {
    try {
      const data = await api('/api/tasks');
      renderHistoryStats(data.tasks || []);
    } catch (_) {}
  }

  /* ======================================================== 收藏夹侧栏 */
  /*
    左上角那个按钮滑出来的面板。它不是「点一下就用完」的抽屉，而是常驻的侧栏：
      · 滑出后固定在左边，主内容整体往右让位；
      · 只有再点一次那个按钮（或者栏上的 ✕）才收回去，点别处不会自己跑掉；
      · 两个检索维度：收藏夹名字本地即时过滤；里面的视频由本鱼挨个翻一遍
        （走 /api/folder/items 的 keyword 参数，B 站侧过滤、只取第一页），
        能中途停，也能边翻边出结果。
  */
  const favDrawer = $('#fav-drawer');
  const favBtn = $('#fav-drawer-open');
  const FAV = { open: false, kw: '', hits: new Map(), hitCounts: new Map(), scanning: false, done: false, cached: 0, oldest: 0, onlineDone: false, failed: 0 };
  let favScanToken = 0;
  let favSearchTimer = null;

  /* 侧栏宽度：默认 340，可以拖，最窄一半、最宽两倍，记在本机 */
  const DRAWER_MIN = 170;
  const DRAWER_MAX = 680;
  let drawerW = 340;

  function applyDrawerWidth(w, save) {
    drawerW = Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, Math.round(w)));
    document.documentElement.style.setProperty('--drawer-w', drawerW + 'px');
    // 可用宽度变了，卡片列数跟着重算（拖的过程中就要跟着动）
    if (typeof applyGridCols === 'function') applyGridCols();
    if (save) {
      lsSave('bilifav.drawerW', String(drawerW), '侧栏宽度');
    }
  }

  try {
    const savedW = Number(localStorage.getItem('bilifav.drawerW') || 0);
    if (savedW) applyDrawerWidth(savedW, false);
  } catch (_) {}

  /**
   * 给一根把手绑上"拖动改宽度"。
   *
   * 收藏夹栏和视频详情**共用这一套** —— 它们本来就是左边同一块地方（谁开谁顶掉
   * 对方），宽度也共用同一个 `--drawer-w`：在详情里拖窄了，回头打开收藏夹栏
   * 也是那个宽度；反过来也一样。
   *
   * `reflow` 用于挤压中间网格的侧栏：拖动时先锁住列数，松手再用 FLIP 顺移。
   * 右栏通过 sizing 传入独立的宽度读写和相反的拖动方向。
   */
  function bindWidthGrip(grip, reflow, sizing = null) {
    if (!grip) return;
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sizing ? sizing.width() : drawerW;
      const applyWidth = sizing ? sizing.apply : applyDrawerWidth;
      let locked = false;
      if (reflow) {
        const cols = getComputedStyle(sortGrid).gridTemplateColumns.split(' ').filter(Boolean).length;
        if (cols > 1) {
          sortGrid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
          locked = true;
        }
      }
      document.body.classList.add('drawer-resizing');
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}

      const onMove = (ev) => applyWidth(startW + (ev.clientX - startX) * (sizing?.direction || 1), false);
      const onUp = () => {
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        grip.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('drawer-resizing');
        applyWidth(sizing ? sizing.width() : drawerW, true);
        if (locked) flipCards(() => { sortGrid.style.gridTemplateColumns = ''; });
      };
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
      grip.addEventListener('pointercancel', onUp);
    });
  }

  bindWidthGrip($('#fav-resizer'), true);       // 收藏夹栏：会挤压卡片区
  bindWidthGrip($('#detail-resizer'), true);    // 详情恢复独立侧栏，共用左侧宽度

  function applyBoxWidth(width, save) {
    const value = Math.max(180, Math.min(720, Math.round(width)));
    // 占位宽度和面板始终一致；缩小窗口时至少为中间区域留下基本空间。
    document.documentElement.style.setProperty('--box-w', `min(${value}px, max(180px, calc(100vw - 320px)))`);
    applyGridCols();
    if (save) lsSave('bilifav.boxW', String(value), '页目录宽度');
  }
  try {
    const saved = Number(localStorage.getItem('bilifav.boxW'));
    if (Number.isFinite(saved) && saved >= 180) applyBoxWidth(saved, false);
  } catch (_) {}
  bindWidthGrip($('#boxpanel-resizer'), true, {
    direction: -1,
    width: () => $('#boxpanel').getBoundingClientRect().width,
    apply: applyBoxWidth,
  });

  /**
   * 网格重排时的位置动画（FLIP）。
   * 侧栏一开一合，卡片网格会从 6 列变 5 列，直接重排的话卡片会「啪」地跳一下；
   * 这里先记下每张卡原来的位置，重排后再用 transform 把它们拉回去、再放开，
   * 于是就是滑过去而不是跳过去。只处理视口附近的卡片，屏幕外的不用管。
   */
  function flipCards(mutate) {
    const shot = [];
    for (const el of sortGrid.children) {
      if (!el.classList || !el.classList.contains('card')) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < -80 || r.top > window.innerHeight + 80) continue;
      shot.push([el, r.left, r.top]);
    }
    mutate();
    for (const [el, left, top] of shot) {
      const r = el.getBoundingClientRect();
      const dx = left - r.left;
      const dy = top - r.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
    }
    if (!shot.length) return;
    requestAnimationFrame(() => {
      for (const [el] of shot) {
        if (!el.style.transform) continue;
        el.style.transition = 'transform .34s cubic-bezier(.34,1.3,.64,1)';
        el.style.transform = '';
      }
      setTimeout(() => {
        for (const [el] of shot) { el.style.transition = ''; el.style.transform = ''; }
      }, 400);
    });
  }

  let drawerReflowTimer = null;

  function toggleFavDrawer(show, options = {}) {
    const on = show === undefined ? !favDrawer.classList.contains('show') : !!show;
    FAV.open = on;
    favDrawer.classList.toggle('drag-switch', on && !!options.dragging);

    // 详情和收藏夹栏共用左边这一块，谁开谁把对方顶掉
    if (on && $('#detail').classList.contains('show')) closeDetail(options);

    // 侧栏滑出和内容区让位是同一段过渡（各走各的就会露出一条缝）。
    // 过渡途中先把网格列数锁住，卡片不会在半路上重排；等两边都停稳了
    // 再放开列数，用 FLIP 把卡片顺到新位置。
    const cols = getComputedStyle(sortGrid).gridTemplateColumns.split(' ').filter(Boolean).length;
    if (!options.dragging && cols > 1) sortGrid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

    favDrawer.classList.toggle('show', on);
    document.body.classList.toggle('drawer-open', on);   // 内容区和底部导航往右让位
    favBtn.classList.toggle('on', on);

    clearTimeout(drawerReflowTimer);
    if (options.dragging) {
      sortGrid.style.gridTemplateColumns = '';
      applyGridCols();
    } else drawerReflowTimer = setTimeout(() => {
      flipCards(() => { sortGrid.style.gridTemplateColumns = ''; });
      // 抽屉停稳了，这时候的可用宽度才是最终值
      applyGridCols();
    }, 230);

    if (on) {
      if (S.account && !S.folders.length) refreshFolders().then(() => { renderFavList(); updateFavHint(); });
      renderFavList();
      updateFavHint();
      if (!options.dragging) setTimeout(() => { const i = $('#fav-search'); if (i) i.focus({ preventScroll: true }); }, 180);
    } else {
      // 收起来的时候要把焦点还给页面 —— 否则它会一直留在那个已经看不见的
      // 搜索框上，快捷键会被当成"正在打字"而全部失效。
      const inp = $('#fav-search');
      if (inp && document.activeElement === inp) inp.blur();
      stopFavScan(true);
    }
  }

  /** 名字命中的 + 视频命中的，合成最终要显示的列表 */
  function favResults() {
    const kw = FAV.kw;
    const out = [];
    const byName = new Set();
    if (!kw) {
      S.folders.forEach((f) => out.push({ f, hits: FAV.hits.get(f.media_id) || [] }));
      return out;
    }
    S.folders.forEach((f) => {
      if (String(f.title || '').toLowerCase().includes(kw)) {
        out.push({ f, hits: FAV.hits.get(f.media_id) || [] });
        byName.add(f.media_id);
      }
    });
    FAV.hits.forEach((hits, mid) => {
      if (byName.has(mid) || !hits.length) return;
      const f = S.folders.find((x) => x.media_id === mid);
      if (f) out.push({ f, hits });
    });
    return out;
  }

  function renderFavList() {
    const box = $('#fav-list');
    if (!box) return;
    if (!S.account) {
      box.innerHTML = '<div class="dw-empty"><span class="em">🔑</span>登录之后这里会列出你的收藏夹</div>';
      return;
    }
    const list = favResults();
    if (!list.length) {
      const em = FAV.scanning
        ? `<img class="em-img" src="${READING_IMAGE}" alt="">`
        : '<span class="em">🫧</span>';
      const txt = FAV.kw
        ? (FAV.scanning ? '正在搜索本地缓存中的视频…' : '当前搜索范围没有命中；可在线补查尚未缓存或刚更新的内容')
        : '你还没有收藏夹，点下面「新建收藏夹」建一个吧';
      box.innerHTML = `<div class="dw-empty"><span class="em">${em}</span>${txt}</div>`;
      return;
    }
    box.innerHTML = list.map(({ f, hits }) => {
      const cur = S.sort.folder && S.sort.folder.media_id === f.media_id;
      const hitN = FAV.hitCounts.get(f.media_id) || (hits && hits.length) || 0;
      const hitHtml = (hits && hits.length) ? `<div class="fi-hits">${
        hits.slice(0, 3).map((it) => `<div class="fi-hit">🎬 ${esc(it.title || '(无标题)')} <em>${esc(it.upper || '')}</em></div>`).join('')
      }${hitN > 3 ? `<div class="fi-hit">…还有 ${hitN - 3} 条</div>` : ''}</div>` : '';
      return `<div class="fav-item${cur ? ' on' : ''}" data-fav="${f.media_id}"
        draggable="${FAV.kw ? 'false' : 'true'}"
        title="${esc(f.title)} —— 点开整理；右键有改名 / 清理失效 / 合并 / 删除；还能上下拖动调顺序">
        <div class="fi-thumb">${f.privacy === 1 ? '🔒' : '📁'}</div>
        <div class="fi-main">
          <b>${esc(f.title)}</b>
          <span>${f.count} 条${f.privacy === 1 ? ' · 私密' : ''}${cur ? ' · 正在整理' : ''}${hits && hits.length ? ` · 命中 ${hitN} 个视频` : ''}</span>
          ${hitHtml}
        </div>
        <span class="fi-go">浏览 →</span>
      </div>`;
    }).join('') + `
      <div class="fav-item new" data-fav-new="1" title="建一个空收藏夹，马上开始整理">
        <div class="fi-thumb">＋</div>
        <div class="fi-main"><b>新建收藏夹</b></div>
      </div>`;
  }

  /* ---------------- 收藏夹栏：拖动排序 ---------------- */
  /*
    顺序存在 data/config/prefs.json（跟着 data/ 走，换电脑也带得走）。

    注意：B 站**没有公开的"收藏夹之间排序"接口**（我探到一个 /fav/folder/sort，
    但它没有文档、看起来是"收藏夹内内容的排序偏好"，不敢拿真账号硬试）。
    所以这个顺序只在本工具里生效，B 站网页/App 上还是它自己那套。
  */
  let favDragId = 0;

  const clearFavDropMarks = () => $$('#fav-list .fav-item')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));

  function reorderFolder(fromId, toId, before) {
    const list = S.folders.slice();
    const fi = list.findIndex((f) => f.media_id === fromId);
    if (fi < 0) return false;
    const [moved] = list.splice(fi, 1);
    let ti = list.findIndex((f) => f.media_id === toId);
    if (ti < 0) return false;
    if (!before) ti += 1;
    list.splice(ti, 0, moved);
    S.folders = list;
    savePrefs({ folder_order: list.map((f) => f.media_id) });
    renderFavList();
    renderSortFolders();
    renderFolders();
    return true;
  }

  $('#fav-list').addEventListener('dragstart', (e) => {
    const item = e.target.closest && e.target.closest('[data-fav]');
    if (!item || item.dataset.favNew || FAV.kw) { e.preventDefault(); return; }
    favDragId = Number(item.dataset.fav);
    item.classList.add('dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(favDragId));
    } catch (_) {}
  });

  /*
    手里拖着**卡片**时，悬停在收藏夹条目上就整条高亮 —— 表示"松手就搬进去"。
    跟"拖收藏夹排序"（favDragId）是两回事，先看手里拿的是哪种。
  */
  let cardOverFavId = 0;

  const paintCardOverFav = (id) => {
    if (cardOverFavId === id) return;
    cardOverFavId = id;
    $$('#fav-list .fav-item').forEach((el) => {
      el.classList.toggle('card-over', Number(el.dataset.fav) === id);
    });
  };

  const clearCardOverFav = () => {
    cardOverFavId = 0;
    $$('#fav-list .fav-item').forEach((el) => el.classList.remove('card-over'));
  };

  $('#fav-list').addEventListener('dragover', (e) => {
    if (dragState && dragState.key) {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
      const item = e.target.closest && e.target.closest('[data-fav]');
      const id = item && !item.dataset.favNew ? Number(item.dataset.fav) : 0;
      paintCardOverFav(id && id !== currentFolderId() ? id : 0);
      return;
    }
    if (!favDragId) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    clearFavDropMarks();
    const item = e.target.closest && e.target.closest('[data-fav]');
    if (!item || item.dataset.favNew) return;
    if (Number(item.dataset.fav) === favDragId) return;
    const r = item.getBoundingClientRect();
    item.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });

  $('#fav-list').addEventListener('drop', (e) => {
    // 卡片落到收藏夹上 —— 把这几张搬进去
    if (dragState && dragState.key) {
      e.preventDefault();
      const item = e.target.closest && e.target.closest('[data-fav]');
      const toId = item && !item.dataset.favNew ? Number(item.dataset.fav) : 0;
      const name = item ? (item.querySelector('b') ? item.querySelector('b').textContent.trim() : '') : '';
      const keys = (dragState.block || []).slice();
      clearCardOverFav();
      if (!toId) return;
      if (toId === currentFolderId()) {
        toast('这就是当前收藏夹', 'info', 3000);
        return;
      }
      copyPickedToFolder(keys, toId, name);
      return;
    }
    if (!favDragId) return;
    e.preventDefault();
    const item = e.target.closest && e.target.closest('[data-fav]');
    const putBefore = !!(item && item.classList.contains('drop-before'));
    const toId = item && !item.dataset.favNew ? Number(item.dataset.fav) : 0;
    const fromId = favDragId;
    favDragId = 0;
    clearFavDropMarks();
    $$('#fav-list .fav-item').forEach((el) => el.classList.remove('dragging'));
    if (!toId || toId === fromId) return;
    if (reorderFolder(fromId, toId, putBefore)) {
      toast('顺序调好了（只在本工具里生效，B 站那边得用它的客户端调）', 'ok', 5200);
    }
  });

  $('#fav-list').addEventListener('dragend', () => {
    favDragId = 0;
    clearCardOverFav();
    clearFavDropMarks();
    $$('#fav-list .fav-item').forEach((el) => el.classList.remove('dragging'));
  });

  /* ---------------- 收藏夹右键菜单 ---------------- */
  const favMenu = $('#fav-menu');
  let favMenuId = 0;

  function closeFavMenu() {
    favMenu.classList.remove('show');
    favMenuId = 0;
  }

  function openFavMenu(x, y, folder) {
    if (!folder) return;
    favMenuId = folder.media_id;
    const others = (S.folders || []).filter((f) => f.media_id !== folder.media_id);
    favMenu.innerHTML = `
      <div class="cm-title">${esc(folder.title)}</div>
      <div class="cm-item" data-favact="open">打开收藏夹</div>
      <div class="cm-item" data-favact="rename">改名 / 改简介…</div>
      <div class="cm-sep"></div>
      <div class="cm-item" data-favact="clean" title="让 B 站把里面已失效的稿件一次清掉">一键清理失效内容</div>
      <div class="cm-sep"></div>
      <div class="cm-item${others.length ? '' : ' muted'}" data-favact="merge">合并到别的收藏夹…</div>
      <div class="cm-item danger" data-favact="delete">删除这个收藏夹…</div>`;
    favMenu.classList.add('show');
    const r = favMenu.getBoundingClientRect();
    favMenu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    favMenu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  }

  $('#fav-list').addEventListener('contextmenu', (e) => {
    const item = e.target.closest && e.target.closest('[data-fav]');
    if (!item || item.dataset.favNew) return;
    e.preventDefault();
    e.stopPropagation();
    const f = (S.folders || []).find((x) => x.media_id === Number(item.dataset.fav));
    openFavMenu(e.clientX, e.clientY, f);
  });

  favMenu.addEventListener('click', async (e) => {
    e.stopPropagation();
    const el = e.target.closest && e.target.closest('[data-favact]');
    if (!el) return;
    const act = el.dataset.favact;
    const f = (S.folders || []).find((x) => x.media_id === favMenuId);
    closeFavMenu();
    if (!f) return;
    if (act === 'open') { go('sort'); await loadSortFolder(f.media_id); return; }
    if (act === 'rename') { await openFolderSettings(f); return; }
    if (act === 'clean') { await cleanFolderInvalid(f); return; }
    if (act === 'merge') { await mergeFolderFlow(f); return; }
    if (act === 'delete') { await deleteFolderFlow(f); return; }
  });

  document.addEventListener('click', (e) => {
    if (favMenu.classList.contains('show') && !favMenu.contains(e.target)) closeFavMenu();
  });
  window.addEventListener('scroll', closeFavMenu, true);

  /* ---------------- 删除 / 合并收藏夹 ---------------- */
  async function deleteFolderFlow(folder) {
    const others = (S.folders || []).filter((f) => f.media_id !== folder.media_id);
    const choice = await openModal({
      title: `删除「${folder.title}」`,
      desc: '先想清楚：里面的内容你是想一起删掉，还是先搬去别的地方？',
      body: `
        <div class="del-choice">
          <label class="del-opt">
            <input type="radio" name="delmode" value="move"${others.length ? ' checked' : ' disabled'}>
            <span><b>先搬到别的收藏夹，再删这个</b>
              <small>内容不会丢${others.length ? '' : '（你只有这一个收藏夹，没地方可搬）'}</small></span>
          </label>
          <label class="del-opt">
            <input type="radio" name="delmode" value="purge"${others.length ? '' : ' checked'}>
            <span><b>连内容一起删掉</b>
              <small class="danger">里面有 ${folder.count} 条，删了就找不回来了</small></span>
          </label>
        </div>
        <div class="field" id="del-target-wrap" style="margin-top:10px">
          <label>搬到哪儿</label>
          <select id="del-target">${others.map((f) =>
            `<option value="${f.media_id}">${esc(f.title)}（${f.count} 条）</option>`).join('')}</select>
        </div>`,
      okText: '继续',
      collect: () => {
        const picked = document.querySelector('input[name="delmode"]:checked');
        if (!picked) { toast('选一个吧', 'warn'); return false; }
        return {
          mode: picked.value,
          target: Number(($('#del-target') || {}).value || 0),
        };
      },
    });
    if (!choice) return;
    if (choice.mode === 'move' && !choice.target) {
      toast('得选一个要搬去的地方', 'warn');
      return;
    }

    const ok = await confirmBox(
      '最后确认一下',
      choice.mode === 'move'
        ? `先把「${folder.title}」里的内容搬到目标收藏夹，然后把「${folder.title}」删掉。<br>内容不会丢。`
        : `会<b>连同 ${folder.count} 条内容一起删掉</b>「${folder.title}」。<br>这个动作收不回来，B 站那边也找不回。`,
      '确认删除'
    );
    if (!ok) return;

    try {
      const d = await api('/api/folder/delete', {
        media_id: folder.media_id,
        move_to: choice.mode === 'move' ? choice.target : 0,
      });
      toast(d.message || '已经删掉了', 'ok', 7000);
      resetTaskView();
      toggleTaskPop(true);
      await afterFolderGone(folder.media_id);
    } catch (err) { toast(err.message, 'err', 6000); }
  }

  async function mergeFolderFlow(folder) {
    const others = (S.folders || []).filter((f) => f.media_id !== folder.media_id);
    if (!others.length) { toast('你只有一个收藏夹，没地方可合并', 'warn'); return; }
    const res = await openModal({
      title: `把「${folder.title}」合并到…`,
      desc: '内容会复制一份过去，目标里已经有的会自动跳过。',
      body: `
        <div class="field"><label>合并到</label>
          <select id="merge-target">${others.map((f) =>
            `<option value="${f.media_id}">${esc(f.title)}（${f.count} 条）</option>`).join('')}</select></div>
        <label class="switch" style="margin-top:10px">
          <input type="checkbox" id="merge-keep">
          <span class="track"></span>
          <span class="txt">保留原来的收藏夹
            <small>默认不保留 —— 合并完就把「${esc(folder.title)}」删掉（内容已经过去了）</small></span>
        </label>`,
      okText: '开始合并',
      collect: () => ({
        target: Number(($('#merge-target') || {}).value || 0),
        keep: !!($('#merge-keep') || {}).checked,
      }),
    });
    if (!res || !res.target) return;
    let merged = false;
    try {
      const d = await api('/api/folder/merge', {
        src_media_id: folder.media_id,
        tar_media_id: res.target,
      });
      toast(d.message || '合并完成', 'ok', 7000);
      merged = true;
      resetTaskView();
      toggleTaskPop(true);
    } catch (err) { toast(err.message, 'err', 6000); }
    if (!merged || res.keep) {
      if (merged) await refreshFolders();
      return;
    }
    const ok = await confirmBox(
      '删掉原来的收藏夹？',
      `内容已经复制过去了，现在把「${esc(folder.title)}」删掉。<br>删之前会再确认一次。`,
      '继续'
    );
    if (!ok) return;
    try {
      const d = await api('/api/folder/delete', { media_id: folder.media_id });
      toast(d.message || '原来的收藏夹删掉了', 'ok', 6000);
      await afterFolderGone(folder.media_id);
    } catch (err) { toast(err.message, 'err', 6000); }
  }

  /** 收藏夹没了之后的收尾：刷新列表，正在整理的那个也清掉 */
  async function afterFolderGone(mediaId) {
    if (S.sort.folder && S.sort.folder.media_id === mediaId) {
      S.sort.folder = null;
      S.sort.items = [];
      S.sort.order = [];
      S.sort.original = [];
      S.sort.deleted = new Set();
      S.sort.extra = [];
    }
    await refreshFolders();
    if (!S.sort.folder) {
      $('#sort-workspace').classList.add('hidden');
      $('#sort-picker').classList.remove('hidden');
      $('#sort-folder-title').textContent = '还没选收藏夹';
    }
  }

  $('#fav-clean-all').addEventListener('click', async () => {
    if (!S.account) { toast('先登录', 'warn'); return; }
    const n = (S.folders || []).length;
    if (!n) { toast('还没读到收藏夹列表', 'warn'); return; }
    const ok = await confirmBox(
      '把所有收藏夹的失效内容都清一遍？',
      `会挨个让 B 站清理你这 <b>${n}</b> 个收藏夹里的失效稿件。<br>
       只动已经失效的，正常内容不受影响；但发出去就收不回来了。`,
      '开始清理'
    );
    if (!ok) return;
    try {
      const d = await api('/api/folder/clean-all', {});
      toast(d.message || '已经交给 B 站了', 'ok', 7000);
      resetTaskView();
      toggleTaskPop(true);
    } catch (err) { toast(err.message, 'err', 6000); }
  });

  function updateFavHint(msg) {
    const el = $('#fav-hint'), online = $('#fav-scan-online');
    if (!el) return;
    if (online) {
      online.classList.toggle('hidden', !FAV.kw || !FAV.done || FAV.scanning || !S.account);
      online.textContent = FAV.onlineDone ? '重新在线查找' : '在线补查';
    }
    el.classList.toggle('scanning', FAV.scanning);
    if (msg) { el.textContent = msg; return; }
    if (!S.account) { el.textContent = '登录之后才能列出你的收藏夹'; return; }
    if (FAV.scanning) { el.textContent = '正在查询…'; return; }
    if (!FAV.kw) { el.textContent = '先查收藏夹名字和本地缓存中的标题 / UP 主；需要最新结果时点「在线补查」。'; return; }
    if (FAV.cacheError && !FAV.onlineDone) { el.textContent = '本地缓存暂时读不到。可重新输入重试，或点「在线补查」。'; return; }
    const age = FAV.oldest ? new Date(FAV.oldest * 1000).toLocaleString('zh-CN', {hour12:false}) : '未知时间';
    el.textContent = `找到 ${favResults().length} 个收藏夹。`
      + (FAV.onlineDone ? `已在线查找（每夹最多前 20 条）${FAV.failed ? `；${FAV.failed} 个读取失败` : ''}。`
        : `本地缓存覆盖 ${FAV.cached}/${S.folders.length} 个，最早更新：${age}。未缓存或缓存后新增的内容需在线补查。`);
  }

  function stopFavScan(quiet) {
    favScanToken += 1;
    clearTimeout(favSearchTimer);
    FAV.scanning = false;
    if (!quiet && FAV.kw) FAV.done = true;
    const btn = $('#fav-scan-stop'); if (btn) btn.classList.add('hidden');
    if (!quiet) { updateFavHint(); renderFavList(); }
  }

  async function startFavScan(kw, online = false) {
    if (!S.account || !kw || !S.folders.length) return;
    const token = ++favScanToken;
    const current = () => token === favScanToken && kw === FAV.kw;
    const folders = S.folders.slice();
    FAV.scanning = true; FAV.done = false;
    $('#fav-scan-stop').classList.remove('hidden');
    updateFavHint(online ? '正在在线补查…' : '正在查本地缓存…');
    if (!online) {
      FAV.hits.clear(); FAV.hitCounts.clear(); FAV.cached = 0; FAV.oldest = 0; FAV.onlineDone = false; FAV.failed = 0; FAV.cacheError = false;
      try {
        const r = await api('/api/folder/search-cache', {keyword: kw, media_ids: folders.map(f => f.media_id)});
        if (!current()) return;
        FAV.cached = (r.folders || []).length;
        for (const f of r.folders || []) {
          if (f.items?.length) { FAV.hits.set(Number(f.media_id), f.items); FAV.hitCounts.set(Number(f.media_id), Number(f.count) || f.items.length); }
          if (f.fetched_at) FAV.oldest = FAV.oldest ? Math.min(FAV.oldest, f.fetched_at) : f.fetched_at;
        }
      } catch (_) { if (current()) FAV.cacheError = true; }
    } else {
      // 用户主动发起；沿用原来的串行查询和全局限速，取消后不再追加请求。
      let i = 0; FAV.failed = 0; FAV.onlineDone = false;
      for (const f of folders) {
        if (!current()) return;
        updateFavHint(`正在在线查第 ${++i}/${folders.length} 个收藏夹…`);
        try {
          const r = await api(`/api/folder/items?media_id=${f.media_id}&keyword=${encodeURIComponent(kw)}`);
          if (!current()) return;
          if (r.items?.length) { FAV.hits.set(f.media_id, r.items); FAV.hitCounts.set(f.media_id, r.items.length); }
          else { FAV.hits.delete(f.media_id); FAV.hitCounts.delete(f.media_id); }
          renderFavList();
        } catch (_) { if (current()) FAV.failed += 1; }
      }
      FAV.onlineDone = true;
    }
    if (!current()) return;
    FAV.scanning = false; FAV.done = true;
    $('#fav-scan-stop').classList.add('hidden');
    updateFavHint(); renderFavList();
  }

  $('#fav-scan-online').addEventListener('click', () => startFavScan(FAV.kw, true));

  favBtn.addEventListener('click', () => toggleFavDrawer());
  $('#fav-close').addEventListener('click', () => toggleFavDrawer(false));

  $('#fav-search').addEventListener('input', (e) => {
    FAV.kw = e.target.value.trim().toLowerCase();
    FAV.hits.clear(); FAV.hitCounts.clear();
    FAV.done = false; FAV.cached = 0; FAV.oldest = 0; FAV.onlineDone = false; FAV.failed = 0;
    stopFavScan(true);
    renderFavList();
    updateFavHint();
    clearTimeout(favSearchTimer);
    if (!FAV.kw) return;
    // 名字过滤是立刻的；再等一下子，本鱼去收藏夹里头翻视频
    favSearchTimer = setTimeout(() => startFavScan(FAV.kw), 700);
  });

  $('#fav-scan-stop').addEventListener('click', () => {
    stopFavScan();
    toast('停下来啦', 'info', 2000);
  });

  $('#fav-list').addEventListener('click', async (e) => {
    const el = e.target.closest && e.target.closest('[data-fav]');
    if (el) {
      // 侧栏留在原地：这样能连着挑几个收藏夹换着看
      go('sort');
      loadSortFolder(Number(el.dataset.fav));
      return;
    }
    // 列表末尾那个「新建收藏夹」
    if (e.target.closest && e.target.closest('[data-fav-new]')) {
      const folder = await createFolderFlow();
      if (!folder) return;
      renderFavList();
      updateFavHint();
      if (folder.media_id) {
        go('sort');
        loadSortFolder(folder.media_id);
      }
    }
  });

  $('#fav-refresh').addEventListener('click', async () => {
    if (!await requireLogin()) return;
    await refreshFolders();
    renderFavList();
    updateFavHint();
    // 顺手把当前开着的那个收藏夹也重读一遍（原来标题条上那个刷新按钮干的活）
    if (S.sort.folder) {
      await loadSortFolder(S.sort.folder.media_id, true);
      toast('收藏夹列表和当前这个都重读了一遍', 'ok');
    } else {
      toast('收藏夹列表刷新好了', 'ok');
    }
  });

  /* ======================================================== 预览 / 整理 模式 */
  /*
    默认是预览：只能看、能筛，卡片拖不动，底栏那些提交按钮也收起来。
    想动顺序得先按「开始整理」—— 按钮会从白底蓝边变成琥珀实心，
    文案也跟着变，开没开一眼能看出来。
  */
  /** 把涟漪的圆心定在按钮中心，扩散和收回都从这儿开始（坐标相对涟漪的宿主行） */
  function rippleFrom(btn) {
    const ripple = $('#sort-ripple');
    const host = ripple ? ripple.parentElement : null;
    if (!ripple || !host || !btn) return;
    const b = btn.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    // 用相对位置保存圆心；侧栏挤窄标题条后，旧的像素圆心可能落到框外，
    // 即使仍在整理模式，整个扩散圆也会移出可见区域。
    const percent = (offset, size) => Math.max(0, Math.min(100, size ? offset / size * 100 : 50));
    ripple.style.setProperty('--rx', percent(b.left + b.width / 2 - h.left, h.width).toFixed(2) + '%');
    ripple.style.setProperty('--ry', percent(b.top + b.height / 2 - h.top, h.height).toFixed(2) + '%');
  }

  function setSortMode(editing) {
    const on = !!editing;
    if (S.sort.editing === on) return;
    S.sort.editing = on;
    const btn = $('#sort-mode');
    rippleFrom(btn);   // 先定圆心再切 class，过渡才会从按钮那儿铺开（收回时原路返回）
    document.body.classList.toggle('sort-editing', on);
    const txt = $('#sort-mode-text');
    if (btn) {
      btn.classList.toggle('on', on);
      btn.title = on
        ? '存到本地并回到预览；这一步不会上传，要上传得点「提交改动」'
        : '预览是只读的；想动顺序得先点这里';
    }
    if (txt) txt.textContent = on ? '保存整理' : '开始整理';
    renderSortList();
    updateSortStats();
    if (tutState?.page === 'sort' && tutRefreshSteps()) tutRender();
  }

  /** 只把模式 UI 复位，不触发重渲染（换收藏夹时用） */
  function resetSortMode() {
    setDraftState('');
    S.sort.editing = false;
    document.body.classList.remove('sort-editing');
    const btn = $('#sort-mode');
    const txt = $('#sort-mode-text');
    if (btn) {
      btn.classList.remove('on');
      btn.title = '预览是只读的；想动顺序得先点这里';
    }
    if (txt) txt.textContent = '开始整理';
    if (tutState?.page === 'sort' && tutRefreshSteps()) tutRender();
  }

  /** 快捷保存只写草稿，保留整理模式和当前选择；与自动保存使用同一条写入队列。 */
  async function quickSaveDraft() {
    if (sortModeSaving || !S.sort.editing || !S.sort.folder) return;
    const mediaId = S.sort.folder.media_id;
    const saving = saveDraftNow();
    flushUiSave();
    const version = draftVersion;
    if (await saving && version === draftVersion && S.sort.folder?.media_id === mediaId) {
      toast('草稿已保存到本机，可以继续整理', 'ok');
    }
  }

  /** 还没挑收藏夹时自动开一个：优先上次用的那个，没有就用列表里第一个 */
  async function openDefaultSortFolder() {
    if (!S.account) { toast('先登录一下，才读得到收藏夹', 'warn'); return false; }
    if (!S.folders.length) {
      try { await refreshFolders(); } catch (_) {}
    }
    if (!S.folders.length) { toast('这个账号下还没有收藏夹', 'warn'); return false; }
    let last = 0;
    try { last = Number(localStorage.getItem('bilifav.lastFolder') || 0); } catch (_) {}
    const pick = S.folders.find((f) => f.media_id === last) || S.folders[0];
    go('sort');
    await loadSortFolder(pick.media_id);
    return true;
  }

  $('#sort-mode').addEventListener('click', async () => {
    if (sortModeSaving) return;
    if (S.sort.loading || sortWriteBusy()) { toast('列表读取或写入任务完成后再整理', 'warn'); return; }
    const on = !S.sort.editing;
    if (on && !S.sort.folder) {
      // 还没开收藏夹：先把上次那个（或第一个）拉出来，再进整理模式
      const ok = await openDefaultSortFolder();
      if (!ok) return;
    }
    if (on) {
      setSortMode(true);
      toast('整理模式开啦：能拖动、能标记删除', 'ok');
      return;
    }
    const section = $('.page[data-page="sort"]');
    const btn = $('#sort-mode');
    sortModeSaving = true;
    btn.disabled = true;
    section.inert = true;
    $('#sort-mode-text').textContent = '正在保存…';
    try {
      if (!await saveDraftNow()) return;
      setSortMode(false);
      toast('已保存到本机；要同步到 B 站，请进入整理后点「提交改动」', 'ok');
    } finally {
      sortModeSaving = false;
      section.inert = false;
      btn.disabled = false;
      if (S.sort.editing) $('#sort-mode-text').textContent = '保存整理';
    }
  });

  /* ======================================================== 分页 / 页目录 */
  /*
    「每页 30」是按「完整顺序」的位次切段 —— 所以第 2 页永远是从全部的第 31 个起，
    右键把某条「发送到第 2 页」就等于把它挪到全部的第 31 格，后面的顺延。
  */
  function pageSlice() {
    const total = S.sort.order.length;
    const size = S.sort.pageSize || 0;
    if (!size) return { from: 0, to: total, pages: 1 };
    const pages = Math.max(1, Math.ceil(total / size));
    if (S.sort.page > pages) S.sort.page = pages;
    if (S.sort.page < 1) S.sort.page = 1;
    const from = (S.sort.page - 1) * size;
    return { from, to: Math.min(total, from + size), pages };
  }

  /** 筛选范围那个开关的样子（本页 / 本收藏夹） */
  function updateScopeUI() {
    const btn = $('#sort-scope');
    const txt = $('#sort-scope-text');
    const all = S.sort.filterScope === 'folder';
    if (btn) {
      btn.classList.toggle('on', all);
      btn.setAttribute('aria-pressed', String(all));
      btn.title = all
        ? '筛选范围：本收藏夹 —— 整个夹子一起筛（跨页）'
          + '。点一下换回「本页」'
        : '筛选范围：本页 —— 只筛眼前这一页。点一下换成「本收藏夹」';
    }
    if (txt) txt.textContent = all ? '本收藏夹' : '本页';
  }

  function updatePageUI() {
    updateScopeUI();
    const box = $('#sort-boxes');
    if (box) box.classList.toggle('off', !S.sort.pageSize);
    const btxt = $('#sort-boxes-text');
    if (btxt) {
      if (!S.sort.pageSize) {
        btxt.textContent = '页目录';
      } else if (filterAllScope()) {
        // 整夹筛选的时候整份结果是一屏铺完的，页码在这里没有意义
        btxt.textContent = '页目录';
      } else {
        const { pages } = pageSlice();
        btxt.textContent = `页目录 ${S.sort.page}/${pages}`;
      }
    }
    // 页目录里那组「每页多少个」跟着高亮
    const cur = S.sort.pageSize || 0;
    const preset = [20, 30, 50, 0];
    $$('#page-size-opts .pageopt').forEach((el) => {
      const ds = el.dataset.size;
      // 自定义档位：当前不是任何预设值，而且不是 0（0 是"无限"）
      const on = ds === 'custom' ? (!preset.includes(cur) && cur > 0)
                                 : Number(ds) === cur;
      el.classList.toggle('on', on);
    });
    // 底栏左边那组横向翻页（右上角有页目录，这里也留一份顺手）
    const pager = $('#sort-pager');
    if (pager) {
      // 整夹筛选时结果是一屏铺完的，没有页可翻 —— 先把翻页收起来
      const on = !!S.sort.pageSize && !filterAllScope();
      pager.classList.toggle('hidden', !on);
      if (on) {
        const { pages } = pageSlice();
        const now = $('#pager-now');
        const tot = $('#pager-total');
        if (now) now.textContent = String(S.sort.page);
        if (tot) tot.textContent = String(pages);
        const prev = $('#pager-prev');
        const next = $('#pager-next');
        if (prev) prev.disabled = S.sort.page <= 1;
        if (next) next.disabled = S.sort.page >= pages;
      }
    }
  }

  /** 换每页多少个；原来锁着的页会全部失效，所以要先问一句 */
  async function setPageSize(size) {
    const next = size || 0;
    if (next === (S.sort.pageSize || 0)) return true;
    const hadLocks = S.sort.locked.size > 0;
    if (hadLocks) {
      const from = S.sort.pageSize ? `每页 ${S.sort.pageSize} 个` : '平铺';
      const to = next ? `每页 ${next} 个` : '平铺';
      const ok = await confirmBox(
        '换显示方式要先清掉分页锁',
        `现在是「${from}」，有 <b>${S.sort.locked.size}</b> 页锁着。<br>
         换成「${to}」之后页号会整个重排，那些锁就对不上了，得跟着取消。<br>要继续吗？`,
        '换，并取消锁'
      );
      if (!ok) return false;
      if (!pushHistory()) return;
      S.sort.locked.clear();
      renderBoxPanel();
    }
    if (!hadLocks && !pushHistory()) return;
    if (next) S.sort.lastBoxSize = next;
    S.sort.pageSize = next;
    S.sort.page = 1;
    lsSave('bilifav.pageSize', String(next), '每页数量');
    updatePageUI();
    renderSortList();
    updateSortStats();
    if ($('#boxpanel').classList.contains('show')) renderBoxPanel();
    return true;
  }

  function setPage(p) {
    const { pages } = pageSlice();
    S.sort.page = Math.max(1, Math.min(pages, Number(p) || 1));
    updatePageUI();
    renderSortList();
    renderBoxPanel();
    const sc = $('.page[data-page="sort"] .scroll');
    if (sc) sc.scrollTop = 0;
  }

  /*
    把正拖着的那批卡片丢到某一页 = 直接送到那一页。

    落到哪：**那一页的第一个位置**。
    "送到第 N 页"这个说法只承诺"它现在在第 N 页"，插在开头最直观、
    也最好解释；要是插在中间，用户还得再猜一次到底插哪儿去了。

    注意顺序：目标位置必须**在把卡片摘掉之后**再算。
    否则前几页被摘走若干张、下标整体前移，算出来的落点会偏。
  */
  function sendBlockToPage(pageNo) {
    const size = S.sort.pageSize || 0;
    if (!size || !dragState || !(dragState.block || []).length) return false;

    const order = S.sort.order;
    const moving = dragState.block.filter((k) => order.includes(k));
    if (!moving.length) return false;

    const rest = order.filter((k) => !moving.includes(k));
    // 目标页在"摘掉卡片之后"的第一个 key
    const anchor = rest[(pageNo - 1) * size] || null;
    const at = anchor ? Math.max(0, rest.indexOf(anchor)) : rest.length;

    // 已经在那个位置了就别白记一笔撤销
    const before = order.slice();
    const next = rest.slice();
    next.splice(at, 0, ...moving);
    if (before.join('\u0000') === next.join('\u0000')) return false;

    if (!pushHistory()) return;
    S.sort.order = next;
    S.sort.page = pageNo;              // 跟过去，让用户看见结果
    return true;
  }

  /**
   * 页目录面板底部的统计。
   *
   * 时长给两个口径（分钟 / 小时）是因为 3000 分钟这种数字没法直观感受，
   * 折成"50 小时"才知道大概多长。
   *
   * 另外多算了几项：播放量合计、UP 主数、失效数、带标签的条数 ——
   * 这几个都是"想了解这个收藏夹"时会顺口问一句的。
   */
  /**
   * 页目录面板底部的统计。
   *
   * 只要四项：视频数、总时长、折合分钟、折合小时。
   * 时长给三个写法是因为单看一个都不够直观 ——
   * "39 小时 28 分"好读，"2368 分钟"能跟别人的数字直接比，
   * "39.5 小时"适合估算。
   *
   * 别再加了：面板本来就窄，统计一长就挤掉页格子。
   */
  function renderBoxStats() {
    const box = $('#box-stats');
    if (!box) return;
    const signature = [S.sort.items, S.sort.extra, S.sort.extra.length, S.sort.order, S.sort.order.length, S.sort.deleted, S.sort.deleted.size, localHistoryRevision];
    if (renderBoxStats.signature?.every((v,i) => v === signature[i])) return;
    renderBoxStats.signature = signature;
    const map = itemMap();
    let n = 0, sec = 0;
    S.sort.order.forEach((k) => {
      if (S.sort.deleted.has(k)) return;      // 标了要删的不算进"现有"
      const it = map.get(k);
      if (!it) return;
      n += 1;
      sec += Number(it.duration) || 0;
    });
    const mins = Math.round(sec / 60);
    const hours = (sec / 3600).toFixed(1);
    const hms = () => {
      const h = Math.floor(sec / 3600);
      const mm = Math.floor((sec % 3600) / 60);
      return h ? `${h} 小时 ${mm} 分` : `${mm} 分`;
    };

    const rows = [
      ['视频数', `${n} 个`],
      ['总时长', hms()],
      ['折合分钟', `${mins} 分钟`],
      ['折合小时', `${hours} 小时`],
    ];
    box.innerHTML = `<div class="bs-head">这个收藏夹</div>
      <div class="bs-grid">
        ${rows.map(([k, v]) => `<div class="bs-cell"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
      </div>`;
  }

  function renderBoxPanel() {
    try { renderBoxStats(); } catch (_) { /* 统计坏了大不了不显示，别拖累页目录 */ }

    const grid = $('#boxpanel-grid');
    if (!grid) return;
    const sub = $('#boxpanel-sub');
    const now = $('#boxpanel-now');
    const total = S.sort.order.length;
    const size = S.sort.pageSize || 0;
    const prev = $('#boxpanel-prev');
    const next = $('#boxpanel-next');
    if (!size) {
      grid.innerHTML = '<div class="hint" style="grid-column:1/-1">现在是「平铺」，全部铺出来了。<br>用上面的「每页」切回分页，就有页目录和分页锁了。</div>';
      if (sub) { sub.textContent = `共 ${total} 条 · 全部铺开`; sub.title = sub.textContent; }
      delete grid.dataset.currentPage; renderBoxPanel.state = null;
      if (now) now.textContent = '第 1 / 1 页';
      if (prev) prev.disabled = true;
      if (next) next.disabled = true;
      return;
    }
    const { pages } = pageSlice();
    if (sub) { sub.textContent = `每页 ${size} 个 · 共 ${total} 条`; sub.title = sub.textContent; }
    if (now) now.textContent = `第 ${S.sort.page} / ${pages} 页`;
    if (prev) prev.disabled = S.sort.page <= 1;
    if (next) next.disabled = S.sort.page >= pages;
    const structure = `${currentFolderId()}:${size}:${total}`;
    let state = renderBoxPanel.state;
    if (!state || state.grid !== grid || state.structure !== structure || grid.children.length !== pages) {
    let html = '';
    for (let p = 1; p <= pages; p++) {
      const from = (p - 1) * size;
      const n = Math.max(0, Math.min(size, total - from));
      const locked = S.sort.locked.has(p);
      html += `<div class="boxcell${p === S.sort.page ? ' on' : ''}${locked ? ' locked' : ''}"`
        + ` data-boxpage="${p}" draggable="true"`
        + ` title="点一下跳过去；右键有锁定 / 删掉这一页；按住拖能挪位置或跟别的页对调">`
        + `<button class="bc-lock" data-lockpage="${p}" title="${locked
          ? `第 ${p} 页已锁定：直接放入视频前需解锁；全局排序仍可能改变内容。点一下解锁`
          : `锁定第 ${p} 页：限制直接放入视频，不冻结整页内容`}">`
        + `<svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><use href="#${locked ? 'i-lock' : 'i-unlock'}"/></svg>`
        + `</button>`
        + `<b>第 ${p} 页</b><span>${n} 个 · ${from + 1}–${from + n}</span></div>`;
    }
    grid.innerHTML = html;
    state = renderBoxPanel.state = {grid, structure, page: 0, locked: new Set(S.sort.locked),
      cells: new Map([...grid.children].map(el => [Number(el.dataset.boxpage), el]))};
    }
    // 页数和分段没有变化时保留节点；只更新当前页与变化的锁。
    if (state.page !== S.sort.page) {
      state.cells.get(state.page)?.classList.remove('on');
      state.cells.get(S.sort.page)?.classList.add('on');
    }
    for (const page of new Set([...state.locked, ...S.sort.locked])) {
      const locked = S.sort.locked.has(page);
      if (locked === state.locked.has(page)) continue;
      const cell = state.cells.get(page), button = cell?.querySelector('.bc-lock');
      cell?.classList.toggle('locked', locked);
      if (button) {
        button.title = locked ? `第 ${page} 页已锁定：直接放入视频前需解锁；全局排序仍可能改变内容。点一下解锁`
          : '锁定后限制直接放入视频，不冻结整页内容';
        button.querySelector('use')?.setAttribute('href', locked ? '#i-lock' : '#i-unlock');
      }
    }
    state.locked = new Set(S.sort.locked);
    // 更多页只在目录内部滚动，不截断页数；翻页后把当前页带到可见范围。
    if (grid.dataset.currentPage !== String(S.sort.page)) {
      const cell = state.cells.get(S.sort.page);
      if (cell) {
        const area = grid.getBoundingClientRect(), rect = cell.getBoundingClientRect();
        if (rect.top < area.top) grid.scrollTop += rect.top - area.top;
        else if (rect.bottom > area.bottom) grid.scrollTop += rect.bottom - area.bottom;
      }
    }
    grid.dataset.currentPage = String(S.sort.page); state.page = S.sort.page;
  }

  function toggleBoxPanel(show) {
    const el = $('#boxpanel');
    if (!el) return;
    const on = show === undefined ? !el.classList.contains('show') : !!show;
    if (!on) stopBoxAutoScroll();
    if (on) {
      renderBoxPanel();
      /*
        把上一版 placeBoxPanel 留下的内联定位清掉。
        它当年会写 style.right / top / maxHeight，而**内联样式压得过 CSS** ——
        不清的话面板还钉在旧位置，压根贴不到右边，CSS 那边的侧边栏白写。
      */
      el.style.top = '';
      el.style.bottom = '';
      el.style.left = '';
      el.style.right = '';
      el.style.maxHeight = '';
    }
    el.classList.toggle('show', on);
    /*
      侧边栏是"占地方"不是"盖上去"（跟左侧收藏夹栏一个规矩）：
      body 上挂个 box-open，内容区往左让出 var(--box-w)。
      让位之后可用宽度变了，列数得重算。
    */
    document.body.classList.toggle('box-open', on);
    /*
      只调 applyGridCols()（它就是改个 --cols 变量，CSS 会自己重排），
      **绝对不能**在这里 renderSortList() —— 那会重建整个网格，
      而 dragstart 里会调到这里（提起卡片时自动开页目录），
      源元素一被替换，浏览器当场取消这次拖拽：
      表现就是能拖、但落点提示线不出现、松手什么都没发生。
    */
    try { applyGridCols(); } catch (_) {}
    $('#sort-boxes').classList.toggle('on', on);
  }

  /* ---------------- 分页锁定 ----------------
     锁上某一页，就表示"这一页钉住了"：往里塞东西之前得先解锁，
     否则那一页原有的视频会被挤得往后顺延。
     新增的视频永远是追加到最末尾，所以锁最后一页也拦不住它 —— 这是有意的。 */
  function togglePageLock(page) {
    if (!pushHistory()) return;
    if (S.sort.locked.has(page)) {
      S.sort.locked.delete(page);
      toast(`第 ${page} 页解锁了`, 'info');
    } else {
      S.sort.locked.add(page);
      toast(`第 ${page} 页锁上了：向这页放入视频前需解锁`, 'ok', 4200);
    }
    updateSortStats();
    renderBoxPanel();
    // 页目录关着的话，锁的状态靠右键菜单那个小锁体现，顺手刷一下也行
    if ($('#boxpanel').classList.contains('show')) renderBoxPanel();
  }

  /** 目标页锁着就先问一句；返回 true 表示可以继续往里放 */
  async function askUnlockForPage(page, count) {
    if (!S.sort.locked.has(page)) return true;
    const ok = await confirmBox(
      `第 ${page} 页已锁定`,
      `这页限制直接放入视频。<br>要把它解锁，再把 <b>${count}</b> 个视频放进去吗？`,
      '解锁并放进去'
    );
    // 取消的话：什么都不动，选中的那些也原样留着，方便换个目标再试
    return !!ok;
  }

  /* ---------------- 页目录：右键管理 + 按住拖页 ----------------
     页本身是"每页 N 个"切出来的，所以挪页 / 对调页的实际动作，
     就是把 order 按页切段、重排、再拼回去。 */
  /** 把全部内容按「每页」切成一段段 */
  function pageBlocks() {
    const size = S.sort.pageSize || 0;
    if (!size) return [];
    const out = [];
    for (let i = 0; i < S.sort.order.length; i += size) {
      out.push(S.sort.order.slice(i, i + size));
    }
    return out;
  }

  /** 第 p 页上有哪些 key */
  function pageKeys(p) {
    const size = S.sort.pageSize || 0;
    if (!size) return S.sort.order.slice();
    const from = (p - 1) * size;
    return S.sort.order.slice(from, from + size);
  }

  /** 两页整段对调 */
  function swapPages(a, b) {
    const blocks = pageBlocks();
    if (a < 1 || b < 1 || a > blocks.length || b > blocks.length || a === b) return false;
    const t = blocks[a - 1];
    blocks[a - 1] = blocks[b - 1];
    blocks[b - 1] = t;
    S.sort.order = blocks.flat();
    return true;
  }

  /** 把第 from 页整段挪到第 to 页的前面 / 后面 */
  function movePageBlock(fromPage, toPage, before) {
    const blocks = pageBlocks();
    const fi = fromPage - 1;
    let ti = toPage - 1;
    if (fi < 0 || fi >= blocks.length) return false;
    if (ti < 0 || ti >= blocks.length || ti === fi) return false;
    const [moved] = blocks.splice(fi, 1);
    if (ti > fi) ti -= 1;              // 前面的被抽走了，后面的下标要往前挪一格
    if (!before) ti += 1;
    ti = Math.max(0, Math.min(ti, blocks.length));
    blocks.splice(ti, 0, moved);
    S.sort.order = blocks.flat();
    return true;
  }

  /** 页面动过之后页号整个重排，之前锁的页就对不上了，统一清掉 */
  function clearLocksAfterPageMove() {
    if (!S.sort.locked.size) return false;
    const n = S.sort.locked.size;
    S.sort.locked.clear();
    toast(`页面动过了，之前锁的 ${n} 页已经解锁（页号重排了）`, 'warn', 4600);
    return true;
  }

  /** 把这一页的内容全标成待删除（提交后才真的删） */
  function deletePageContents(page) {
    if (!S.sort.editing) { toast('先点「开始整理」才能改', 'warn'); return; }
    const keys = pageKeys(page);
    if (!keys.length) { toast('这一页是空的', 'warn'); return; }
    const todo = keys.filter((k) => !S.sort.deleted.has(k));
    if (!todo.length) { toast('这一页已经全标上待删除了', 'info'); return; }
    if (!pushHistory()) return;
    todo.forEach((k) => S.sort.deleted.add(k));
    renderSortList();
    updateSortStats();
    renderBoxPanel();
    toast(`第 ${page} 页的 ${todo.length} 条都标成待删除了 —— 点「提交改动」才真的删`, 'ok', 6500);
  }

  /* -------- 按住拖页：往两边拖是"插过去"，往中间拖是"对调" -------- */
  let boxDragPage = 0;
  let boxPressAt = 0;
  const boxDropMarks = new Set();
  let boxScrollRaf = null;
  let boxScrollPoint = null;

  function stopBoxAutoScroll() {
    if (boxScrollRaf !== null) cancelAnimationFrame(boxScrollRaf);
    boxScrollRaf = null;
    boxScrollPoint = null;
  }
  window.addEventListener('blur', stopBoxAutoScroll);

  function boxAutoScrollStep() {
    boxScrollRaf = null;
    if (!boxScrollPoint || (!boxDragPage && !dragState?.key)) return;
    const grid = $('#boxpanel-grid'), rect = grid.getBoundingClientRect();
    const { x, y } = boxScrollPoint;
    const edge = Math.min(48, rect.height / 3);
    const distance = y < rect.top + edge ? y - rect.top - edge
      : y > rect.bottom - edge ? y - rect.bottom + edge : 0;
    if (!distance || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    const before = grid.scrollTop;
    grid.scrollTop += Math.sign(distance) * Math.max(2, Math.min(14, Math.abs(distance) / 3));
    if (grid.scrollTop === before) return;
    paintBoxDragTarget(document.elementFromPoint(x, y)?.closest('.boxcell[data-boxpage]'), x);
    boxScrollRaf = requestAnimationFrame(boxAutoScrollStep);
  }

  function updateBoxAutoScroll(e) {
    boxScrollPoint = { x: e.clientX, y: e.clientY };
    if (boxScrollRaf === null) boxScrollRaf = requestAnimationFrame(boxAutoScrollStep);
  }

  function paintBoxDragTarget(cell, clientX) {
    if (dragState?.key) {
      paintCardHover(cell ? Number(cell.dataset.boxpage) : 0);
      return;
    }
    clearBoxDropMarks();
    if (!cell || !boxDragPage || Number(cell.dataset.boxpage) === boxDragPage) return;
    const r = cell.getBoundingClientRect();
    const rel = (clientX - r.left) / Math.max(1, r.width);
    const mode = rel < 0.32 ? 'before' : rel > 0.68 ? 'after' : 'swap';
    cell.dataset.dropmode = mode;
    cell.classList.add('drop-' + mode);
    boxDropMarks.add(cell);
  }

  const clearBoxDropMarks = () => {
    for (const el of boxDropMarks) {
      el.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-swap');
      delete el.dataset.dropmode;
    }
    boxDropMarks.clear();
  };

  $('#boxpanel-grid').addEventListener('mousedown', (e) => {
    const cell = e.target.closest && e.target.closest('.boxcell[data-boxpage]');
    if (!cell || e.button !== 0 || (e.target.closest && e.target.closest('.bc-lock'))) {
      boxPressAt = 0;
      return;
    }
    boxPressAt = Date.now();
  }, true);

  $('#boxpanel-grid').addEventListener('dragstart', (e) => {
    const cell = e.target.closest && e.target.closest('.boxcell[data-boxpage]');
    if (!cell || !S.sort.pageSize) { e.preventDefault(); return; }
    // 跟卡片、标签一个规矩：按住一会儿才给拖，不然跟"点一下跳页"打架
    if (!boxPressAt || Date.now() - boxPressAt < LONG_PRESS_MS) { e.preventDefault(); return; }
    boxDragPage = Number(cell.dataset.boxpage);
    cell.classList.add('dragging');
    boxDropMarks.add(cell);
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(boxDragPage));
    } catch (_) {}
  });

  /*
    卡片拖到格子上：整格高亮，表示"松手就送到这一页"。
    跟"拖整页"（boxDragPage）是两回事，所以先判断手里拿的是哪种。
  */
  let cardHoverPage = 0;

  const paintCardHover = (pageNo) => {
    if (cardHoverPage === pageNo) return;
    $(`#boxpanel-grid [data-boxpage="${cardHoverPage}"]`)?.classList.remove('card-over');
    cardHoverPage = pageNo;
    $(`#boxpanel-grid [data-boxpage="${pageNo}"]`)?.classList.add('card-over');
  };

  const clearCardHover = () => {
    $(`#boxpanel-grid [data-boxpage="${cardHoverPage}"]`)?.classList.remove('card-over');
    cardHoverPage = 0;
  };

  $('#boxpanel-grid').addEventListener('dragover', (e) => {
    if (dragState?.key || boxDragPage) updateBoxAutoScroll(e);
    // 手里是卡片（不是页）—— 拦下来，走"送到这一页"
    if (dragState && dragState.key) {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
      const cell = e.target.closest && e.target.closest('.boxcell[data-boxpage]');
      paintBoxDragTarget(cell, e.clientX);
      return;
    }
    if (!boxDragPage) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    const cell = e.target.closest && e.target.closest('.boxcell[data-boxpage]');
    paintBoxDragTarget(cell, e.clientX);
  });

  $('#boxpanel-grid').addEventListener('drop', (e) => {
    stopBoxAutoScroll();
    // 自动滚动后，实际松手位置下的页格可能已不同于最近一次 dragover。
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('.boxcell[data-boxpage]');
    const targetCell = hit && $('#boxpanel-grid').contains(hit) ? hit
      : e.target.closest && e.target.closest('.boxcell[data-boxpage]');
    // 卡片落到格子上 —— 直接送到这一页
    if (dragState && dragState.key) {
      const cell = targetCell;
      const pageNo = cell ? Number(cell.dataset.boxpage) : 0;
      const n = (dragState.block || []).length;
      clearCardHover();
      if (!pageNo) return;
      e.preventDefault();
      const moved = sendBlockToPage(pageNo);
      // 换页会重建源卡片，原节点的 dragend 不一定冒泡回来，须在重建前收尾。
      endCardDrag();
      if (moved) {
        toast(n > 1 ? `${n} 个已经送到第 ${pageNo} 页` : `已经送到第 ${pageNo} 页`, 'ok', 3200);
        renderSortList();
        updateSortStats();
        renderBoxPanel();
        updatePageUI();
      } else {
        toast(`已经就在第 ${pageNo} 页了`, 'info', 2600);
      }
      return;
    }
    if (!boxDragPage) return;
    e.preventDefault();
    const cell = targetCell;
    const mode = (cell && cell.dataset.dropmode) || 'before';
    const to = cell ? Number(cell.dataset.boxpage) : 0;
    const from = boxDragPage;
    boxDragPage = 0;
    clearBoxDropMarks();
    if (!to || to === from) return;
    if (!pushHistory()) return;                       // 页面重排也进撤销栈
    let ok = false;
    if (mode === 'swap') {
      ok = swapPages(from, to);
      if (ok) { clearLocksAfterPageMove(); toast(`第 ${from} 页和第 ${to} 页对调了`, 'ok', 3200); }
    } else {
      ok = movePageBlock(from, to, mode === 'before');
      if (ok) {
        clearLocksAfterPageMove();
        toast(`第 ${from} 页挪到第 ${to} 页${mode === 'before' ? '前面' : '后面'}了`, 'ok', 3200);
      }
    }
    if (!ok) return;
    const size = S.sort.pageSize || 1;
    const pages = Math.max(1, Math.ceil(S.sort.order.length / size));
    S.sort.page = Math.min(Math.max(1, S.sort.page), pages);   // 别让视图跟着跳走
    renderSortList();
    updateSortStats();
    renderBoxPanel();
    updatePageUI();
  });

  $('#boxpanel-grid').addEventListener('dragend', () => {
    stopBoxAutoScroll();
    boxDragPage = 0;
    clearBoxDropMarks();
    clearCardHover();
  });

  // 拖到格子外面了（比如拖回卡片区），把高亮撤掉
  $('#boxpanel-grid').addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || !$('#boxpanel-grid').contains(e.relatedTarget)) stopBoxAutoScroll();
    if (!dragState || !dragState.key) return;
    if (!e.relatedTarget || !$('#boxpanel-grid').contains(e.relatedTarget)) clearCardHover();
  });

  /* -------- 页目录右键菜单 -------- */
  const boxMenu = $('#box-menu');
  let boxMenuPage = 0;

  function closeBoxMenu() {
    boxMenu.classList.remove('show');
    boxMenuPage = 0;
  }

  function openBoxMenu(x, y, page) {
    if (!S.sort.pageSize) return;
    boxMenuPage = page;
    const locked = S.sort.locked.has(page);
    const n = pageKeys(page).length;
    const onIt = page === S.sort.page;
    boxMenu.innerHTML = `
      <div class="cm-title">第 ${page} 页 · ${n} 个</div>
      <div class="cm-item${onIt ? ' muted' : ''}" data-boxact="go">跳到这一页</div>
      <div class="cm-sep"></div>
      <div class="cm-item" data-boxact="lock">${locked ? '解锁这一页' : '锁定这一页'}</div>
      <div class="cm-sep"></div>
      <div class="cm-item danger" data-boxact="delpage">删掉这一页的 ${n} 条</div>`;
    boxMenu.classList.add('show');
    const r = boxMenu.getBoundingClientRect();
    boxMenu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    boxMenu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  }

  $('#boxpanel-grid').addEventListener('contextmenu', (e) => {
    const cell = e.target.closest && e.target.closest('.boxcell[data-boxpage]');
    if (!cell) return;
    e.preventDefault();
    e.stopPropagation();
    openBoxMenu(e.clientX, e.clientY, Number(cell.dataset.boxpage));
  });

  boxMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const el = e.target.closest && e.target.closest('[data-boxact]');
    if (!el) return;
    const act = el.dataset.boxact;
    const page = boxMenuPage;
    closeBoxMenu();
    if (!page) return;
    if (act === 'go') { setPage(page); return; }
    if (act === 'lock') { togglePageLock(page); return; }
    if (act === 'delpage') { deletePageContents(page); return; }
  });

  document.addEventListener('click', (e) => {
    if (boxMenu.classList.contains('show') && !boxMenu.contains(e.target)) closeBoxMenu();
  });
  window.addEventListener('scroll', closeBoxMenu, true);

  /** 真正搬顺序：这一批整体落在目标页的第一格，后面的依次顺延 */
  function applyMoveToPage(keys, page) {
    const size = S.sort.pageSize || 30;
    const set = new Set(keys);
    const moving = S.sort.order.filter((k) => set.has(k));
    if (!moving.length) return;
    if (!pushHistory()) return;
    S.sort.locked.delete(page);
    const rest = S.sort.order.filter((k) => !set.has(k));
    const at = Math.max(0, Math.min(rest.length, (page - 1) * size));
    S.sort.order = rest.slice(0, at).concat(moving, rest.slice(at));
    S.sort.page = page;
    updatePageUI();
    resetSortDim();
    renderSortList();
    updateSortStats();
    if ($('#boxpanel').classList.contains('show')) renderBoxPanel();
  }

  /** 单条：挪到第 N 页的头一格 */
  async function sendToPage(key, page) {
    if (!ensureLocalEdit()) return;
    if (!(S.sort.pageSize || 0)) { toast('先切到「分页」才能按页搬', 'warn'); return; }
    if (S.sort.order.indexOf(key) < 0) return;
    const folder = currentFolderId();
    if (!await askUnlockForPage(page, 1) || currentFolderId() !== folder) return;
    applyMoveToPage([key], page);
    toast(`挪到第 ${page} 页的第一格了`, 'ok');
  }

  /** 多选：把选中的这一批整体挪到第 N 页的头一格 */
  async function movePickedToPage(page) {
    if (!ensureLocalEdit()) return;
    const keys = pickedList();
    if (!keys.length) return;
    if (!(S.sort.pageSize || 0)) { toast('先切到「分页」才能按页搬', 'warn'); return; }
    const folder = currentFolderId();
    if (!await askUnlockForPage(page, keys.length) || currentFolderId() !== folder) return;
    applyMoveToPage(keys, page);
    toast(`把 ${keys.length} 个挪到第 ${page} 页最前面了`, 'ok', 4600);
  }

  /** 多选：给选中的这一批统一贴上一个标签（已经有了就算，不来回翻） */
  function tagAllPicked(tagId) {
    const keys = pickedList();
    if (!keys.length) return;
    const tag = tagById(tagId);
    // 有人已经贴到上限的会被跳过 —— 统计一下，提示才准
        let _ok = 0;
        if (keys.some(k => !(S.itemTags.get(k) || new Set()).has(tagId)
          && (S.itemTags.get(k)?.size || 0) < MAX_TAGS_PER_ITEM)) if (!pushHistory()) return;
        keys.forEach((k) => { if (addItemTag(k, tagId, false)) _ok += 1; });
        if (_ok) saveTags();
        const _skip = keys.length - _ok;
    renderSortList();
    renderSortTagTabs();
    toast(`给 ${_ok} 个视频贴上了「${tag ? tag.name : '标签'}」`
      + (_skip ? `，${_skip} 个没贴（已经贴满 ${MAX_TAGS_PER_ITEM} 个了）` : ''),
    _skip ? 'warn' : 'ok', _skip ? 5200 : 3600);
  }

  try {
    const savedSize = Number(localStorage.getItem('bilifav.pageSize') || 0);
    if (savedSize) S.sort.pageSize = savedSize;
  } catch (_) {}
  updatePageUI();

  // 页目录（页管理）里那组「每页多少个」
  $('#page-size-opts').addEventListener('click', async (e) => {
    const el = e.target.closest && e.target.closest('[data-size]');
    if (!el) return;
    // 「自定义」不是直接设值，先把输入框亮出来
    if (el.dataset.size === 'custom') {
      const boxEl = $('#page-size-custom-box');
      if (boxEl) {
        boxEl.classList.toggle('hidden');
        const inp = $('#page-size-input');
        if (inp && !boxEl.classList.contains('hidden')) inp.focus();
      }
      return;
    }
    const n = Number(el.dataset.size);
    if (!await setPageSize(n)) return;
    const label = n === 0 ? '平铺了，全部摊出来'
      : `一页放 ${n} 个${n === 20 ? '（5×4）' : n === 30 ? '（6×5）' : n === 50 ? '（10×5）' : ''}`;
    toast(label, 'ok');
  });
  $('#page-size-apply').addEventListener('click', async () => {
    const inp = $('#page-size-input');
    const n = Math.max(1, Math.min(999, Number(inp && inp.value) || 40));
    if (inp) inp.value = String(n);
    if (!await setPageSize(n)) return;
    toast(`一页放 ${n} 个（自定义）`, 'ok');
  });
  $('#sort-boxes').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleBoxPanel();
  });
  // 底栏那组横向翻页
  $('#pager-prev').addEventListener('click', () => setPage(S.sort.page - 1));
  $('#pager-next').addEventListener('click', () => setPage(S.sort.page + 1));
  $('#boxpanel-close').addEventListener('click', () => toggleBoxPanel(false));
  $('#boxpanel-prev').addEventListener('click', () => setPage(S.sort.page - 1));
  $('#boxpanel-next').addEventListener('click', () => setPage(S.sort.page + 1));
  $('#boxpanel-grid').addEventListener('click', (e) => {
    const lock = e.target.closest && e.target.closest('[data-lockpage]');
    if (lock) {
      e.stopPropagation();
      togglePageLock(Number(lock.dataset.lockpage));
      return;
    }
    const cell = e.target.closest && e.target.closest('[data-boxpage]');
    if (cell) setPage(Number(cell.dataset.boxpage));
  });
  /*
    这里原来有一条"点面板外面就收起来"的监听 —— 删掉了。
  
    用户要求跟收藏夹栏一个规矩：**只在主动关的时候关**
    （点面板右上角那个 ×，或者再按一次「页目录」按钮）。
    自动关很烦：想边看页目录边拖卡片、或者顺手点旁边的卡片看详情，
    面板就自己没了，每次都得重新点开。
  */

  /* ==================================================== 整理草稿（防丢） */
  /*
    搬运任务有断点续传，整理页以前没有 —— 拖了半小时顺序，误关窗口就全没了。
    现在只要有改动就防抖存一份到本机（data/drafts/），下次打开这个收藏夹时
    能对得上就悄悄接回来；提交成功之后自动清掉。
  */
  let draftTimer = null;
  let draftSaveQueue = Promise.resolve();
  let draftVersion = 0;
  let draftSignature = '';
  let draftSavedSignature = '';
  function currentDraftSignature() {
    return JSON.stringify([currentFolderId(), localHistoryRevision, S.sort.order, [...S.sort.deleted],
      S.sort.extra.map(it => it.key), [...S.sort.locked], S.sort.pageSize, S.tags,
      [...S.itemTags].map(([k,v]) => [k,[...v]])]);
  }

  function setDraftState(text, failed = false) {
    const el = $('#sort-save-state');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('failed', failed);
  }

  function encodeLocalHistory() {
    return BiliFavDraftCodec.encode(S.sort.stack, S.sort.redo, localSnapshot());
  }

  let draftWorker = null, draftWorkerSerial = 0, draftWorkerFailed = false;
  const draftWorkerJobs = new Map();
  const draftSnapshotIds = new WeakMap();
  let draftSnapshotSerial = 0, draftWorkerKnown = new Set();
  function serializeDraftJob(job) {
    if (draftWorkerFailed || typeof Worker === 'undefined') return Promise.resolve().then(() => BiliFavDraftCodec.serialize(job));
    return new Promise((resolve, reject) => {
      if (!draftWorker) {
        try { draftWorker = new Worker(new URL('draft-worker.js', APP_ASSET_URL)); }
        catch (error) { draftWorkerFailed = true; reject(error); return; }
        draftWorker.onmessage = ({data}) => {
          const pending = draftWorkerJobs.get(data.id);
          if (!pending) return;
          draftWorkerJobs.delete(data.id); clearTimeout(pending.timer);
          if (data.ok) { draftWorkerKnown = new Set(data.keepIds); pending.resolve(data.body); }
          else { draftWorkerKnown.clear(); pending.reject(new Error(data.error)); }
        };
        draftWorker.onerror = () => {
          draftWorkerFailed = true; draftWorker.terminate(); draftWorker = null;
          for (const pending of draftWorkerJobs.values()) { clearTimeout(pending.timer); pending.reject(new Error('草稿后台处理不可用')); }
          draftWorkerJobs.clear();
        };
      }
      const id = ++draftWorkerSerial;
      const fresh = [], sent = new Set();
      const snapshotId = snapshot => {
        if (!draftSnapshotIds.has(snapshot)) draftSnapshotIds.set(snapshot, ++draftSnapshotSerial);
        const key = draftSnapshotIds.get(snapshot);
        if (!draftWorkerKnown.has(key) && !sent.has(key)) { fresh.push([key,snapshot]); sent.add(key); }
        return key;
      };
      const {undo,redo,...current} = job;
      const message = {...current, fresh, undoIds:undo.map(snapshotId), redoIds:redo.map(snapshotId)};
      const timer = setTimeout(() => {
        draftWorkerJobs.delete(id); draftWorkerFailed = true;
        draftWorker?.terminate(); draftWorker = null; reject(new Error('草稿后台处理超时'));
      }, 5000);
      draftWorkerJobs.set(id, {resolve,reject,timer});
      // 首次恢复 60 步历史时分小段交给后台，避免一次结构化复制卡住界面。
      const send = async () => {
        if (fresh.length > 4 && !document.hidden) {
          for (let i = 0; i < fresh.length; i += 2) {
            if (!draftWorkerJobs.has(id)) return;
            if (document.hidden) { draftWorker.postMessage({type:'snapshots',fresh:fresh.slice(i)}); break; }
            draftWorker.postMessage({type:'snapshots',fresh:fresh.slice(i,i+2)});
            await new Promise(resolve => setTimeout(resolve,0));
          }
          message.fresh = [];
        }
        if (draftWorkerJobs.has(id)) draftWorker.postMessage({id,job:message});
      };
      send().catch(error => { clearTimeout(timer); draftWorkerJobs.delete(id); reject(error); });
    }).catch(() => BiliFavDraftCodec.serialize(job));
  }

  function decodeLocalHistory(history) {
    if (!history || history.version !== 1 || !Array.isArray(history.pool)) return;
    const fields = ['order','deleted','extra','locked','pageSize','page','tags','itemTags','picked','anchor','lastBoxSize'];
    const unpack = rows => (Array.isArray(rows) ? rows : []).slice(-60).map(row => {
      if (!Array.isArray(row) || row.length !== fields.length) throw new Error('invalid history');
      const snap = Object.fromEntries(fields.map((key,i) => [key,history.pool[row[i]]]));
      if (!['order','deleted','extra','locked','tags','itemTags','picked'].every(k => Array.isArray(snap[k]))
        || !Number.isInteger(snap.pageSize) || snap.pageSize < 0 || snap.pageSize > 999
        || !Number.isInteger(snap.page) || snap.page < 1
        || !snap.itemTags.every(pair => Array.isArray(pair) && Array.isArray(pair[1]))) throw new Error('invalid history');
      const allowed = new Set([...S.sort.original, ...snap.extra.map(it => it.key)]), keys = new Set(snap.order);
      if (keys.size !== snap.order.length || snap.order.some(k => !allowed.has(k))
        || S.sort.original.some(k => !keys.has(k))
        || snap.tags.some(t => !t || typeof t.id !== 'string' || typeof t.name !== 'string')) throw new Error('invalid history');
      return snap;
    });
    try { const undo = unpack(history.undo), redo = unpack(history.redo); S.sort.stack = undo; S.sort.redo = redo; }
    catch (_) { S.sort.stack = []; S.sort.redo = []; }
  }

  function draftPayload() {
    return {...localSnapshot(), original: S.sort.original.slice(), history: encodeLocalHistory()};
  }

  /** 改一下存一下（防抖），别每拖一次就发请求 */
  function scheduleDraftSave() {
    if (!S.sort.folder || S.sort.loading || sortWriteBusy()) return;
    const signature = currentDraftSignature();
    if (signature === draftSignature) return;
    draftSignature = signature;
    if (draftTimer) clearTimeout(draftTimer);
    draftVersion += 1;
    setDraftState(sortTouched() ? '草稿待保存' : '正在更新草稿…');
    draftTimer = setTimeout(() => saveDraftNow(), 900);
  }

  async function saveDraftNow() {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = null;
    const folder = S.sort.folder;
    if (!folder) return true;
    const mediaId = folder.media_id;
    const version = ++draftVersion;
    if (S.sort.loading || sortWriteBusy()) return false;
    draftSignature = currentDraftSignature();
    const savedSignature = draftSignature;
    const touched = localDraftNeeded();
    // 在调用时冻结当前状态；排队 / 后台编码不能读取稍后切换的收藏夹。
    const job = touched ? {media_id: mediaId, title: folder.title || '', snapshot: localSnapshot(),
      original: S.sort.original.slice(), undo: S.sort.stack.slice(), redo: S.sort.redo.slice()} : null;
    setDraftState('正在保存草稿…');
    // 串行写入快照，防止较早的自动保存覆盖最后一次手动保存。
    const write = draftSaveQueue.then(async () => {
      const payload = touched ? await serializeDraftJob(job) : {media_id: mediaId};
      return api(touched ? '/api/draft/save' : '/api/draft/clear', payload);
    });
    draftSaveQueue = write.catch(() => {});
    try {
      await write;
      draftSavedSignature = savedSignature;
      if (version === draftVersion && S.sort.folder?.media_id === mediaId) setDraftState(touched ? '草稿已保存' : '与线上一致');
      return true;
    } catch (_) {
      if (version === draftVersion && S.sort.folder?.media_id === mediaId) {
        setDraftState('草稿保存失败', true);
        toast('草稿未能保存，请保留窗口并重新快捷保存，或点击「保存整理」重试', 'warn', 7000);
      }
      return false;
    }
  }

  async function clearDraft(mediaId) {
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    if (!mediaId) return;
    draftVersion += 1;
    await draftSaveQueue;
    try { await api('/api/draft/clear', { media_id: mediaId }); } catch (_) {}
  }

  /**
   * 接回上次没提交的草稿。
   *
   * 只在草稿里的条目和现在线上读到的**完全对得上**时才接 ——
   * 收藏夹要是被别人改过，宁可不用，也不能拿旧数据硬套。
   */
  async function restoreDraft(mediaId, isCurrent = () => Number(S.sort.folder?.media_id) === Number(mediaId)) {
    let payload = null;
    try {
      const data = await api(`/api/draft/load?media_id=${mediaId}`);
      payload = data.draft;
    } catch (_) { return false; }
    if (!isCurrent()) return false;
    const d = payload && payload.draft;
    if (!d || !Array.isArray(d.order)) return false;

    const nowKeys = new Set(S.sort.order);
    const hit = new Set(d.order.filter(k => nowKeys.has(k))).size;
    const extras = Array.isArray(d.extra) ? d.extra : [];
    const allowed = new Set([...nowKeys, ...extras.map(it => it.key)]);
    const baselineChanged = Array.isArray(d.original) && d.original.join('\0') !== S.sort.original.join('\0');
    if (baselineChanged || hit !== nowKeys.size || new Set(d.order).size !== d.order.length
      || d.order.some(k => !allowed.has(k))) {
      // 对不上：收藏夹多半被改过了，这份草稿作废
      await clearDraft(mediaId);
      return false;
    }

    S.sort.order = d.order.slice();
    S.sort.deleted = new Set(Array.isArray(d.deleted) ? d.deleted : []);
    S.sort.extra = Array.isArray(d.extra) ? d.extra.slice() : [];
    S.sort.locked = new Set(Array.isArray(d.locked) ? d.locked : []);
    if (Number.isInteger(d.pageSize) && d.pageSize >= 0 && d.pageSize <= 999) S.sort.pageSize = d.pageSize;
    S.sort.page = Math.max(1, Number(d.page) || 1);
    decodeLocalHistory(d.history);
    updatePageUI();
    toast(
      `接上了 ${payload.saved_at || '上次'} 那份没提交的改动（不想要就点「全部还原」）`,
      'ok', 8000
    );
    return true;
  }

  /* ======================================================== 视频详情 */
  /*
    左键单击卡片 → 右边滑出一张详情卡：封面、标题、UP 主、上传/收藏日期、
    站内标签（现拉一次，带缓存）和我的标签（点一下就能贴/撕）。
  */
  let detailKey = '';
  let detailReadTimer = null;
  const siteTagCache = new Map();
  const ownerCache = new Map();
  const siteTagRequests = new Map();
  const ownerRequests = new Map();

  // 同一资源尚未读完时共享 Promise，成功后走缓存；失败不长期缓存。
  function readDetailCached(cache, pending, key, request) {
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (pending.has(key)) return pending.get(key);
    const promise = Promise.resolve().then(request).then(value => {
      cache.set(key, value);
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }

  /** UP 头像：拿不到就先用大肥鱼顶着 */
  function renderOwner(box, owner) {
    if (!box) return;
    const face = owner && owner.face;
    box.innerHTML = face
      ? `<img src="${esc(httpsify(face))}" alt="" referrerpolicy="no-referrer">`
      : '';
    const nm = $('#dt-owner-name');
    if (nm && owner && owner.name) nm.textContent = owner.name;
  }

  async function loadOwner(it) {
    const box = $('#dt-owner-face');
    if (!box) return;
    const bvid = it.bvid || it.key;
    const key = it.key;
    if (it.upper_info?.face) { renderOwner(box, it.upper_info); return; }
    try {
      const owner = await readDetailCached(ownerCache, ownerRequests, bvid, async () => {
        const data = await api(`/api/video/info?bvid=${encodeURIComponent(bvid)}`);
        return data.owner || {};
      });
      if (detailKey === key && $('#dt-owner-face') === box) renderOwner(box, owner);
    } catch (_) { /* 头像拿不到就先空着，不影响别的 */ }
  }

  function fmtDay(ts) {
    const n = Number(ts);
    if (!n) return '—';
    const d = new Date(n * 1000);
    if (isNaN(d.getTime())) return '—';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function renderDetailMine(key) {
    const box = $('#dt-mine-tags');
    if (!box) return;
    if (!S.tags.length) {
      box.innerHTML = '<span class="hint">还没建过标签，在卡片上点右键就能新建</span>';
      return;
    }
    const mine = new Set(S.itemTags.get(key) || []);
    box.innerHTML = S.tags.map((t) => `<span class="tg mine${mine.has(t.id) ? ' on' : ''}" data-dt-tag="${esc(t.id)}">`
      + `<i style="background:${esc(t.color)}"></i>${esc(t.name)}</span>`).join('');
  }

  function renderSiteTags(box, tags) {
    box.innerHTML = tags && tags.length
      ? tags.map((t) => `<span class="tg">${esc(t)}</span>`).join('')
      : '<span class="hint">这个视频在站内没有标签</span>';
  }

  async function loadSiteTags(it) {
    const box = $('#dt-site-tags');
    if (!box) return;
    const bvid = it.bvid || it.key;
    const key = it.key;
    try {
      const tags = await readDetailCached(siteTagCache, siteTagRequests, bvid, async () => {
        const data = await api(`/api/video/tags?bvid=${encodeURIComponent(bvid)}`);
        return data.tags || [];
      });
      if (detailKey === key && $('#dt-site-tags') === box) renderSiteTags(box, tags);
    } catch (err) {
      if (detailKey === key && $('#dt-site-tags') === box) box.innerHTML = `<span class="hint">${esc(err.message)}</span>`;
    }
  }

  function openDetail(key) {
    clearTimeout(detailReadTimer);
    const it = itemMap().get(key);
    if (!it) return;
    // 详情和收藏夹列表共用左侧位置，打开一块时收起另一块。
    if (FAV.open) toggleFavDrawer(false);
    detailKey = key;
    $('#detail-body').innerHTML = `
      <div class="dt-cover">${it.cover ? `<img src="${esc(httpsify(it.cover))}" alt="" referrerpolicy="no-referrer">` : ''}</div>
      <div class="dt-title">${esc(it.title || '(无标题)')}</div>
      <dl class="dt-meta">
        <dt>UP 主</dt>
        <dd class="dt-owner">
          <span class="dt-face" id="dt-owner-face"></span>
          <b id="dt-owner-name">${esc(it.upper || '未知')}</b>
        </dd>
        <dt>上传日期</dt><dd>${fmtDay(it.pubtime)}</dd>
        <dt>收藏日期</dt><dd>${fmtDay(it.fav_time)}</dd>
        <dt>时长</dt><dd>${fmtDuration(it.duration)}</dd>
        <dt title="按完整清单顺序计算，包含本条，不含待删除和失效视频">累计至此</dt><dd id="dt-cumulative" data-key="${esc(key)}"></dd>
        <dt>播放量</dt><dd>${fmtNum(it.play)}</dd>
        <dt>弹幕量</dt><dd>${fmtNum(it.danmaku)}</dd>
      </dl>
      <div class="dt-sec">
        <b>站内标签</b>
        <div class="dt-tags" id="dt-site-tags"><span class="hint">读取中…</span></div>
      </div>
      <div class="dt-sec">
        <b>我的标签<span class="dt-tip">点一下贴 / 撕</span></b>
        <div class="dt-tags" id="dt-mine-tags"></div>
        <button class="dt-newtag" id="dt-new-tag">＋ 新建标签并贴上</button>
      </div>
      <div class="dt-foot">
        <button class="btn-skew" id="dt-open-bili"><span>去 B 站看</span></button>
      </div>`;
    $('#detail').classList.remove('drag-switch');
    $('#detail').classList.add('show');
    document.body.classList.add('detail-open');
    clearTimeout(detailReflowTimer);
    clearTimeout(drawerReflowTimer);
    const cols = getComputedStyle(sortGrid).gridTemplateColumns.split(' ').filter(Boolean).length;
    if (cols > 1) sortGrid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    detailReflowTimer = setTimeout(() => {
      flipCards(() => { sortGrid.style.gridTemplateColumns = ''; });
      applyGridCols();
    }, 230);
    updateDurationSummary();

    renderDetailMine(key);
    // 已缓存资料立即显示；尚未读取的资料只在当前卡片停留后追加请求。
    const bvid = it.bvid || it.key;
    if (siteTagCache.has(bvid)) renderSiteTags($('#dt-site-tags'), siteTagCache.get(bvid));
    if (it.upper_info?.face || ownerCache.has(bvid)) renderOwner($('#dt-owner-face'), it.upper_info?.face ? it.upper_info : ownerCache.get(bvid));
    detailReadTimer = setTimeout(() => {
      detailReadTimer = null;
      if (detailKey !== key || !$('#detail').classList.contains('show') || document.hidden) return;
      loadSiteTags(it); loadOwner(it);
    }, 250);
  }

  let detailReflowTimer = null;

  function closeDetail(options = {}) {
    clearTimeout(detailReadTimer); detailReadTimer = null;
    detailKey = '';
    const el = $('#detail');
    if (el) {
      el.classList.toggle('drag-switch', !!options.dragging);
      el.classList.remove('show');
    }
    const occupied = document.body.classList.contains('detail-open');
    document.body.classList.remove('detail-open');
    clearTimeout(detailReflowTimer);
    if (occupied && !options.dragging) {
      flipCards(() => { sortGrid.style.gridTemplateColumns = ''; });
      applyGridCols();
    }
  }

  // 详情里那个「复制」——只复制眼前这一个，不理多选
  $('#detail-copy').addEventListener('click', () => {
    if (detailKey) clipTakeOne(detailKey);
  });
  $('#detail-close').addEventListener('click', () => closeDetail());
  $('#detail-body').addEventListener('click', async (e) => {
    const tg = e.target.closest && e.target.closest('[data-dt-tag]');
    if (tg && detailKey) {
      toggleItemTag(detailKey, tg.dataset.dtTag);
      refreshCardTags(detailKey);
      renderSortTagTabs();
      renderDetailMine(detailKey);
      return;
    }
    if (e.target.closest && e.target.closest('#dt-new-tag') && detailKey) {
      const tag = await askNewTag();
      if (tag) {
        toggleItemTag(detailKey, tag.id);
        refreshCardTags(detailKey);
        renderSortTagTabs();
      }
      renderDetailMine(detailKey);
      return;
    }
    if (e.target.closest && e.target.closest('#dt-open-bili') && detailKey) {
      const it = itemMap().get(detailKey);
      openExternal(biliUrlOf(it) || (it ? 'https://www.bilibili.com/video/' + (it.bvid || it.key) : ''));
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('#modal-mask').classList.contains('show')) return;   // 弹窗自己会关
    if (sortPageActive() && S.sort.multi) { setMulti(false); return; }
    if ($('#detail').classList.contains('show')) closeDetail();
  });

  // 左键单击卡片 → 开详情（拖拽刚结束那一小会儿不算点击）
  let lastDragEndAt = 0;
  sortGrid.addEventListener('click', (e) => {
    if (e.target.closest && (e.target.closest('[data-cact]') || e.target.closest('.tagbar'))) return;
    const card = e.target.closest && e.target.closest('.card');
    if (!card || !card.dataset.key) return;
    if (Date.now() - lastDragEndAt < 420) return;
    const key = card.dataset.key;

    // 多选模式：点一下选中它、顺手把详情打开；再点一下就是取消选择
    if (S.sort.multi) {
      if (e.shiftKey && S.sort.anchor && S.sort.anchor !== key) {
        // Shift：从上次点的那张连选到这一张；按住 Ctrl 再 Shift 就是取消这一段
        pickRange(S.sort.anchor, key, e.ctrlKey || e.metaKey);
      } else {
        // 普通点击 / Ctrl 点击：加一个或减一个
        togglePick(key);
        S.sort.anchor = key;
      }
      if (S.sort.picked.has(key)) openDetail(key);
      else if (detailKey === key) closeDetail();
      return;
    }
    // 再点同一张就收回去
    if (detailKey && detailKey === key) { closeDetail(); return; }
    openDetail(key);
  });

  /* ======================================================== 标签 */
  /*
    自建标签：名字最多 5 个字，颜色自己挑。标签只存在本机，是给"我"归类用的，
    不会同步到 B 站（B 站收藏夹没有这个概念）。
      · 卡片上点右键 → 勾选标签
      · 打过标签的卡片，右边挂一条竖线，颜色就是标签色，名字竖着排在线上
      · 顶上的标签页用来快速筛：可以同时选好几个，取并集（有其中任意一个就显示）
  */
  /*
    下面这两个是**老版本的全局键**，现在只用来做一次迁移。

    标签改成按收藏夹分开存之后，读写都走 tagStoreKey() / itemTagStoreKey()
    （键里带收藏夹 ID）。这两个老键留着，是为了让升级上来的用户不丢标签：
    第一次打开某个收藏夹时，如果它名下还没标签、而老键里有东西，
    就整份继承过去。
  */
  const LEGACY_TAG_KEY = 'bilifav.tags';
  const LEGACY_ITEMTAG_KEY = 'bilifav.itemTags';
  const TAG_COLORS = ['#566CAE', '#FB7299', '#4CAF7D', '#E8A33D', '#C94A3E', '#7B61C9', '#2FA8B8', '#8A8F98'];
  const ctxMenu = $('#ctx-menu');
  let tagColorPick = TAG_COLORS[0];

  /*
    标签是**按收藏夹分开存**的。

    键里带收藏夹 ID，所以 A 收藏夹的「教程」和 B 收藏夹的「教程」
    是两个互不相干的东西；同一个视频同时躺在两个收藏夹里，
    也不会因为在一头打了标、另一头就跟着冒出来。

    收藏夹还没选定的时候（比如刚启动）读不到东西，直接清空，
    等打开收藏夹时会再调一次。
  */
  function tagStoreKey(mediaId) {
    return `bilifav.tags.${mediaId}`;
  }
  function itemTagStoreKey(mediaId) {
    return `bilifav.itemTags.${mediaId}`;
  }
  /** 当前收藏夹的 ID；还没打开收藏夹时返回 0 */
  function currentFolderId() {
    return (S.sort.folder && S.sort.folder.media_id) || 0;
  }

  function loadTags() {
    const mid = currentFolderId();
    // 收藏夹还没打开（比如刚启动）—— 没地方挂标签，先清空，
    // 打开收藏夹时会再调一次
    if (!mid) { S.tags = []; S.itemTags = new Map(); return; }

    const tKey = tagStoreKey(mid);
    const iKey = itemTagStoreKey(mid);
    try {
      // 这个收藏夹名下还没有标签，而老版本留了一份全局的 —— 继承过来。
      // 只做一次：写完带 ID 的那份之后，老键就不再看第二眼了。
      const hasOwn = localStorage.getItem(tKey) !== null
        || localStorage.getItem(iKey) !== null;
      const legacyTags = localStorage.getItem(LEGACY_TAG_KEY);
      const legacyItems = localStorage.getItem(LEGACY_ITEMTAG_KEY);
      if (!hasOwn && (legacyTags || legacyItems)) {
        if (legacyTags) localStorage.setItem(tKey, legacyTags);
        if (legacyItems) localStorage.setItem(iKey, legacyItems);
      }

      const t = JSON.parse(localStorage.getItem(tKey) || '[]');
      S.tags = Array.isArray(t) ? t.filter((x) => x && x.id && x.name).map((x) => ({
        id: String(x.id), name: String(x.name).slice(0, 5), color: String(x.color || TAG_COLORS[0]),
        pin: !!x.pin,
      })) : [];
      const m = JSON.parse(localStorage.getItem(iKey) || '{}');
      S.itemTags = new Map();
      Object.keys(m || {}).forEach((k) => {
        if (Array.isArray(m[k]) && m[k].length) S.itemTags.set(k, new Set(m[k].map(String)));
      });
    } catch (_) {
      S.tags = [];
      S.itemTags = new Map();
    }
  }

  function saveTags() {
    const o = {};
    S.itemTags.forEach((set, k) => { if (set.size) o[k] = Array.from(set); });
    const mid = currentFolderId();
    if (!mid) return;                     // 没打开收藏夹，没什么可存的
    const a = lsSave(tagStoreKey(mid), JSON.stringify(S.tags), '标签');
    const b = lsSave(itemTagStoreKey(mid), JSON.stringify(o), '视频上的标签');
    scheduleDraftSave();
    $('#sort-undo').disabled = !S.sort.stack.length;
    $('#sort-redo').disabled = !S.sort.redo.length;
    return a && b;
  }

  const tagById = (id) => S.tags.find((t) => t.id === id);

  function createTag(name, color) {
    const clean = String(name || '').trim().slice(0, 5);
    if (!clean) return null;
    if (S.tags.some((t) => t.name === clean)) { toast('已经有个同名标签了', 'warn'); return null; }
    const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    if (!pushHistory()) return;
    S.tags.push({ id, name: clean, color: color || TAG_COLORS[0], pin: false });
    saveTags();
    return id;
  }

  function removeTag(id) {
    if (!tagById(id)) return;
    if (!pushHistory()) return;
    S.tags = S.tags.filter((t) => t.id !== id);
    S.itemTags.forEach((set, k) => {
      set.delete(id);
      if (!set.size) S.itemTags.delete(k);
    });
    S.tagFilter.delete(id);
    saveTags();
  }

  /*
    一个视频最多贴几个标签。

    为什么要有个上限：卡片封面右边那一条竖线是标签色带，贴多了会盖住封面；
    而且标签本来就该是"粗分类"，贴到七八个就等于没分类。
  */
  const MAX_TAGS_PER_ITEM = 5;

  function toggleItemTag(key, tagId) {
    const old = S.itemTags.get(key);
    if (old && !old.has(tagId) && old.size >= MAX_TAGS_PER_ITEM) {
      toast(`一个视频最多贴 ${MAX_TAGS_PER_ITEM} 个标签`, 'warn'); return;
    }
    if (!pushHistory()) return;
    let set = S.itemTags.get(key);
    if (!set) { set = new Set(); S.itemTags.set(key, set); }
    if (set.has(tagId)) {
      set.delete(tagId);
    } else {
      if (set.size >= MAX_TAGS_PER_ITEM) {
        toast(`一个视频最多贴 ${MAX_TAGS_PER_ITEM} 个标签 —— 想换就得先取消一个`, 'warn', 3800);
        if (!set.size) S.itemTags.delete(key);
        return;
      }
      set.add(tagId);
    }
    if (!set.size) S.itemTags.delete(key);
    saveTags();
  }

  function tagBarHtml(key) {
    const set = S.itemTags.get(key);
    if (!set || !set.size) return '';
    const inner = Array.from(set).map((id) => {
      const t = tagById(id);
      return t ? `<i style="background:${t.color}">${esc(t.name)}</i>` : '';
    }).join('');
    return inner ? `<div class="tagbar">${inner}</div>` : '';
  }

  /** 只刷一张卡的竖线，不重建整个网格（竖线挂在封面里，所以插到 .thumb 里） */
  function refreshCardTags(key) {
    const el = cardElOf.get(key);
    if (!el) return;
    const old = el.querySelector('.tagbar');
    if (old) old.remove();
    const html = tagBarHtml(key);
    if (html) {
      const thumb = el.querySelector('.thumb');
      if (thumb) thumb.insertAdjacentHTML('beforeend', html);
      el.classList.add('has-tags');
    } else {
      el.classList.remove('has-tags');
    }
  }

  /**
   * 只加不删：批量贴标签用。
   *
   * 返回 true 表示真加上了 —— 已经贴过的、或者已经到上限的，返回 false，
   * 调用方拿这个统计"有几个被跳过了"，好给用户一个准确的数。
   */
  function addItemTag(key, tagId, record = true) {
    let set = S.itemTags.get(key);
    if (!set) { set = new Set(); S.itemTags.set(key, set); }
    if (set.has(tagId)) return false;                       // 本来就有
    if (set.size >= MAX_TAGS_PER_ITEM) return false;         // 到上限了
    if (record && !pushHistory()) return;
    set.add(tagId);
    if (record) saveTags();
    return true;
  }

  /* ======================================================== 多选 */
  /*
    多选模式下：左键点卡片 = 选中它 + 打开详情，再点一下取消。
    选中的集合是 key 的 Set，翻页、换筛选都不会把它清掉。
    选完在卡片上点右键，就能一次给这批视频贴标签、或者整批挪到某一页。
  */
  function pickedList() {
    // 按当前顺序返回，批量挪动之后相对次序不会乱
    const out = S.sort.order.filter((k) => S.sort.picked.has(k));
    const seen = new Set(out);
    S.sort.picked.forEach((k) => { if (!seen.has(k)) { out.push(k); seen.add(k); } });
    return out;
  }

  function pickedLinks() {
    const map = itemMap();
    return pickedList().map((k) => biliUrlOf(map.get(k))).filter(Boolean);
  }

  function updatePickedUI() {
    updateDurationSummary();
    const n = S.sort.picked.size;
    const num = $('#sort-picked-n');
    if (num) num.textContent = n;
    const show = S.sort.multi && n > 0;
    const tip = $('#sort-picked');
    if (tip) tip.classList.toggle('hidden', !show);
    const clr = $('#sort-pick-clear');
    if (clr) clr.classList.toggle('hidden', !show);
    const all = $('#sort-select-all');
    if (all) all.classList.toggle('hidden', !S.sort.multi);
  }

  function paintPicked(key) {
    const el = cardElOf.get(key);
    if (el) el.classList.toggle('picked', S.sort.picked.has(key));
  }

  function togglePick(key) {
    if (S.sort.picked.has(key)) S.sort.picked.delete(key);
    else S.sort.picked.add(key);
    paintPicked(key);
    updatePickedUI();
  }

  /** 现在屏幕上真正显示出来的卡片（顺序就是 DOM 顺序） */
  function visibleSequence() {
    return sortVirtual ? sortVirtual.entries.map(e => e.key)
      : Array.from(sortGrid.querySelectorAll('.card[data-key]')).map(el => el.dataset.key);
  }

  /**
   * Shift 连选：把「锚点」到这一张之间的全部选上。
   * 按住 Ctrl 再 Shift 就是反过来 —— 把这一段取消掉。
   */
  function pickRange(fromKey, toKey, remove) {
    const keys = visibleSequence();
    const a = keys.indexOf(fromKey);
    const b = keys.indexOf(toKey);
    if (a < 0 || b < 0) return;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) {
      if (remove) S.sort.picked.delete(keys[i]);
      else S.sort.picked.add(keys[i]);
      paintPicked(keys[i]);
    }
    updatePickedUI();
    toast(
      `${remove ? '取消选择' : '选上'}了 ${hi - lo + 1} 个`,
      'info', 2000
    );
  }

  function clearPicked() {
    const keys = Array.from(S.sort.picked);
    S.sort.picked.clear();
    keys.forEach(paintPicked);
    updatePickedUI();
  }

  function setMulti(on) {
    const next = !!on;
    if (S.sort.multi === next) return;
    S.sort.multi = next;
    if (!next) S.sort.picked.clear();
    document.body.classList.toggle('sort-multi', next);
    const btn = $('#sort-multi');
    const txt = $('#sort-multi-text');
    if (btn) {
      btn.classList.toggle('on', next);
      btn.title = next
        ? '退出多选：退出后点卡片还是只开详情'
        : '多选：点卡片就选中，选完在卡片上点右键批量处理';
    }
    if (txt) txt.textContent = next ? '退出多选' : '多选';
    updatePickedUI();
    renderSortList();
    if (next) toast('多选开了：点卡片选中，选完在卡片上点右键', 'info', 4200);
  }

  /** 悄悄复位（换收藏夹时用，不弹提示、不重渲染） */
  function resetMulti() {
    S.sort.multi = false;
    S.sort.picked.clear();
    S.sort.anchor = '';
    document.body.classList.remove('sort-multi');
    const btn = $('#sort-multi');
    const txt = $('#sort-multi-text');
    if (btn) {
      btn.classList.remove('on');
      btn.title = '多选：点卡片就选中，选完在卡片上点右键批量处理';
    }
    if (txt) txt.textContent = '多选';
    updatePickedUI();
  }

  $('#sort-multi').addEventListener('click', () => setMulti(!S.sort.multi));
  $('#sort-pick-clear').addEventListener('click', () => {
    clearPicked();
    toast('都不选了', 'info');
  });
  $('#sort-select-all').addEventListener('click', () => {
    const keys = visibleSequence();
    if (!keys.length) { toast('这一页没东西可选', 'warn'); return; }
    const allOn = keys.every((k) => S.sort.picked.has(k));
    keys.forEach((k) => { if (allOn) S.sort.picked.delete(k); else S.sort.picked.add(k); paintPicked(k); });
    updatePickedUI();
    toast(allOn ? '这一页都取消选择了' : `这一页 ${keys.length} 个都选上了`, 'ok');
  });

  /* ---------------- 卡片右键菜单 ---------------- */
  let ctxKey = null;
  let ctxBatch = false;    // 这次右键弹的是"批量处理"还是"只处理这一条"

  function closeCtxMenu() {
    ctxMenu.classList.remove('show');
    ctxKey = null;
    ctxBatch = false;
  }

  /* ==========================================================================
     卡片剪贴板（Ctrl+C / Ctrl+X / Ctrl+V）
     ==========================================================================

     存的是**完整的卡片数据**，不只是 key —— 因为要跨收藏夹。粘贴到另一个
     收藏夹时那张卡片可能压根不在那边的列表里，光有 key 拼不出卡片来。

     cut 表示这份是"剪"下来的：在本收藏夹里粘贴时，剪过的卡片会直接从
     当前顺序里摘掉（等于移动）；粘贴到别的收藏夹就只是加过去，
     原收藏夹那份要等切回去才会看到变化 —— 所以那种情况会提示一句。
  */
  let clip = null;          // { items: [卡片数据], cut: bool, from: mediaId }
  let clipSeq = 0;          // 变一次加一，用来让右键菜单知道要不要刷新

  const CLIP_EMPTY_HINT = '剪贴板是空的 —— 先在卡片上按 Ctrl+C 或 Ctrl+X';

  /** 当前选中的那批 key；没多选就返回右键指到的那张 */
  function clipSourceKeys(fallbackKey) {
    if (fallbackKey && !(S.sort.multi && S.sort.picked.has(fallbackKey))) return [fallbackKey];
    const keys = pickedList();
    if (keys.length) return keys;
    return fallbackKey ? [fallbackKey] : [];
  }

  /**
   * 复制 / 剪切。cut=true 是剪切。
   *
   * 只把**当前收藏夹里真实存在**的卡片放进剪贴板 —— 多选可能跨页，
   * 理论上都在当前收藏夹里，但换个说法更稳妥。
   */
  /**
   * 单独复制一个视频（详情面板里那个）。
   *
   * 跟 clipTake 的区别是它不理会多选 —— 多选还开着的时候，
   * 用户点详情里的「复制」，要的是**眼前这一个**，不是选中的一整批。
   */
  function clipTakeOne(key) {
    const it = itemMap().get(key);
    if (!it) {
      toast('这个视频不在当前收藏夹里，复制不了', 'warn', 4000);
      return false;
    }
    clip = { items: [JSON.parse(JSON.stringify(it))], cut: false, from: currentFolderId() };
    clipSeq += 1;
    toast(`复制了「${(it.title || key).slice(0, 18)}」，切到别的收藏夹就能粘贴`, 'ok', 4200);
    return true;
  }

  function clipTake(cut, fallbackKey) {
    if (cut && !ensureLocalEdit()) return false;
    const keys = clipSourceKeys(fallbackKey);
    if (!keys.length) {
      toast('先选几张卡片（或者在多选模式下点一下）', 'warn', 3800);
      return false;
    }
    const map = itemMap();
    const items = keys.map((k) => map.get(k)).filter(Boolean);
    if (!items.length) {
      toast('这几张在当前收藏夹里找不到', 'warn', 3800);
      return false;
    }
    clip = { items: JSON.parse(JSON.stringify(items)), cut: !!cut, from: currentFolderId() };
    clipSeq += 1;

    if (cut) {
      // 剪切先标记待删；完整历史可撤销这一步。
      if (!pushHistory()) return;
      keys.forEach((k) => S.sort.deleted.add(k));
      renderSortList();
      updateSortStats();
      renderSortChips();
    }
    toast(cut
      ? `剪下了 ${items.length} 张（未提交，可撤销或取消删除标记）`
      : `复制了 ${items.length} 张，切到别的收藏夹就能粘贴`, cut ? 'ok' : 'info', 4200);
    return true;
  }

  /**
   * 粘贴。
   *
   * same=true（同一个收藏夹）：卡片本来就在列表里，"粘贴"只能是挪位置 ——
   * 不然会多出一张一模一样的卡片，提交上去 B 站那边也是重复收藏同一个视频。
   *
   * same=false（跨收藏夹）：把剪贴板里的卡片加进 extra，
   * 它们会排到列表最前面，等着提交。
   */
  function ensureLocalEdit() {
    if (!S.sort.folder || S.sort.loading || sortWriteBusy()) { toast('完整列表读取或任务结束后再整理', 'warn'); return false; }
    if (!S.sort.editing) setSortMode(true);
    return true;
  }

  function clipPaste(beforeKey, after = false) {
    if (!ensureLocalEdit()) return false;
    if (beforeKey && clip?.items.some(it => it.key === beforeKey) && clip.from === currentFolderId()) {
      toast('落点在要移动的视频中，请换一张目标卡片', 'warn'); return false;
    }
    const targetIndex = beforeKey ? S.sort.order.indexOf(beforeKey) : -1;
    if (targetIndex >= 0 && S.sort.pageSize && S.sort.locked.has(Math.floor(targetIndex / S.sort.pageSize) + 1)) {
      toast('目标页已锁定，请先在页目录解锁', 'warn'); return false;
    }
    if (!clip || !clip.items.length) {
      toast(CLIP_EMPTY_HINT, 'warn', 4200);
      return false;
    }
    const mid = currentFolderId();
    const same = clip.from === mid;

    if (same) {
      // 同夹：把这几张挪到"当前位置"
      const have = new Set(S.sort.order);
      const keys = clip.items
        .map((it) => String(it.key || ''))
        .filter((k) => k && have.has(k) && (clip.cut || !S.sort.deleted.has(k)));

      if (!keys.length) {
        toast('这几张已经被剪走或者删掉了，没得粘', 'warn', 4200);
        return false;
      }

      if (!pushHistory()) return;
      if (clip.cut) keys.forEach(k => S.sort.deleted.delete(k));
      const moving = new Set(keys);
      const order = S.sort.order.filter((k) => !moving.has(k));
      let at = order.length;
      if (beforeKey && order.includes(beforeKey)) at = order.indexOf(beforeKey) + (after ? 1 : 0);
      else {
        // 没指定落点就放到"当前页的开头"，跟拖到页目录那套保持一致
        const size = S.sort.pageSize || 0;
        if (size) at = Math.min(order.length, (S.sort.page - 1) * size);
      }
      order.splice(at, 0, ...keys);
      S.sort.order = order;

      // 粘贴完保持多选，方便接着调整位置
      keepPicked(keys);
      renderSortList();
      updateSortStats();
      renderBoxPanelIfOpen();
      toast(clip.cut
        ? `${keys.length} 张已经挪过来了`
        : `${keys.length} 张挪到这儿了（同一个收藏夹，复制＝换位置）`, 'ok', 4200);

      // 内部剪贴板保留，撤销后仍能再次粘贴；同夹始终移动、不复制出重复项。
      return true;
    }

    // ---- 跨收藏夹 ----
    const fresh = clip.items.map((it) => {
      const copy = JSON.parse(JSON.stringify(it));
      copy.key = String(copy.key || '') || ('clip' + Date.now().toString(36)
        + Math.random().toString(36).slice(2, 6));
      copy._fromClip = true;
      return copy;
    });

    // 已经在当前收藏夹里的就不重复加（按 key 判重）
    const have = new Set(S.sort.order);
    const add = fresh.filter((it) => !have.has(it.key));
    if (!add.length) {
      toast('这些卡片当前收藏夹里已经有了，没重复添加', 'info', 4200);
      return false;
    }

    if (!pushHistory()) return;
    const existing = new Set(S.sort.extra.map((it) => String(it.key || '')));
    add.forEach((it) => { if (!existing.has(it.key)) S.sort.extra.push(it); });
    const keys = add.map((it) => it.key);
    const order = S.sort.order.slice();
    let at = beforeKey ? order.indexOf(beforeKey) : -1;
    if (at >= 0) at += after ? 1 : 0;
    else at = S.sort.pageSize ? Math.min(order.length, (S.sort.page - 1) * S.sort.pageSize) : order.length;
    order.splice(at, 0, ...keys);
    S.sort.order = order;
    S.sort.page = S.sort.pageSize ? Math.floor(at / S.sort.pageSize) + 1 : 1;

    keepPicked(keys);
    renderSortList();
    updateSortStats();
    renderBoxPanelIfOpen();
    toast(`从「${clipFromName()}」粘过来 ${keys.length} 张，已放到指定位置`
      + (S.sort.editing ? '，检查完提交就好' : '（点「开始整理」才提交得了）'), 'ok', 5200);
    return true;
  }

  /** 剪贴板来源收藏夹的名字（找不到就报个占位） */
  function clipFromName() {
    const f = (S.folders || []).find((x) => x.media_id === (clip && clip.from));
    return (f && f.title) || '另一个收藏夹';
  }

  /** 打开页目录了就刷新它，没开就别惊动 */
  function renderBoxPanelIfOpen() {
    try {
      if ($('#boxpanel').classList.contains('show')) renderBoxPanel();
    } catch (_) { /* 页目录相关的东西没准备好就算了 */ }
  }

  /**
   * 粘贴完之后保持多选，并把这批卡片选上。
   *
   * 用户要的是"粘贴完还能接着调位置"，所以既要把多选打开，
   * 也要把它们设为选中 —— 否则一松手选中就没了。
   */
  function keepPicked(keys) {
    if (!keys.length) return;
    S.sort.multi = true;
    S.sort.picked = new Set(keys);
    S.sort.anchor = keys[0];
    document.body.classList.add('sort-multi');
    const btn = $('#sort-multi');
    const txt = $('#sort-multi-text');
    if (btn) { btn.classList.add('on'); btn.title = '多选开着：点卡片是选中，选完右键批量处理'; }
    if (txt) txt.textContent = `多选 ${keys.length}`;
    updatePickedUI();
  }

  function openCtxMenu(x, y, key) {
    // 多选开着、而且右键的这张正好在选中集合里 → 弹批量菜单
    const batch = S.sort.multi && S.sort.picked.size > 0 && S.sort.picked.has(key);
    ctxKey = key;
    ctxBatch = batch;
    ctxMenu.innerHTML = batch ? batchMenuHtml() : singleMenuHtml(key);
    ctxMenu.classList.add('show');
    const r = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    ctxMenu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  }

  function clipboardMenuHtml(n = 1) {
    return `<div class="cm-sub">本地整理 · 改动需提交</div>
      <div class="cm-item" data-clip-copy="1">复制${n > 1 ? `这 ${n} 张` : '条目'}（Ctrl+C）</div>
      <div class="cm-item" data-clip-cut="1">剪切${n > 1 ? `这 ${n} 张` : '条目'}（Ctrl+X）</div>
      <div class="cm-item${clip ? '' : ' muted'}" data-clip-paste="1">粘贴到此卡前${clip ? `（${clip.items.length} 张）` : ''}</div>
      <div class="cm-item${clip ? '' : ' muted'}" data-clip-paste-after="1">粘贴到此卡后</div>`;
  }
  function directMenuHtml() {
    return `<div class="cm-sep"></div><div class="cm-sub">直接写入 B 站 · 确认后立即生效</div>
      <div class="cm-item" data-quick-copy="1">直接复制到其他收藏夹…（末尾）</div>
      <div class="cm-item" data-quick-cut="1">直接移到其他收藏夹…（源夹移除）</div>`;
  }
  function singleMenuHtml(key) {
    const it = itemMap().get(key), mine = S.itemTags.get(key) || new Set();
    const rows = S.tags.map(t => `<div class="cm-item" data-tag-toggle="${t.id}">
      <i class="sw" style="background:${t.color}"></i>${esc(t.name)}${mine.has(t.id) ? '<span class="ck">✓</span>' : ''}</div>`).join('');
    return `<div class="cm-title">${esc(it?.title || key)}</div>
      <div class="cm-sub">本机标签 · 自动保存</div>${rows || '<div class="cm-item muted">还没建过标签</div>'}
      <div class="cm-item" data-tag-new="1">＋ 新建标签并贴上…</div>
      ${S.tags.length ? '<div class="cm-item muted" data-tag-manage="1">管理标签…</div>' : ''}
      ${mine.size ? '<div class="cm-item muted" data-tag-clear="1">清掉这个视频的标签</div>' : ''}
      <div class="cm-sep"></div>${clipboardMenuHtml()}${pagePickerHtml(key)}${directMenuHtml()}
      <div class="cm-sep"></div><div class="cm-sub">链接与打开</div>
      <div class="cm-item" data-copy-link="1">复制视频链接</div>
      <div class="cm-item" data-open-link="1">在浏览器里打开</div>`;
  }

  function batchMenuHtml() {
    const keys = pickedList(), n = keys.length;
    const rows = S.tags.map(t => {
      const have = keys.filter(k => S.itemTags.get(k)?.has(t.id)).length;
      return `<div class="cm-item${have === n ? ' on' : ''}" data-batch-tag="${t.id}">
        <i class="sw" style="background:${t.color}"></i>${esc(t.name)}
        ${have === n ? '<span class="ck">✓</span>' : have ? `<span class="cnt">${have}/${n}</span>` : ''}</div>`;
    }).join('');
    return `<div class="cm-title">已选 ${n} 个视频</div><div class="cm-sub">本机标签 · 给选中视频添加</div>
      ${rows || '<div class="cm-item muted">还没建过标签</div>'}
      <div class="cm-item" data-tag-new="1">＋ 新建标签并贴上…</div>
      <div class="cm-sep"></div>${clipboardMenuHtml(n)}
      ${pagePickerHtml(keys[0], '移动到指定页首（选中视频）', keys)}${directMenuHtml()}
      <div class="cm-sep"></div><div class="cm-sub">链接与选择</div>
      <div class="cm-item" data-copy-links="1">复制这 ${n} 条的链接</div>
      <div class="cm-item muted" data-batch-clear="1">取消选择</div>`;
  }

  /** 右键菜单底部那排「第 N 页」——只在切了「分页」时出现；锁着的页会标出来 */
  function pagePickerHtml(key, label, batchKeys) {
    const size = S.sort.pageSize || 0;
    if (!size) return '';
    const total = S.sort.order.length;
    const pages = Math.max(1, Math.ceil(total / size));
    if (pages < 2) return '';
    const idx = S.sort.order.indexOf(key);
    const cur = idx < 0 ? 0 : Math.floor(idx / size) + 1;
    // 批量挪的时候，目标页就是这批视频当前所在的那一页，标一下更直观
    const curBatch = new Set();
    if (batchKeys) batchKeys.forEach((k) => {
      const i = S.sort.order.indexOf(k);
      if (i >= 0) curBatch.add(Math.floor(i / size) + 1);
    });
    let cells = '';
    for (let p = 1; p <= pages; p++) {
      const locked = S.sort.locked.has(p);
      const on = batchKeys ? (curBatch.size === 1 && curBatch.has(p)) : p === cur;
      cells += `<button class="pg${on ? ' on' : ''}${locked ? ' locked' : ''}" data-sendpage="${p}"
        title="${locked ? `第 ${p} 页已锁定，点它会先问你要不要解锁` : `放到第 ${p} 页的第一格`}">`
        + `${locked ? '<svg class="lk" viewBox="0 0 24 24" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><use href="#i-lock"/></svg>' : ''}第 ${p} 页</button>`;
    }
    return `<div class="ctx-pages"><span class="lbl">${label || '发送到（会落在那一页的第一格）'}</span>${cells}</div>`;
  }

  ctxMenu.addEventListener('click', async (e) => {
    // 别让 document 上那个「点别处就关」的监听把菜单关掉（菜单里的元素会被重建）
    e.stopPropagation();
    const wasBatch = ctxBatch;
    const key = ctxKey;

    // ---- 挪到第 N 页（单条 / 整批）----
    const pg = e.target.closest && e.target.closest('[data-sendpage]');
    if (pg) {
      const page = Number(pg.dataset.sendpage);
      closeCtxMenu();
      if (wasBatch) await movePickedToPage(page);
      else if (key) await sendToPage(key, page);
      return;
    }

    const el = e.target.closest && e.target.closest('.cm-item');
    if (!el) return;

    /*
      剪贴板三项。
      **必须写在这个委托里**，不能写 document 上 —— 这个监听的第二行就是
      e.stopPropagation()，事件到不了 document，写那边等于没写
      （之前就是这么错的：点了没反应、菜单不关、也没提示）。
    */
    if (el.dataset.quickCopy !== undefined) {
      closeCtxMenu();
      askQuickToFolder(wasBatch ? pickedList() : (key ? [key] : []), false);
      return;
    }
    if (el.dataset.quickCut !== undefined) {
      closeCtxMenu();
      askQuickToFolder(wasBatch ? pickedList() : (key ? [key] : []), true);
      return;
    }
    if (el.dataset.clipCopy !== undefined) {
      closeCtxMenu();
      clipTake(false, key);
      return;
    }
    if (el.dataset.clipCut !== undefined) {
      closeCtxMenu();
      clipTake(true, key);
      return;
    }
    if (el.dataset.clipPaste !== undefined) {
      closeCtxMenu();
      clipPaste(key);// 指定前方

      return;
    }

    if (el.dataset.clipPasteAfter !== undefined) {
      closeCtxMenu(); clipPaste(key, true); return;
    }

    // ---- 批量：贴标签 / 复制链接 / 取消选择 ----
    if (el.dataset.batchTag) { tagAllPicked(el.dataset.batchTag); closeCtxMenu(); return; }
    if (el.dataset.batchClear) { clearPicked(); closeCtxMenu(); return; }
    if (el.dataset.copyLinks) {
      const urls = pickedLinks();
      copyText(urls.join('\n'), `${urls.length} 条链接`);
      closeCtxMenu();
      return;
    }

    // ---- 新建标签：单条和批量都从这儿进 ----
    if (el.dataset.tagNew) {
      closeCtxMenu();
      const tagId = await askNewTag();
      if (!tagId) return;
      const tag = tagById(tagId);
      if (wasBatch) {
        const keys = pickedList();
        // 有人已经贴到上限的会被跳过 —— 统计一下，提示才准
        let _ok = 0;
        if (keys.some(k => !(S.itemTags.get(k) || new Set()).has(tagId)
          && (S.itemTags.get(k)?.size || 0) < MAX_TAGS_PER_ITEM)) if (!pushHistory()) return;
        keys.forEach((k) => { if (addItemTag(k, tagId, false)) _ok += 1; });
        if (_ok) saveTags();
        const _skip = keys.length - _ok;
        renderSortList();
        renderSortTagTabs();
        toast(`给 ${_ok} 个视频一起贴上了「${tag ? tag.name : ''}」`
          + (_skip ? `，${_skip} 个没贴（已经贴满 ${MAX_TAGS_PER_ITEM} 个了）` : ''),
          _skip ? 'warn' : 'ok', _skip ? 5200 : 3600);
      } else if (key) {
        // 单个：到上限时 addItemTag 返回 false，得告诉她为什么没贴上
        if (!addItemTag(key, tagId)) {
          const _s = S.itemTags.get(key);
          if (_s && _s.size >= MAX_TAGS_PER_ITEM) {
            toast(`一个视频最多贴 ${MAX_TAGS_PER_ITEM} 个标签 —— 想换就得先取消一个`, 'warn', 3800);
            return;
          }
        }
        refreshCardTags(key);
        renderSortTagTabs();
      }
      return;
    }
    if (el.dataset.tagManage) { closeCtxMenu(); openTagManager(); return; }

    // ---- 单条：贴 / 撕、清掉、复制链接 ----
    if (!key) return;
    if (el.dataset.copyLink) {
      copyText(biliUrlOf(itemMap().get(key)), '链接');
      closeCtxMenu();
      return;
    }
    if (el.dataset.openLink) {
      const url = biliUrlOf(itemMap().get(key));
      // 跟详情里的「去 B 站看」走同一条路：交给系统默认浏览器打开
      openExternal(url);
      closeCtxMenu();
      return;
    }
    if (el.dataset.tagToggle) {
      toggleItemTag(key, el.dataset.tagToggle);
      refreshCardTags(key);
      renderSortTagTabs();
      openCtxMenu(parseFloat(ctxMenu.style.left) || 0, parseFloat(ctxMenu.style.top) || 0, key);
      return;
    }
    if (el.dataset.tagClear) {
      if (!pushHistory()) return;
      S.itemTags.delete(key);
      saveTags();
      refreshCardTags(key);
      renderSortTagTabs();
      closeCtxMenu();
    }
  });

  sortGrid.addEventListener('contextmenu', (e) => {
    const card = e.target.closest && e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    openCtxMenu(e.clientX, e.clientY, card.dataset.key);
  });
  document.addEventListener('click', (e) => {
    if (ctxMenu.classList.contains('show') && !ctxMenu.contains(e.target)) closeCtxMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });
  window.addEventListener('scroll', closeCtxMenu, true);

  /* ---------------- 标签管理 ---------------- */
  /**
   * 把一个标签复制到别的收藏夹。
   *
   * 只复制**标签本身**（名字 + 颜色），不带视频。
   * 因为"视频属于哪个标签"是跟着视频在不在那个收藏夹走的 ——
   * 目标夹里可能压根没有这些视频，硬搬过去只会留下一堆指不到东西的标记。
   *
   * 目标夹里已经有同名标签就跳过，免得来回点几次攒出一堆重复的。
   */
  function copyTagToFolder(tag, targetMediaId, targetName) {
    const tKey = tagStoreKey(targetMediaId);
    let list = [];
    try {
      const raw = JSON.parse(localStorage.getItem(tKey) || '[]');
      if (Array.isArray(raw)) list = raw;
    } catch (_) { list = []; }

    if (list.some((x) => x && String(x.name) === String(tag.name))) {
      toast(`「${targetName || '目标收藏夹'}」里已经有一个叫「${tag.name}」的标签了`, 'warn', 5000);
      return false;
    }

    list.push({
      id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: String(tag.name).slice(0, 5),
      color: tag.color,
      pin: false,
    });
    lsSave(tKey, JSON.stringify(list), '标签');
    return true;
  }

  /** 「复制到…」的选夹弹窗 */
  async function askCopyTagTo(tagId) {
    const tag = S.tags.find((t) => t.id === tagId);
    if (!tag) return;
    const cur = currentFolderId();
    const others = (S.folders || []).filter((f) => f.media_id !== cur);

    if (!others.length) {
      toast('你只有这一个收藏夹，没别的地方可复制', 'warn', 4200);
      return;
    }

    // .folder-item 是老样式（里面就 b + span 两个），照它的结构写，
    // 免得再为这个弹窗单独发明一套 CSS
    const rows = others.map((f) => `
      <button class="folder-item" data-copyto="${esc(String(f.media_id))}"
              data-copyto-name="${esc(f.title || '')}">
        <b>${esc(f.title || '未命名')}</b>
        <span>${esc(String(f.count || 0))} 条</span>
      </button>`).join('');

    await openModal({
      title: `把「${tag.name}」复制到…`,
      desc: '只复制标签本身（名字和颜色），不带视频 —— '
        + '视频挂没挂这个标签，是跟着它在哪个收藏夹走的。',
      body: `<div class="folder-grid" id="copy-tag-targets">${rows}</div>`,
      buttons: [{ id: 'modal-cancel', text: '算了', kind: 'plain', onClick: () => closeModal(false) }],
    });

    const box = $('#copy-tag-targets');
    if (box) {
      box.querySelectorAll('[data-copyto]').forEach((el) => el.addEventListener('click', () => {
        const mid = Number(el.dataset.copyto);
        const name = el.dataset.copytoName;
        if (copyTagToFolder(tag, mid, name)) {
          toast(`「${tag.name}」已经复制到「${name}」`, 'ok', 4200);
        }
        closeModal(false);
      }));
    }
  }

  /**
   * 标签色上该配白字还是深字。
   *
   * 亮色标签（黄、浅绿那种）配白字是看不清的，暗色标签配深字也一样。
   * 按亮度一刀切：亮就配深蓝、暗就配白。
   */
  function tagInk(color) {
    try {
      return relLum(color) > 0.5 ? '#202a48' : '#ffffff';
    } catch (_) {
      return '#ffffff';
    }
  }

  function tagListHtml() {
    if (!S.tags.length) return '<div class="hint">还没有标签，下面新建一个吧。</div>';
    const inList = new Set(S.sort.order);
    // 置顶的排最前面（sort 是稳定的，同组里保持原来的先后）
    const sorted = S.tags.slice().sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0));
    return sorted.map((t) => {
      let n = 0;
      S.itemTags.forEach((set, k) => { if (set.has(t.id) && inList.has(k)) n += 1; });
      return `<div class="tagrow${t.pin ? ' pinned' : ''}"
        style="--tag-color:${t.color};--tag-ink:${tagInk(t.color)}">
        <i class="sw" style="background:${t.color}"></i>
        <b>${esc(t.name)}</b>
        <span class="plain">${n} 个视频</span>
        <button class="tbtn pinbtn${t.pin ? ' on' : ''}" data-tagpin="${t.id}" title="${t.pin
          ? '取消优先显示：标签和颜色保留，按普通标签顺序显示'
          : '优先显示在「全部」右侧；标签颜色保持不变'}">${t.pin ? '已置顶' : '置顶'}</button>
        <button class="tbtn" data-tagcopy="${t.id}"
                title="把这个标签复制到别的收藏夹（只复制标签本身，不带视频）">复制到…</button>
        <button class="tbtn" data-tagdel="${t.id}">删掉</button>
      </div>`;
    }).join('');
  }

  async function openTagManager() {
    await openModal({
      title: '标签',
      help: 'tags',
      desc: '标签只存在本机，用来给你自己归类，<b>不会</b>同步到 B 站。<br>'
        + '名字最多 5 个字，<b>打完直接按回车就建好了，窗口不会关</b>，可以连着建几个。'
        + '所有标签都可筛选；<b>置顶</b>后优先排在「全部」右侧，颜色保持不变。',
      body: `
        <div class="taglist" id="tag-list">${tagListHtml()}</div>
        <div class="field" style="margin-top:14px">
          <label>新标签（最多五个字，回车即建）</label>
          <input type="text" id="tag-name" maxlength="5" placeholder="打完按回车，比如：教程">
        </div>
        <div class="tagcolors" id="tag-colors">
          ${TAG_COLORS.map((c, i) => `<i class="${i === 0 ? 'on' : ''}" data-color="${c}" style="background:${c}"></i>`).join('')}
          <input type="color" id="tag-color-pick" value="${TAG_COLORS[0]}" title="自己挑一个颜色">
        </div>
        <div class="sync-tip">
          「<b>一键同步站内标签</b>」是干什么的：它会把收藏夹里每个视频在 B 站上
          自带的那几个标签读一遍，如果某个和你的自建标签<b>重名</b>，
          就给这个视频贴上你的那个同名标签。<br>
          比如站内标签里有「教程」，你也建了「教程」，那所有带这个站内标签的视频
          就会匹配到本机「教程」标签。在浏览页点击这个标签即可筛选；
          <b>置顶</b>只调整显示优先级，不是使用筛选的前提。
        </div>`,
      buttons: [
        {
          id: 'modal-ok2', text: '一键同步站内标签', kind: 'plain',
          onClick: () => { closeModal(false); autoTagBySiteTags(); },
        },
        { id: 'modal-ok', text: '完成', kind: 'solid', onClick: () => closeModal(true) },
      ],
      onEnter: () => addTagFromManagerInput(),
    });
  }

  /**
   * 按站内标签自动打标签。
   *
   * 逐个读视频在 B 站上的标签，凡是名字和某个自定义标签**一模一样**的，
   * 就给这条视频贴上那个标签。只读不写，但条数多时得等一会儿，所以给进度和中断。
   */
  async function autoTagBySiteTags() {
    const order = S.sort.order.slice();
    if (!order.length) { toast('先打开一个收藏夹', 'warn'); return; }
    if (!S.tags.length) { toast('还没建过标签，先建几个吧', 'warn'); return; }

    const byName = new Map();
    S.tags.forEach((t) => byName.set(t.name, t.id));
    const map = itemMap();
    // 失效的直接跳过，省下没必要的请求
    const targets = order.filter((k) => {
      const it = map.get(k);
      return it && !it.invalid;
    });
    if (!targets.length) { toast('这个收藏夹里没有能读的视频', 'warn'); return; }

    const ok = await confirmBox(
      '一键同步站内标签？',
      `会逐个读这 <b>${targets.length}</b> 个视频在 B 站上的标签，`
      + `凡是名字和你某个标签<b>一样</b>的，就自动贴上。<br>`
      + `只读不写，但要连着发 ${targets.length} 次请求，得等一会儿（中途能停）。`,
      '开始'
    );
    if (!ok) return;

    let aborted = false;
    openModal({
      title: '正在对站内标签…',
      desc: '对得上的自动贴上，已经有的不动。',
      body: '<div class="hint" id="auto-tag-progress">准备中…</div>',
      okText: '停下来',
      showCancel: false,
    }).then(() => { aborted = true; });

    const syncFolder = currentFolderId();
    let recorded = false;
    let done = 0, hit = 0, failed = 0;
    const paint = () => {
      const el = $('#auto-tag-progress');
      if (el) {
        el.innerHTML = `已看 <b>${done}</b> / ${targets.length} 个 · 命中 <b>${hit}</b> 个`
          + (failed ? ` · 读不到 ${failed} 个` : '');
      }
    };
    paint();

    for (const k of targets) {
      if (aborted || syncFolder !== currentFolderId()) break;
      const it = map.get(k);
      const bvid = it.bvid || k;
      let tags = siteTagCache.get(bvid);
      if (!tags) {
        try {
          const data = await api(`/api/video/tags?bvid=${encodeURIComponent(bvid)}`);
          tags = data.tags || [];
          siteTagCache.set(bvid, tags);
        } catch (_) {
          failed += 1;
          done += 1;
          if (done % 4 === 0) paint();
          continue;
        }
      }
      if (aborted || syncFolder !== currentFolderId()) break;
      const matched = tags.filter((name) => byName.has(name));
      if (matched.length) {
        if (!recorded && matched.some(name => !(S.itemTags.get(k) || new Set()).has(byName.get(name))
          && (S.itemTags.get(k)?.size || 0) < MAX_TAGS_PER_ITEM)) { if (!pushHistory()) return; recorded = true; }
        matched.forEach((name) => addItemTag(k, byName.get(name), false));
        saveTags();
        hit += 1;
      }
      done += 1;
      if (done % 4 === 0 || done === targets.length) paint();
    }

    closeModal(false);
    renderSortList();
    renderSortTagTabs();
    toast(
      aborted
        ? `停下来了：看过 ${done} 个，给 ${hit} 个贴上了标签`
        : `看完了 ${targets.length} 个，给 ${hit} 个贴上了标签`,
      aborted ? 'warn' : 'ok', 6000
    );
  }

  async function askNewTag() {
    const name = await openModal({
      title: '新建标签',
      desc: '名字最多 5 个字，建好之后在卡片上点右键就能贴。<b>按回车也能直接建。</b>',
      body: `
        <div class="field"><label>名字</label>
          <input type="text" id="tag-name" maxlength="5" placeholder="比如：教程"></div>
        <div class="tagcolors" id="tag-colors">
          ${TAG_COLORS.map((c, i) => `<i class="${i === 0 ? 'on' : ''}" data-color="${c}" style="background:${c}"></i>`).join('')}
          <input type="color" id="tag-color-pick" value="${TAG_COLORS[0]}" title="自己挑一个颜色">
        </div>`,
      buttons: [
        { id: 'modal-cancel', text: '算了', kind: 'plain', onClick: () => closeModal(false) },
        { id: 'modal-ok', text: '建立标签', kind: 'solid', onClick: () => submitNewTag() },
      ],
      onEnter: () => submitNewTag(),
    });
    if (!name) return null;
    const id = createTag(name, tagColorPick);
    if (id) {
      toast(`标签「${name}」建好啦`, 'ok');
      renderSortTagTabs();
    }
    return id;
  }

  /** 新建标签窗里那个"建立标签"要做的事（按钮和回车共用） */
  function submitNewTag() {
    const v = (($('#tag-name') || {}).value || '').trim().slice(0, 5);
    if (!v) { toast('给它起个名字吧', 'warn'); return; }
    closeModal(v);
  }

  /** 标签管理窗里那个输入框：建完不关窗，可以接着建下一个 */
  function addTagFromManagerInput() {
    const inp = $('#tag-name');
    const name = ((inp && inp.value) || '').trim().slice(0, 5);
    if (!name) { toast('给它起个名字吧', 'warn'); return; }
    if (!createTag(name, tagColorPick)) return;
    inp.value = '';
    const list = $('#tag-list');
    if (list) list.innerHTML = tagListHtml();
    renderSortTagTabs();
    toast(`「${name}」建好了 —— 接着建下一个，或者点「完成」`, 'ok', 3000);
  }

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    // 顶栏的「教程」：打开当前板块的教程
    // 顶栏那个「浏览器」：用系统默认浏览器打开当前界面
    if (t.closest('#top-browser')) {
      if (window.BILIFAV_PREVIEW) { openPreviewLink(location.href); return; }
      api('/api/open-browser', { url: location.href })
        .then((d) => {
          if (d && d.ok) toast('已交给系统默认浏览器打开（与当前窗口同一份数据）', 'ok', 4200);
          else toast((d && d.error) || '没能打开浏览器', 'err', 5000);
        })
        .catch((err) => toast(err.message, 'err', 5000));
      return;
    }
    // 教程浮层上的按钮。浮层在 body 末尾，跟 ctxMenu 不一样，事件能冒泡上来
    if (t.closest('#tut-close')) { tutClose(true); return; }
    if (t.closest('#tut-skip')) {
      tutClose(true);
      return;
    }
    if (t.closest('#tut-prev')) { tutGo(-1); return; }
    if (t.closest('#tut-next')) { tutGo(1); return; }
    if (t.closest('#tut-mask')) { tutClose(true); return; }
    const del = t.closest('[data-tagdel]');
    if (del) {
      const tag = tagById(del.dataset.tagdel);
      removeTag(del.dataset.tagdel);
      const list = $('#tag-list');
      if (list) list.innerHTML = tagListHtml();
      renderSortTagTabs();
      renderSortList();
      toast(tag ? `标签「${tag.name}」删掉了` : '删掉了', 'info', 2400);
      return;
    }
    const copy = t.closest('[data-tagcopy]');
    if (copy) {
      askCopyTagTo(copy.dataset.tagcopy);
      return;
    }
    const pin = t.closest('[data-tagpin]');
    if (pin) {
      const tag = tagById(pin.dataset.tagpin);
      if (tag) {
        if (!pushHistory()) return;
        tag.pin = !tag.pin;
        saveTags();
        const list = $('#tag-list');
        if (list) list.innerHTML = tagListHtml();
        renderSortTagTabs();
        toast(tag.pin
          ? `「${tag.name}」钉到浏览页「全部」右边了`
          : `「${tag.name}」从顶上撤下来了`, 'ok');
      }
      return;
    }
    const sw = t.closest('#tag-colors i[data-color]');
    if (sw) {
      tagColorPick = sw.dataset.color;
      $$('#tag-colors i[data-color]').forEach((el) => el.classList.toggle('on', el === sw));
      const pick = $('#tag-color-pick');
      if (pick) pick.value = tagColorPick;
      return;
    }
    if (t.closest('#tag-manage')) {
      openTagManager();
    }
  });

  $('#sort-tag-manage').addEventListener('click', openTagManager);

  /* ---------------- 标签筛选（并集） ---------------- */
  /* 浏览页那一行最多摆 8 个标签：再多就会把右边的按钮挤没，
     所以用「置顶」来挑 —— 置顶的钉在「全部」右边，其余的补在后面。 */
  const MAX_TAG_TABS = 8;

  function renderSortTagTabs() {
    const box = $('#sort-tag-tabs');
    if (!box) return;
    const signature = [S.sort.order,S.sort.order.length,S.itemTags,S.itemTags.size,localHistoryRevision];
    let counts = renderSortTagTabs.counts;
    if (!sameDataSignature(renderSortTagTabs.signature,signature)) {
      const inList = new Set(S.sort.order); counts = new Map();
      S.itemTags.forEach((set,key) => { if (inList.has(key)) set.forEach(id => counts.set(id,(counts.get(id)||0)+1)); });
      renderSortTagTabs.counts = counts; renderSortTagTabs.signature = signature;
    }
    const pinned = S.tags.filter((t) => t.pin);
    const rest = S.tags.filter((t) => !t.pin);
    const shown = pinned.slice(0, MAX_TAG_TABS)
      .concat(rest.slice(0, Math.max(0, MAX_TAG_TABS - pinned.length)));
    let html = shown.map((t) => {
      const on = S.tagFilter.has(t.id);
      const n = counts.get(t.id) || 0;
      return `<div class="tab tag-tab${on ? ' on' : ''}${t.pin ? ' pinned' : ''}" data-tag="${t.id}"
        draggable="${t.pin ? 'true' : 'false'}"
        style="--tag-color:${t.color};--tag-ink:${tagInk(t.color)}"
        title="${t.pin ? '（置顶）按住可以拖动换位置 —— ' : ''}只看带「${esc(t.name)}」的视频">
        <span>${t.pin ? '<svg class="pin" viewBox="0 0 24 24" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><use href="#i-pin"/></svg>' : ''}<i class="dot"></i>${esc(t.name)}</span>
        ${n ? `<i class="cnt">${n}</i>` : ''}
      </div>`;
    }).join('');
    // 摆不下的在末尾提一句，点开就是标签管理
    if (S.tags.length > shown.length) {
      html += `<div class="tab tag-tab more" data-tagmore="1" title="标签太多摆不下了 —— 在标签管理里把常用的置顶，就会挪到「全部」右边">+${S.tags.length - shown.length}</div>`;
    }
    if (box._tagsHtml !== html || (html && !box.firstElementChild)) { box.innerHTML = html; box._tagsHtml = html; }
    const allTab = $('#sort-tabs .tab[data-tab="all"]');
    if (allTab) allTab.classList.toggle('on', !S.tagFilter.size);
  }

  /* -------- 置顶标签：按住拖一下就能换位置 -------- */
  /*
    跟卡片那边一个规矩：**得按住一会儿**才给拖。
    不然随手点一下（本意是筛选）会被当成拖拽，手感很糟。
  */
  let tagDragId = '';
  let tagPressAt = 0;

  /** 把某个置顶标签挪到另一个置顶标签的前 / 后 */
  function reorderPinnedTags(fromId, toId, before) {
    const pinned = S.tags.filter((t) => t.pin);
    const fi = pinned.findIndex((t) => t.id === fromId);
    if (fi < 0) return false;
    const [moved] = pinned.splice(fi, 1);
    let ti = pinned.findIndex((t) => t.id === toId);
    if (ti < 0) return false;
    if (!before) ti += 1;
    pinned.splice(ti, 0, moved);
    // 置顶的排前面，没置顶的保持原来的相对顺序
    if (!pushHistory()) return;
    S.tags = pinned.concat(S.tags.filter((t) => !t.pin));
    saveTags();
    renderSortTagTabs();
    return true;
  }

  const clearTagDropMarks = () => $$('#sort-tabs .tab').forEach((el) =>
    el.classList.remove('drop-before', 'drop-after', 'dragging'));

  $('#sort-tabs').addEventListener('mousedown', (e) => {
    const tab = e.target.closest && e.target.closest('.tab.tag-tab.pinned[data-tag]');
    if (!tab || e.button !== 0) { tagPressAt = 0; return; }
    tagPressAt = Date.now();
  }, true);

  $('#sort-tabs').addEventListener('dragstart', (e) => {
    const tab = e.target.closest && e.target.closest('.tab.tag-tab.pinned[data-tag]');
    if (!tab) { e.preventDefault(); return; }
    if (!tagPressAt || Date.now() - tagPressAt < LONG_PRESS_MS) { e.preventDefault(); return; }
    tagDragId = tab.dataset.tag;
    tab.classList.add('dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tagDragId);
    } catch (_) {}
  });

  $('#sort-tabs').addEventListener('dragover', (e) => {
    if (!tagDragId) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    clearTagDropMarks();
    const tab = e.target.closest && e.target.closest('.tab.tag-tab.pinned[data-tag]');
    if (!tab || tab.dataset.tag === tagDragId) return;
    const r = tab.getBoundingClientRect();
    tab.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
  });

  $('#sort-tabs').addEventListener('drop', (e) => {
    if (!tagDragId) return;
    e.preventDefault();
    const tab = e.target.closest && e.target.closest('.tab.tag-tab.pinned[data-tag]');
    const before = !!(tab && tab.classList.contains('drop-before'));
    const toId = tab ? tab.dataset.tag : '';
    const fromId = tagDragId;
    tagDragId = '';
    clearTagDropMarks();
    if (!toId || toId === fromId) return;
    if (reorderPinnedTags(fromId, toId, before)) toast('置顶标签换好位置了', 'ok', 2400);
  });

  $('#sort-tabs').addEventListener('dragend', () => {
    tagDragId = '';
    clearTagDropMarks();
  });

  $('#sort-tabs').addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-tagmore]')) { openTagManager(); return; }
    if (t.closest('.tab[data-tab="all"]')) {
      S.tagFilter.clear();
    } else {
      const tab = t.closest('.tab.tag-tab');
      if (!tab || !tab.dataset.tag) return;
      const id = tab.dataset.tag;
      // 多选取并集：再点一下取消，全部取消就等于「全部」
      if (S.tagFilter.has(id)) S.tagFilter.delete(id);
      else S.tagFilter.add(id);
    }
    renderSortTagTabs();
    renderSortList();
  });

  /* ======================================================== 任务浮层 */
  /* 任务不是要逛的页面，是随时瞄一眼的状态，所以整体收进右上角这个浮层里 */
  const taskPop = $('#taskpop');
  const topTaskBtn = $('#top-task');

  function toggleTaskPop(show) {
    const on = show === undefined ? !taskPop.classList.contains('show') : !!show;
    taskPop.classList.toggle('show', on);
    topTaskBtn.classList.toggle('on', on);
    if (on) { taskRenderKey = ''; renderTaskViews(lastTaskData); pollTask(); setTimeout(scrollLogToEnd, 30); }
  }

  topTaskBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTaskPop();
  });
  // 「当前任务」里的那个「查看详情」，点了也是开这个浮层
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-taskpop]');
    if (!el) return;
    e.stopImmediatePropagation();
    toggleTaskPop(true);
  }, true);
  $('#taskpop-close').addEventListener('click', () => toggleTaskPop(false));
  taskPop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', (e) => {
    if (tutState || e.target.closest('#tut-card, #tut-mask')) return;
    toggleTaskPop(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !taskPop.classList.contains('show')) return;
    if ($('#modal-mask').classList.contains('show')) return;   // 弹窗开着就先让它关
    toggleTaskPop(false);
  });

  /** 暂停 / 继续 / 停止 */
  async function taskControl(action) {
    if (action === 'toggle') action = S.task.state === 'paused' ? 'resume' : 'pause';
    try {
      const r = await api('/api/task/control', { action });
      toast(r.message, action === 'stop' ? 'warn' : 'ok');
      pollTask();
    } catch (err) { toast(err.message, 'err'); }
  }

  async function taskStopAsk() {
    const ok = await confirmBox('确定要停下吗？', '已经完成的部分会保留，进度也存着，下次可以接着跑。', '停下来');
    if (!ok) return;
    taskControl('stop');
  }

  /* ======================================================== 顶栏与总览统计 */
  function renderTopStats() {
    const folders = S.folders || [];
    let total = 0;
    folders.forEach((f) => { total += Number(f.count) || 0; });
    $('#top-folders').textContent = folders.length;
    $('#top-items').textContent = fmtNum(total);
    $('#dash-stat-folders').textContent = folders.length;
    $('#dash-stat-items').textContent = fmtNum(total);
  }

  /* ======================================================== 外观浮层 */
  /* 菜单页头像右边那个小按钮弹出来的，原来是个大面板，收起来省地方 */
  const appearPop = $('#appear-pop');
  const appearMask = $('#appear-mask');

  function toggleAppear(show) {
    const on = show === undefined ? !appearPop.classList.contains('show') : !!show;
    appearPop.classList.toggle('show', on);
    appearMask.classList.toggle('show', on);
  }

  $('#appear-btn').addEventListener('click', (e) => {
    e.stopPropagation();   // 别把账号行那个「点一下去登录」也带出来
    toggleAppear(true);
  });
  $('#appear-close').addEventListener('click', () => toggleAppear(false));
  appearMask.addEventListener('click', () => toggleAppear(false));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !appearPop.classList.contains('show')) return;
    if ($('#modal-mask').classList.contains('show')) return;   // 弹窗开着先让它关
    toggleAppear(false);
  });

  /* ======================================================== 菜单页 */
  $('#menu-open-datadir').addEventListener('click', async () => {
    try {
      const h = await api('/api/health');
      toast('数据目录：' + (h.data_dir || h.state_dir), 'info', 8000);
    } catch (_) {}
  });
  $('#menu-view-log').addEventListener('click', async () => {
    try {
      const h = await api('/api/health');
      toast('运行日志在 ' + (h.data_dir || h.state_dir) + ' 的 logs 里（保留最近 7 天）', 'info', 8000);
    } catch (_) {}
  });
  $('#menu-clear-tasks').addEventListener('click', async () => {
    const ok = await confirmBox(
      '要清掉任务存档吗？',
      '清掉之后「记录」页就空了，已经搬进收藏夹的东西不受影响。<br>存档文件在数据目录里，也可以自己手动删。',
      '清掉'
    );
    if (!ok) return;
    toast('存档得手动删：打开「数据目录」里的 tasks 文件夹就行', 'info', 8000);
  });

  /* ==========================================================================
     主题引擎（四锚点）
     --------------------------------------------------------------------------
       主色   → 顶栏 / 底栏 / 标题条，以及所有边框描边（占大部分）
       次要色 → 卡片封面这类深色小块（占小部分）
       字体色 → 色块上的文字，独立控制，不再跟着底色自动翻
       底色   → 内容区背景

     只把「介于主色和底色之间的过渡调」交给主色去推，
     那是同一块颜色的深浅变化，独立指定反而难协调。
     ========================================================================== */
  (function () {
    /* 次要色 = 主要色的浅色版（同色系、明度更高），用在选中态上。
       比主色浅，所以选中项是"亮起来"而不是"沉下去"。 */
    // Cache a small in-memory subject mask once per image; recolor only on theme changes.
    // Keep the source PNG as the fallback and hit target (including its protruding area).
    var navBadgeTheme = window.BiliIconTheme.create(document.querySelectorAll('.navitem .nav-badge, #sort-mode [data-tint-family]'));

    var PRESETS = {
      /* 鲸鱼蓝：主色取自本鱼的参考色 #566CAE，浅色那档对应高光 #8FAEDA */
      blue: { main: '#566CAE', minor: '#8FAEDA', text: '#FFFFFF', paper: '#EDF0F9' },
      pink: { main: '#FB7299', minor: '#FF9CBE', text: '#FFFFFF', paper: '#FDF1F5' },
    };
    var KEY = 'bilifav.theme';

    function hexToHsl(hex) {
      hex = String(hex).replace('#', '');
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      var r = parseInt(hex.slice(0, 2), 16) / 255;
      var g = parseInt(hex.slice(2, 4), 16) / 255;
      var b = parseInt(hex.slice(4, 6), 16) / 255;
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      var l = (mx + mn) / 2, h = 0, s = 0;
      if (mx !== mn) {
        var d = mx - mn;
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
      }
      return { h: h, s: s, l: l };
    }

    function hslToHex(h, s, l) {
      h = ((h % 360) + 360) % 360;
      s = Math.min(1, Math.max(0, s));
      l = Math.min(1, Math.max(0, l));
      var c = (1 - Math.abs(2 * l - 1)) * s;
      var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      var m = l - c / 2, r = 0, g = 0, b = 0;
      if (h < 60) { r = c; g = x; }
      else if (h < 120) { r = x; g = c; }
      else if (h < 180) { g = c; b = x; }
      else if (h < 240) { g = x; b = c; }
      else if (h < 300) { r = x; b = c; }
      else { r = c; b = x; }
      function to(v) {
        var n = Math.round((v + m) * 255).toString(16);
        return n.length === 1 ? '0' + n : n;
      }
      return '#' + to(r) + to(g) + to(b);
    }

    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

    /* 相对亮度 —— 判断一块底色该配白字还是深字 */
    function relLum(hex) {
      var n = String(hex).replace('#', '');
      var c = [0, 2, 4].map(function (i) {
        var v = parseInt(n.substr(i, 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }

    function shift(hex, delta) {
      var c = hexToHsl(hex);
      var l = clamp(c.l + delta, 0.02, 0.98);
      return hslToHex(c.h, c.s * (delta < 0 ? 1.06 : 0.94), l);
    }

    /* 在 a、b 之间取中间调（按明度与饱和度线性插值） */
    function mix(a, b, t) {
      return hslToHex(a.h, a.s + (b.s - a.s) * t, a.l + (b.l - a.l) * t);
    }

    function apply(main, minor, text, paper) {
      var M = hexToHsl(main);
      var N = hexToHsl(minor);
      var T = hexToHsl(text);
      var P = hexToHsl(paper);
      /* 底色跟次要色整合：不再单独取色，直接拿次要色的色相，
         把饱和度压得很低、亮度提上去 —— 白里透一丝它的味道。 */
      var paperTone = hslToHex(N.h, Math.min(0.32, N.s * 0.58), 0.945);
      P = hexToHsl(paperTone);
      var root = document.documentElement;
      var set = function (k, v) { root.style.setProperty(k, v); };

      /*
        白天 / 夜晚。
        「夜版」不是简单地把颜色反一下 —— 主色阶还是照常用用户选的色，
        只把**底色那几层**（白 / 纸 / 线 / 灰 / 文字）换成暗的，
        再把原来当"深色描边"用的 --navy 系列**提亮**（夜里深描边等于没描边）。
      */
      var dark = root.dataset.skin === 'dark';

      /* ---------- ① 主色块：顶栏 / 底栏 / 标题条 ---------- */
      set('--bar-bg', main);
      set('--bar-fg', text);                                  /* 字体色说了算 */
      set('--bar-fg-dim', mix(T, M, 0.42));                   /* 次要文字：往主色靠一点 */
      set('--bar-line', 'rgba(0,0,0,.16)');

      /* ---------- ② 深色阶：仍由主色派生（属于「大部分颜色」） ----------
         这里不能简单减一个固定值 —— 主色本身很亮时（比如少女粉 L=72%），
         减掉 0.2 还是亮色，卡片封面就压不住白色图标。
         所以改成按比例下压，再夹进一个够深的区间。
         夜里反过来：--navy 系列是拿来当**描边和次要文字**的，得提亮才看得见。 */
      function deep(hex, ratio, lo, hi) {
        var c = hexToHsl(hex);
        return hslToHex(c.h, Math.min(0.80, c.s * 1.08), clamp(c.l * ratio, lo, hi));
      }
      set('--ink',    dark ? deep(main, 0.16, 0.04, 0.09) : deep(main, 0.30, 0.08, 0.16));
      set('--navy',   dark ? hslToHex(N.h, Math.min(0.42, N.s * 0.7), 0.62) : deep(main, 0.40, 0.13, 0.24));
      set('--navy-3', dark ? hslToHex(N.h, Math.min(0.38, N.s * 0.7), 0.46) : deep(main, 0.62, 0.22, 0.38));

      /* ---------- ③ 全部主体色块归主色 ----------
         卡片封面（视频默认背景）直接用主色，只压很轻的一点，
         免得看上去像另一块颜色。 */
      set('--navy-2', dark ? hslToHex(N.h, Math.min(0.40, N.s * 0.7), 0.34) : deep(main, 0.72, 0.20, 0.44));
      set('--cover',  deep(main, 0.86, 0.26, 0.58));

      /* ---------- ④ 次要色：只控制「选中之后的颜色」 ----------
         它本来就是主色的浅色版，选中项于是"亮起来"。
         浅底压白字会看不清，所以这里的字色单独按亮度判断。 */
      set('--active',    minor);
      set('--active-fg', relLum(minor) > 0.42 ? shift(minor, -0.58) : text);

      /* ---------- ⑤ 字体色：纯用字体锚点，不掺主色也不掺次要色 ---------- */
      set('--on-dark',     text);
      set('--on-dark-dim', mix(T, P, 0.34));

      /* ---------- ⑥ 内容区：这一层才是昼夜差最多的地方 ---------- */
      set('--white', dark ? hslToHex(N.h, Math.min(0.30, N.s * 0.50), 0.15) : '#ffffff');
      set('--paper', dark ? hslToHex(N.h, Math.min(0.26, N.s * 0.45), 0.10) : paperTone);

      /* ---------- ⑦ 边框描边：并进主色 ---------- */
      set('--line',   dark ? hslToHex(N.h, 0.20, 0.30) : mix(M, P, 0.56));
      set('--gray',   dark ? hslToHex(N.h, 0.18, 0.20) : hslToHex(M.h, Math.min(0.10, M.s * 0.30), 0.91));
      set('--gray-2', dark ? hslToHex(N.h, 0.20, 0.32) : hslToHex(M.h, Math.min(0.16, M.s * 0.42), 0.81));

      /* ---------- ⑧ 强调色与浅底：主色 → 底色 之间的过渡调 ---------- */
      var base = dark ? hexToHsl(hslToHex(N.h, Math.min(0.26, N.s * 0.45), 0.10)) : P;
      set('--blue',   main);
      set('--blue-2', mix(M, base, 0.36));
      set('--blue-3', mix(M, base, 0.66));
      set('--blue-4', mix(M, base, 0.86));
      set('--txt-d',  dark ? hslToHex(N.h, 0.16, 0.90) : shift(paperTone, -0.80));
      set('--txt-m',  dark ? hslToHex(N.h, 0.14, 0.64) : mix(M, P, 0.34));
    }

    var systemColor = null, systemPending = null, systemTimer = 0, systemShowError = false;
    function systemAccent() {
      var c = systemColor || state.main;
      /* 系统只给一个强调色，次要色按「同色系更浅」推出来 */
      return { main: c, minor: shift(c, 0.20), text: relLum(c) > 0.42 ? '#143551' : '#FFFFFF', paper: shift(c, 0.44) };
    }

    function syncSystemTheme(showError) {
      systemShowError = systemShowError || !!showError;
      if (systemPending) return systemPending;
      systemPending = (async function () {
        try {
          var data = await api('/api/system/theme');
          if (!data.available || !/^#[0-9a-f]{6}$/i.test(data.accent)) throw new Error('unavailable');
          var next = data.accent.toUpperCase(), changed = next !== systemColor;
          systemColor = next;
          if (changed && state.mode === 'system') render(false);
        } catch (_) {
          if (systemShowError && state.mode === 'system') toast('暂时没能读取 Windows 主题色，先保留当前颜色。稍后会自动重试。', 'warn', 6000);
        } finally { systemPending = null; systemShowError = false; }
      })();
      return systemPending;
    }

    var PRESETS_KEYS = ['main', 'minor', 'text'];
    var state = { mode: 'blue' };
    PRESETS_KEYS.forEach(function (k) { state[k] = PRESETS.blue[k]; });

    var optEls = Array.prototype.slice.call(document.querySelectorAll('.theme-opt'));
    var picks = {};
    PRESETS_KEYS.forEach(function (k) {
      picks[k] = [document.getElementById('pick-' + k), document.getElementById('inp-' + k)];
    });

    function quadFor(mode) {
      if (mode === 'custom') {
        var o = {};
        PRESETS_KEYS.forEach(function (k) { o[k] = state[k]; });
        return o;
      }
      if (mode === 'system') return systemAccent();
      return PRESETS[mode] || PRESETS.blue;
    }

    function render(save) {
      var q = quadFor(state.mode);
      PRESETS_KEYS.forEach(function (k) { state[k] = q[k]; });
      apply(q.main, q.minor, q.text, q.paper);
      navBadgeTheme.set(q.main);
      if (state.mode === 'system') {
        if (!systemTimer) systemTimer = setInterval(function () {
          if (!document.hidden) syncSystemTheme(false);
        }, 2000);
        if (!systemColor) syncSystemTheme(false);
      } else if (systemTimer) {
        clearInterval(systemTimer); systemTimer = 0;
      }

      PRESETS_KEYS.forEach(function (k) {
        var pick = picks[k][0], inp = picks[k][1];
        if (pick) pick.value = q[k];
        if (inp) inp.value = q[k].toUpperCase();
      });
      optEls.forEach(function (el) {
        el.classList.toggle('on', el.dataset.theme === state.mode);
      });
      if (save) {
        lsSave(KEY, JSON.stringify(state), '主题设置');
      }
    }

    optEls.forEach(function (el) {
      el.addEventListener('click', function () {
        state.mode = el.dataset.theme;
        render(true);
        if (state.mode === 'system') syncSystemTheme(true);
      });
    });

    PRESETS_KEYS.forEach(function (k) {
      var pick = picks[k][0], inp = picks[k][1];
      if (pick) pick.addEventListener('input', function () {
        state[k] = pick.value;
        state.mode = 'custom';
        render(true);
      });
      if (inp) inp.addEventListener('change', function () {
        var v = inp.value.trim();
        if (!/^#?[0-9a-fA-F]{6}$/.test(v)) { render(false); return; }
        state[k] = '#' + v.replace('#', '').toLowerCase();
        state.mode = 'custom';
        render(true);
      });
    });

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onSys = function () { if (state.mode === 'system') syncSystemTheme(false); };
      if (mq.addEventListener) mq.addEventListener('change', onSys);
    }
    window.addEventListener('focus', function () { if (state.mode === 'system') syncSystemTheme(false); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.mode === 'system') syncSystemTheme(false);
    });

    var hadSaved = false;
    function readSavedTheme() {
      try {
        var saved = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (saved && saved.mode) {
          hadSaved = true;
          state.mode = saved.mode;
          PRESETS_KEYS.forEach(function (k) {
            if (saved[k]) state[k] = saved[k];
          });
        }
      } catch (_) {}
    }
    readSavedTheme();

    render(false);

    window.BiliTheme = {
      reload: function () {
        readSavedTheme();
        render(false);
        this.hadSaved = hadSaved;
      },
      set: function (mode, main, minor, text, paper) {
        if (mode) state.mode = mode;
        if (main) state.main = main;
        if (minor) state.minor = minor;
        if (text) state.text = text;
        if (paper) state.paper = paper;
        render(true);
      },
      hadSaved: hadSaved,
    };
  })();

  /* ---------------- 白天 / 夜晚 ---------------- */
  /*
    夜版只换**底色那几层**（白 / 纸 / 线 / 灰 / 文字），主色阶原样不动 ——
    所以"换主色"和"切昼夜"是两件互不干扰的事，随便怎么组合都行。

    状态跟其它数据一样存在 data/config 里（走 lsSave 双写），
    下次打开还是上次那个。
  */
  function applySkin(dark, save) {
    const root = document.documentElement;
    if (dark) root.dataset.skin = 'dark';
    else delete root.dataset.skin;

    // 图标和文字显示的是**当前**是什么模式，不是"点下去会变成什么"
    const icon = $('#skin-icon');
    if (icon) icon.setAttribute('href', dark ? '#i-moon' : '#i-sun');
    const txt = $('#skin-text');
    if (txt) txt.textContent = dark ? '夜晚' : '白天';
    const btn = $('#top-skin');
    if (btn) btn.title = dark ? '现在是夜晚，点一下换回白天' : '现在是白天，点一下换成夜晚（白底转暗色）';

    // 让主题引擎按新的昼夜重推一遍色阶（它会读 data-skin）
    if (window.BiliTheme) window.BiliTheme.set();
    if (save) lsSave('bilifav.skin', dark ? 'dark' : 'light', '白天 / 夜晚');
  }

  $('#top-skin').addEventListener('click', () => {
    applySkin(document.documentElement.dataset.skin !== 'dark', true);
  });

  /* 首次启动的引导：没存过主题就弹一次 */
  (function () {
    var KEY = 'bilifav.theme';
    var box = document.getElementById('welcome');
    if (!box || !window.BiliTheme) return;

    if (window.BiliTheme.hadSaved) return;   /* 已经选过了，不再打扰 */

    var opts = Array.prototype.slice.call(box.querySelectorAll('.wc-opt'));
    var choice = 'blue';

    opts.forEach(function (el) {
      el.addEventListener('click', function () {
        choice = el.dataset.wc;
        opts.forEach(function (o) { o.classList.toggle('on', o === el); });
        /* 点哪个就当场预览哪个，所见即所得 */
        window.BiliTheme.set(choice);
      });
    });

    var go = document.getElementById('wc-go');
    if (go) go.addEventListener('click', function () {
      window.BiliTheme.set(choice);          /* 这一步会写进 localStorage */
      box.classList.remove('show');
    });

    box.classList.add('show');
  })();

  /* ================================================ 收藏夹设置（改名 / 清理 / 搬家） */
  let fsTarget = null;      // 设置弹窗当前针对的那个收藏夹
  let folderEditSaving = false;

  async function openFolderSettings(folder) {
    // 既可能从收藏夹栏右键传对象进来，也可能是按钮的 click 事件，得分辨一下
    const f = (folder && folder.media_id) ? folder : S.sort.folder;
    if (!f) { toast('先在左边挑一个收藏夹', 'warn'); return; }
    fsTarget = f;
    await openModal({
      title: '收藏夹设置',
      desc: '改的是 B 站上这个收藏夹本身，不是本地设置。',
      body: `
        <div class="field"><label>名字</label>
          <input type="text" id="fs-title" maxlength="40" value="${esc(f.title || '')}"></div>
        <div class="field" style="margin-top:10px"><label>简介</label>
          <input type="text" id="fs-intro" maxlength="200" value="${esc(f.intro || '')}"
                 placeholder="写点什么，别人点进来能看到"></div>
        <label class="switch" style="margin-top:10px">
          <input type="checkbox" id="fs-private"${f.privacy === 1 ? ' checked' : ''}>
          <span class="track"></span>
          <span class="txt">设为私密<small>只有自己能看见</small></span>
        </label>`,
      buttons: [
        // 三个"动作"用白底（跟「添加视频」一个样式），只有「保存改动」是主色实心 ——
        // 一屏里主色按钮太多就分不出主次了
        { text: '清理失效内容', kind: 'plain', onClick: () => cleanFolderInvalid(f) },
        { text: '搬运收藏夹', kind: 'plain', onClick: () => { closeModal(false); transferFolder('move'); } },
        { text: '合并收藏夹', kind: 'plain', onClick: () => { closeModal(false); transferFolder('copy'); } },
        { text: '保存改动', kind: 'solid', onClick: () => saveFolderEdit() },
      ],
    });
  }

  async function saveFolderEdit() {
    if (folderEditSaving) return;
    const f = fsTarget || S.sort.folder;
    if (!f) return;
    const title = ($('#fs-title').value || '').trim();
    if (!title) { toast('名字不能空着', 'warn'); return; }
    const intro = ($('#fs-intro').value || '').trim();
    const privacy = $('#fs-private').checked ? 1 : 0;
    const form = $('#fs-title');
    const controls = Array.from($('#modal-mask').querySelectorAll('button,input'));
    const submit = controls.find(el => el.tagName === 'BUTTON' && el.textContent.trim() === '保存改动');
    folderEditSaving = true;
    controls.forEach(el => { el.disabled = true; });
    if (submit) submit.textContent = '正在保存…';
    try {
      const d = await api('/api/folder/edit', {
        media_id: f.media_id, title, intro, privacy,
      });
      const updated = {...f, ...(d.folder || {}), title, intro, privacy};
      Object.assign(f, updated);
      S.folders = S.folders.map(folder => Number(folder.media_id) === Number(f.media_id) ? {...folder, ...updated} : folder);
      if (S.sort.folder && S.sort.folder.media_id === f.media_id) {
        Object.assign(S.sort.folder, updated);
        $('#sort-folder-title').textContent = title;
      }
      renderFolders(); renderSortFolders(); renderFavList(); renderTopStats();
      if ($('#fs-title') === form) closeModal(true);
      toast('收藏夹信息改好了', 'ok');
    } catch (err) { toast(err.message, 'err', 6000); }
    finally {
      folderEditSaving = false;
      controls.forEach(el => { el.disabled = false; });
      if (submit) submit.textContent = '保存改动';
    }
  }

  async function cleanFolderInvalid(folder) {
    const f = folder || fsTarget || S.sort.folder;
    if (!f) { toast('先挑个收藏夹', 'warn'); return; }
    const ok = await confirmBox(
      '清理失效内容？',
      `会让 B 站把「${esc(f.title || '')}」里所有<b>已失效</b>的稿件一次性清掉。<br>
       比手动标一堆再删快得多，但发出去就<b>收不回来</b>了 —— 清完记得重新加载看看结果。`,
      '清理'
    );
    if (!ok) return;
    try {
      const d = await api('/api/folder/clean', { media_id: f.media_id });
      toast(d.message || '清理指令已发出', 'ok', 6000);
      closeModal(false);
      resetTaskView();
      toggleTaskPop(true);
    } catch (err) { toast(err.message, 'err', 6000); }
  }

  /** 把自己这个收藏夹的内容搬到 / 合并到另一个收藏夹（走服务端批量接口） */
  async function transferFolder(mode) {
    const src = S.sort.folder;
    if (!src) return;
    const others = (S.folders || []).filter((x) => x.media_id !== src.media_id);
    if (!others.length) { toast('你只有一个收藏夹，没地方可搬', 'warn'); return; }
    const target = await openModal({
      title: mode === 'move' ? '搬到哪个收藏夹？' : '合并到哪个收藏夹？',
      desc: mode === 'move'
        ? `会把「${esc(src.title || '')}」里的内容<b>整个挪过去</b>，源收藏夹就空了。`
        : `会把「${esc(src.title || '')}」里的内容<b>复制一份</b>过去，源收藏夹不动。`,
      body: `<div class="field"><label>目标收藏夹</label>
        <select id="fs-target">${others.map((x) =>
          `<option value="${x.media_id}">${esc(x.title)}（${x.count} 条）</option>`).join('')}</select></div>
        <div class="hint" style="margin-top:8px">走 B 站自己的批量接口，不用一条条来，快得多。</div>`,
      okText: mode === 'move' ? '搬过去' : '合并过去',
      collect: () => Number(($('#fs-target') || {}).value || 0),
    });
    if (!target) return;
    try {
      const d = await api(mode === 'move' ? '/api/folder/move' : '/api/folder/merge', {
        src_media_id: src.media_id,
        tar_media_id: target,
      });
      toast(d.message || '已经交给 B 站了', 'ok', 6000);
      resetTaskView();
      toggleTaskPop(true);
      await refreshFolders();
    } catch (err) { toast(err.message, 'err', 6000); }
  }

  /* ---------------- 导入清单 ---------------- */
  /*
    读一个 CSV / 文本文件，把里面的 BV 号、av 号、视频链接都捞出来，
    然后走跟「添加视频」一样的流程加进当前收藏夹。

    · 自己导出的那份 CSV 直接就能导回来（链接在「链接」那一列里）
    · 随便一份一行一个号 / 一行一条链接的文本也认 —— 反正都是全文扫一遍找视频号
    · 顺序按它们在文件里出现的先后，加进来之后还能拖
  */
  async function importFromText(text, sourceName) {
    if (!S.sort.folder) {
      toast('先打开一个收藏夹，导入的东西才知道往哪儿放', 'warn', 4600);
      return;
    }
    const ids = [];
    const seen = new Set();
    const re = /BV[0-9A-Za-z]{10}|\bav(\d{1,12})\b/gi;
    let m;
    while ((m = re.exec(text))) {
      const raw = m[0];
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ids.push(raw);
    }
    if (!ids.length) {
      toast(`「${sourceName}」里没认出 BV 号或者 av 号`, 'warn', 5200);
      return;
    }

    const atEnd = !S.sort.editing;
    const BATCH = 10;                      // 服务端一次最多认 50 个，拆小了还有进度可看
    const rounds = Math.max(1, Math.ceil(ids.length / BATCH));
    const found = [];
    const failed = [];
    toast(`从「${sourceName}」里认出 ${ids.length} 个，正在问 B 站…`, 'info', 0, 'import');
    try {
      for (let i = 0; i < ids.length; i += BATCH) {
        if (rounds > 1) {
          toast(`正在问 B 站…（${Math.floor(i / BATCH)} / ${rounds} 批，已认出 ${found.length} 个）`,
            'info', 0, 'import');
        }
        const data = await api('/api/video/resolve', { input: ids.slice(i, i + BATCH).join('\n') });
        found.push(...(data.found || []));
        failed.push(...(data.failed || []));
      }
      toast(`问完了：认出 ${found.length} 个${failed.length ? `，${failed.length} 个没认出来` : ''}`,
        'ok', 3200, 'import');

      const added = addVideosToList(found, atEnd);
      if (added) {
        toast(`导入 ${added} 个，拖到想要的位置吧～`, 'ok', 6200);
      } else if (!failed.length) {
        toast(found.length ? '这些都已经在列表里了' : '没导进来东西', 'warn');
      }
      if (failed.length) {
        const lines = failed.slice(0, 8)
          .map((f) => `<div>· <b>${esc(f.input)}</b>：${esc(f.why)}</div>`).join('');
        await openModal({
          title: `${failed.length} 个没认出来`,
          desc: '这几个查不到或者号不对，其余的都处理好了：',
          body: `<div style="font-size:12.5px;line-height:1.9;color:var(--txt-2)">${lines}</div>`,
          okText: '知道了',
          showCancel: false,
        });
      }
    } catch (err) {
      toast(err.message, 'err', 6000, 'import');
    }
  }

  /** 读文件 → 按内容导入 */
  function readAndImport(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('文件太大了（超过 8 MB）', 'warn', 5200); return; }
    const reader = new FileReader();
    reader.onload = () => importFromText(String(reader.result || ''), file.name || '这个文件');
    reader.onerror = () => toast('文件读不出来', 'err', 5200);
    reader.readAsText(file, 'utf-8');
  }

  $('#sort-import').addEventListener('click', () => $('#sort-import-file').click());
  $('#sort-import-file').addEventListener('change', (e) => {
    readAndImport(e.target.files && e.target.files[0]);
    e.target.value = '';        // 同一个文件连着选两次也要能触发
  });

  // 把文件直接拖到卡片区也能导入。
  // 拖卡片时 dataTransfer 里没有 Files，所以不会跟卡片拖拽打架。
  ['dragover', 'drop'].forEach((type) => {
    sortGrid.addEventListener(type, (e) => {
      const dt = e.dataTransfer;
      if (!dt || !dt.types || !Array.from(dt.types).includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      if (type === 'drop' && dt.files && dt.files[0]) readAndImport(dt.files[0]);
    }, true);
  });

  /* ---------------- 导出当前清单 ---------------- */
  /*
    导的是**你看到的那一份**（含还没提交的改动），不是重新去线上拉一遍 ——
    适合"整理好了先留个底"，或者把清单贴给别人看。

    收藏夹的设置入口在收藏夹栏各自的右键菜单里（改名 / 清理失效 / 合并 / 删除），
    所以右上角不再放那个三道杠了。
  */
  $('#sort-export').addEventListener('click', async () => {
    if (!S.sort.folder) { toast('先打开一个收藏夹', 'warn'); return; }
    if (!S.sort.order.length) { toast('这个收藏夹还是空的，没什么可导', 'warn'); return; }
    const map = itemMap();
    const newSet = newKeySet();
    const rows = S.sort.order.map((k, i) => {
      const it = map.get(k) || {};
      return {
        idx: i + 1,
        title: it.title || '',
        upper: it.upper || '',
        duration: it.duration || 0,
        play: it.play || 0,
        danmaku: it.danmaku || 0,
        fav_time: it.fav_time || 0,
        bvid: it.bvid || '',
        avid: it.avid || 0,
        invalid: !!it.invalid,
        deleted: S.sort.deleted.has(k),
        added: newSet.has(k),
        // 标签是你自己贴的，导出得带上 —— 不然导出去再导回来就丢光了。
        // 注意 itemTags 是 Map（不是普通对象），标签 id 还得去 S.tags 里翻名字。
        tags: Array.from(S.itemTags.get(k) || [])
          .map((id) => (S.tags.find((t) => t.id === id) || {}).name)
          .filter(Boolean),
      };
    });
    try {
      const d = await api('/api/folder/export', {
        title: S.sort.folder.title || '收藏夹',
        items: rows,
      });
      toast(`导出好了：${d.count} 条 → ${d.path}`, 'ok', 9000);
    } catch (err) { toast(err.message, 'err', 6000); }
  });

  /* ---------------- 菜单里那几个折叠面板 ---------------- */
  /*
    快捷键 / 任务记录 / 数据平时用不到，默认收着，点标题才向下展开。
    展开状态记在 prefs 里，下次进来还是上次的样子。
  */
  const FOLD_PANELS = ['history-panel', 'keys-panel', 'data-panel'];

  function applyFolds() {
    const open = ((PREFS.misc || {}).folds) || {};
    FOLD_PANELS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('open', !!open[id]);
    });
  }

  document.addEventListener('click', (e) => {
    const h = e.target.closest && e.target.closest('.panel-h[data-fold]');
    if (!h) return;
    if (e.target.closest('button')) return;   // 标题右边那些小按钮不算折叠
    const panel = h.closest('.panel');
    if (!panel || !panel.id) return;
    panel.classList.toggle('open');
    const folds = Object.assign({}, (PREFS.misc || {}).folds || {});
    folds[panel.id] = panel.classList.contains('open');
    savePrefs({ misc: Object.assign({}, PREFS.misc || {}, { folds }) });
  });

  /* ================================================= 本机偏好（跟 data/ 一起走） */
  /*
    收藏夹顺序、自定义快捷键这些存后端（data/config/prefs.json），
    不放浏览器存储 —— 换台电脑把 data/ 拷走还能带着。
  */

  async function loadPrefs() {
    try {
      const data = await api('/api/prefs');
      const p = data.prefs || {};
      if (Array.isArray(p.folder_order)) PREFS.folder_order = p.folder_order.map(Number);
      if (p.shortcuts && typeof p.shortcuts === 'object') PREFS.shortcuts = p.shortcuts;
      if (p.misc && typeof p.misc === 'object') PREFS.misc = p.misc;
      if (p.ui && typeof p.ui === 'object' && Object.keys(p.ui).length) {
        PREFS.ui = {...p.ui, ...uiPending};
        /*
          把 data/ 里那份**灌回浏览器存储**。

          这样原来那些直接读 localStorage 的代码（标签、主题、
          每页数量…）一行都不用改，而且换台电脑把 data/ 拷过去之后，
          这些数据照样在。灌写失败也没关系，下面的读取都有兜底默认值。
        */
        Object.keys(p.ui).forEach((k) => {
          if (k === 'bilifav.trash') return; // 保留旧数据，但不再加载已移除的功能
          if (typeof p.ui[k] === 'string') {
            try { localStorage.setItem(k, p.ui[k]); } catch (_) {}
          }
        });
      } else {
        // 后端还是空的（老版本升上来的）→ 把浏览器里的补写过去
        migrateLocalToPrefs();
      }
    } catch (_) { /* 读不到就用默认的 */ }
  }

  async function savePrefs(patch) {
    if (patch.ui) {
      Object.entries(patch.ui).forEach(([key,value]) => queueUiSave(key,value));
      patch = {...patch}; delete patch.ui;
    }
    if (!Object.keys(patch).length) return flushUiSave();
    Object.assign(PREFS, patch);
    try {
      await api('/api/prefs/set', { prefs: patch });
    } catch (err) {
      toast('设置没能存下来：' + err.message, 'err', 6000);
    }
  }

  /* ========================================================== 快捷键 */
  /*
    一张表管到底：默认键、改键、匹配、帮助面板都读它。

    键位统一存成 `Ctrl+Shift+K` 这样的"规格串" —— 按下的组合先归一化成同样的
    格式再比对，所以改键和匹配走的是同一套规则，不会出现"明明设了却按不出来"。
  */
  const SHORTCUT_DEFS = [
    { id: 'prevPage', modes: 15, label: '上一页', def: 'ArrowLeft', scope: '浏览页' },
    { id: 'nextPage', modes: 15, label: '下一页', def: 'ArrowRight', scope: '浏览页' },
    { id: 'firstPage', modes: 15, label: '跳到第一页', def: 'Home', scope: '浏览页' },
    { id: 'lastPage', modes: 15, label: '跳到最后一页', def: 'End', scope: '浏览页' },
    { id: 'focusFilter', modes: 15, label: '跳到筛选框', def: 'Ctrl+F', scope: '浏览页' },
    { id: 'toggleMulti', modes: 15, label: '开 / 关多选', def: 'M', scope: '浏览页' },
    { id: 'selectAll', modes: 10, label: '全选本页', def: 'Ctrl+A', scope: '浏览页 · 多选时' },
    { id: 'markDelete', modes: 8, label: '把选中的标成待删除', def: 'Delete', scope: '浏览页 · 整理并多选时' },
    { id: 'quickSave', modes: 12, label: '快捷保存草稿', def: 'Ctrl+S', scope: '浏览页 · 整理时（保留整理状态）' },
    { id: 'undo', modes: 12, label: '撤销一步', def: 'Ctrl+Z', scope: '浏览页 · 整理时' },
    { id: 'redo', modes: 12, label: '重做一步', def: 'Ctrl+Y', scope: '浏览页 · 整理时' },
    { id: 'help', modes: 15, label: '弹出快捷键表', def: '?', scope: '浏览页' },
    { id: 'escape', modes: 31, label: '退多选 / 收详情 / 关弹窗', def: 'Escape', scope: '全局', locked: true },
  ];

  function shortcutOf(id) {
    const def = SHORTCUT_DEFS.find((d) => d.id === id);
    const custom = (PREFS.shortcuts || {})[id];
    return custom || (def ? def.def : '');
  }

  const FIXED_SHORTCUTS = [
    {id:'cardCopy', label:'复制卡片条目（固定）', def:'Ctrl+C', modes:15, scope:'浏览页 · 非输入框'},
    {id:'cardCut', label:'剪切卡片条目（固定）', def:'Ctrl+X', modes:15, scope:'浏览页 · 非输入框'},
    {id:'cardPaste', label:'粘贴卡片条目（固定）', def:'Ctrl+V', modes:15, scope:'浏览页 · 非输入框'},
  ];
  function shortcutConflicts(id, spec) {
    const self = SHORTCUT_DEFS.find(d => d.id === id);
    if (!self) return [];
    return [...SHORTCUT_DEFS, ...FIXED_SHORTCUTS].filter(d => d.id !== id
      && (self.modes & d.modes) !== 0 && (d.def && d.id.startsWith('card') ? d.def : shortcutOf(d.id)) === spec);
  }
  function currentShortcutMode() {
    return sortPageActive() ? (S.sort.editing ? (S.sort.multi ? 8 : 4) : (S.sort.multi ? 2 : 1)) : 16;
  }

  /** 把一次按键归一化成 `Ctrl+Shift+K` 这种规格串；只按修饰键的话返回空串 */
  function keySpec(e) {
    const k0 = e.key || '';
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(k0)) return '';
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    const isChar = k0.length === 1;
    // 字母组合保留 Shift；? 等符号已包含 Shift 的效果，不再重复加前缀。
    if (e.shiftKey && (!isChar || /^[a-z]$/i.test(k0))) parts.push('Shift');
    let k = k0;
    if (k === ' ') k = 'Space';
    else if (isChar) k = k.toUpperCase();
    parts.push(k);
    return parts.join('+');
  }

  function inTextField(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  function sortPageActive() {
    const cur = document.querySelector('.page.active');
    return !!cur && cur.dataset.page === 'sort';
  }

  /** 把选中的这批标成待删除（新增的直接撤回） */
  function markPickedDeleted() {
    if (!S.sort.editing) { toast('先点「开始整理」才能改', 'warn'); return; }
    const keys = pickedList();
    if (!keys.length) { toast('先选几个再说', 'warn'); return; }
    const newSet = newKeySet();
    if (!keys.some(k => newSet.has(k) || !S.sort.deleted.has(k))) return;
    if (!pushHistory()) return;
    let n = 0;
    keys.forEach((k) => {
      if (newSet.has(k)) {
        // 还没提交的新增，直接撤掉更干脆
        S.sort.extra = (S.sort.extra || []).filter((x) => x.key !== k);
        S.sort.order = S.sort.order.filter((x) => x !== k);
        S.sort.picked.delete(k);
        S.sort.deleted.delete(k);
        n += 1;
      } else if (!S.sort.deleted.has(k)) {
        S.sort.deleted.add(k);
        n += 1;
      }
    });
    renderSortList();
    updateSortStats();
    updatePickedUI();
    toast(n ? `标了 ${n} 个待删除（反悔点卡片上的 ×）` : '这些本来就已经标着了', n ? 'ok' : 'info');
  }

  /** 帮助面板：内容按**当前键位**渲染，改过键也能看到真实的 */
  function showKeyHelp() {
    const rows = SHORTCUT_DEFS.map((d) => [shortcutOf(d.id), d.label, d.scope]);
    FIXED_SHORTCUTS.forEach(d => rows.push([d.def,d.label,d.scope]));
    rows.push(['Ctrl+点击', '加选 / 减选一个', '多选时']);
    rows.push(['Shift+点击', '从上一张连选到这一张', '多选时']);
    rows.push(['右键', '贴标签 / 批量处理', '卡片上']);
    openModal({
      title: '快捷键',
      desc: '在浏览页里能用。<b>想改的话去「菜单 → 快捷键」</b>，点一下键位就能换。',
      body: `<div class="keylist">${rows.map(([k, v, s]) =>
        `<div class="keyrow"><kbd>${esc(k)}</kbd><span>${esc(v)}</span><em>${esc(s || '')}</em></div>`).join('')}</div>`,
      okText: '知道了',
      showCancel: false,
    });
  }

  /* ---------------- 改键 ---------------- */
  let capturingKey = '';

  function renderShortcutRows() {
    for (const [id, action, text] of [
      ['sort-undo', 'undo', '撤销最近一次本地操作'], ['sort-redo', 'redo', '重做刚撤销的本地操作'],
      ['pager-prev', 'prevPage', '上一页'], ['pager-next', 'nextPage', '下一页'],
    ]) {
      const button = document.getElementById(id);
      if (button) button.title = `${text}（${shortcutOf(action)}）`;
    }
    const box = $('#keys-body');
    if (!box) return;
    box.innerHTML = SHORTCUT_DEFS.map((d) => `
      <div class="menu-row keyrow2">
        <span>${esc(d.label)}</span>
        <b class="plain">${esc(d.scope)}${shortcutConflicts(d.id, shortcutOf(d.id)).length ? ' · 键位冲突，请修改' : ''}</b>
        <button class="tbtn keycap${d.locked ? ' locked' : ''}${capturingKey === d.id ? ' capturing' : ''}"
                data-keyid="${d.id}"${d.locked ? ' disabled' : ''}
                title="${esc(d.locked ? '这个是保底的，不让改' : shortcutConflicts(d.id, shortcutOf(d.id)).map(x => '冲突：' + x.label + '（' + x.scope + '）').join('；') || '点一下，然后按新的键')}"
        >${esc(capturingKey === d.id ? '按新键…' : shortcutOf(d.id))}</button>
      </div>`).join('');
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-keyid]');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    capturingKey = capturingKey === btn.dataset.keyid ? '' : btn.dataset.keyid;
    renderShortcutRows();
    if (capturingKey) toast('按一下想用的键（Esc 取消）', 'info', 3200);
  });

  $('#keys-reset').addEventListener('click', async () => {
    await savePrefs({ shortcuts: {} });
    renderShortcutRows();
    toast('快捷键都恢复默认了', 'ok');
  });

  /* ---------------- 按键分发 ---------------- */
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const spec = keySpec(e);

    // 正在改键：这一下只用来记键，不触发别的
    if (capturingKey) {
      e.preventDefault();
      // Ctrl / Shift 等修饰键先按下时继续等待实际按键。
      if (!spec) return;
      const id = capturingKey;
      capturingKey = '';
      if (spec && spec !== 'Escape') {
        const conflicts = shortcutConflicts(id, spec);
        if (conflicts.length) {
          renderShortcutRows();
          toast(`未修改：${spec} 与「${conflicts[0].label}」在${conflicts[0].scope}重叠，请换一个键`, 'warn', 6500);
          return;
        }
        const patch = Object.assign({}, PREFS.shortcuts || {});
        patch[id] = spec;
        savePrefs({ shortcuts: patch });
        renderShortcutRows();
        toast(`设成 ${spec} 了`, 'ok');
      } else {
        renderShortcutRows();
        toast('没改，还是原来的', 'info');
      }
      return;
    }

    const mode = currentShortcutMode();
    const candidates = SHORTCUT_DEFS.filter(d => (d.modes & mode) && shortcutOf(d.id) === spec);
    const fixed = FIXED_SHORTCUTS.filter(d => (d.modes & mode) && d.def === spec);
    if (candidates.length + fixed.length > 1) {
      if (inTextField(document.activeElement)) return;
      e.preventDefault();
      if (!e.repeat) toast('此键位在当前作用域有冲突，请到菜单 → 快捷键修改', 'warn');
      return;
    }
    const hit = id => candidates.some(d => d.id === id);
    if (hit('quickSave')) {
      e.preventDefault();
      if (e.repeat || e.isComposing || tutState || $('#modal-mask').classList.contains('show')) return;
      if (sortPageActive()) void quickSaveDraft();
      return;
    }
    if ($('#modal-mask').classList.contains('show')) return;
    const typing = inTextField(document.activeElement);

    // Esc 是分层的，而且打字时也认
    if (hit('escape')) {
      if (sortPageActive() && S.sort.multi) { setMulti(false); return; }
      if ($('#detail').classList.contains('show')) { closeDetail(); return; }
      return;
    }
    if (typing) return;             // 别的键在输入框里一律不抢
    if (!sortPageActive()) return;

    if (hit('focusFilter')) {
      e.preventDefault();
      const inp = $('#sort-filter');
      inp.focus();
      inp.select();
      return;
    }
    if (hit('nextPage')) { e.preventDefault(); setPage(S.sort.page + 1); return; }
    if (hit('prevPage')) { e.preventDefault(); setPage(S.sort.page - 1); return; }
    if (hit('firstPage')) { e.preventDefault(); setPage(1); return; }
    if (hit('lastPage')) { e.preventDefault(); setPage(1e9); return; }
    if (hit('toggleMulti')) { e.preventDefault(); setMulti(!S.sort.multi); return; }
    if (hit('help')) { e.preventDefault(); showKeyHelp(); return; }
    if (hit('undo')) { e.preventDefault(); if (S.sort.editing) $('#sort-undo').click(); return; }
    if (hit('redo') || (spec === 'Ctrl+Shift+Z' && shortcutOf('redo') === 'Ctrl+Y'
      && !SHORTCUT_DEFS.some(d => d.id !== 'redo' && shortcutOf(d.id) === spec))) {
      e.preventDefault(); if (S.sort.editing) $('#sort-redo').click(); return;
    }
    if (hit('selectAll')) {
      if (!S.sort.multi) return;
      e.preventDefault();
      $('#sort-select-all').click();
      return;
    }
    if (hit('markDelete')) {
      if (!S.sort.multi || !S.sort.picked.size) return;
      e.preventDefault();
      markPickedDeleted();
    }
  });

  /* ============================================================ 启动 */
  $('#modal-ok').addEventListener('click', okClicked);
  $('#modal-cancel').addEventListener('click', () => closeModal(false));
  $('#modal-mask').addEventListener('click', (e) => { if (e.target === $('#modal-mask')) closeModal(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#modal-mask').classList.contains('show')) closeModal(false);
  });

  $('#acct-login').addEventListener('click', () => go('login'));

  async function boot() {
    await loadPrefs();          // 收藏夹顺序、自定义快捷键、白天/夜晚…
    // Backend preferences may have replaced an empty/stale browser cache.
    if (window.BiliTheme) window.BiliTheme.reload();
    applySkin(localStorage.getItem('bilifav.skin') === 'dark', false);
    loadTags();
    renderSortTagTabs();
    try {
      const h = await api('/api/health');
      // 照实显示数据放在哪 —— 顺便说明"默认就在程序旁边，不会往 C 盘另开目录"
      const where = h.data_dir || h.state_dir || 'data/';
      $('#dash-datadir').textContent = where;
      const dd = $('#menu-datadir');
      if (dd) {
        dd.textContent = where;
        dd.title = h.portable === false
          ? '程序目录写不进去，数据退到了用户目录'
          : '数据就在程序旁边，跟着程序文件夹一起走';
      }
      if (h.portable === false) {
        // 不是便携位置就明确说一声，别让用户以为东西丢了
        dd?.classList.add('warn');
        toast(`注意：程序目录写不进去，数据放在 ${where}`, 'warn', 9000);
      }
    } catch (_) {}

    const acc = await refreshAccount();
    if (acc) await refreshFolders();
    renderTopStats();
    refreshTaskStats();
    startTaskPolling();
    loadQr();

    // 带 #页面 进来就尊重它；否则**一律落在「菜单」页**。
    // 菜单上有账号状态、任务进度和设置，是打开软件第一眼该看到的东西；
    // 没登录也进得去，那一页会提示去登录，不用先被拽到登录页。
    const want = (location.hash || '').replace('#', '');
    if (PAGES.includes(want)) go(want, true);
    else go('menu', true);
  }


  // 窗口大小变了也要重算卡片列数
  window.addEventListener('resize', applyGridCols);
  // 页目录随栏宽由 CSS 重排；窗口变化不重建页格，保留滚动位置和拖拽源。
  // 窗口大小变了，教程浮层跟着锚点重新摆一次
  window.addEventListener('resize', () => { if (tutState) tutPlace(); });
  bindTutorial();

  boot();
})();

