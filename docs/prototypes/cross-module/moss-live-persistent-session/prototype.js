// Static review prototype. This file intentionally has no API or media integration.
const variant = document.body.dataset.variant;
const variants = {
  a: ['底部通话条', 'a-bottom-bar.html'],
  b: ['悬浮胶囊', 'b-floating-pill.html'],
  c: ['侧栏通话卡', 'c-sidebar-card.html'],
};
const paths = {
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6"/>',
  muted: '<path d="m3 3 18 18M9 9v2a3 3 0 0 0 5 2M9.3 5a3 3 0 0 1 5.7 1v5M5 10v2a7 7 0 0 0 12 5M19 10v2M12 19v3M9 22h6"/>',
  screen: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8M12 16v5"/>',
  return: '<path d="M8 5 3 10l5 5M3 10h11a6 6 0 0 1 0 12" transform="translate(0 -3)"/>',
  end: '<path d="M3 13c5-5 13-5 18 0l-2 4-4-2v-3M9 12v3l-4 2-2-4Z"/>',
  arrow: '<path d="m7 14 5-5 5 5"/>',
  send: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  plugin: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  settings: '<path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
  more: '<circle cx="5" cy="12" r=".7"/><circle cx="12" cy="12" r=".7"/><circle cx="19" cy="12" r=".7"/>',
  paperclip: '<path d="m8 14 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7L13 3M6 16l9-9"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  play: '<path d="m9 5 10 7-10 7Z"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
const wave = '<span class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>';
const state = { active: true, muted: false, sharing: false, speaking: false, collapsed: false, page: '华子', seconds: 152, session: 1 };
let toastTimer;

document.body.innerHTML = `
  <header class="preview-header">
    <div class="preview-label"><i></i><b>通话常驻 · 交互预览</b><span>模拟界面，不调用麦克风或模型</span></div>
    <nav class="directions" aria-label="设计方向">${Object.entries(variants).map(([key, [label, file]]) => `<a href="${file}" ${key === variant ? 'aria-current="page"' : ''}>${key.toUpperCase()} ${label}</a>`).join('')}</nav>
    <a class="all-directions" href="index.html">三版对比 ↗</a>
  </header>
  <div class="app">
    <aside class="sidebar">
      <div class="sidebar-top"><strong>DS Bot</strong><div class="sidebar-tools"><button class="icon-button search-button" title="搜索（预览）" data-action="demo">${icon('search')}</button><button class="icon-button" title="新建（预览）" data-action="demo">${icon('plus')}</button></div></div>
      <button class="plugin-link" data-page="MOSS"><span>插件</span><svg class="icon mobile-plugin" viewBox="0 0 24 24" aria-hidden="true">${paths.plugin}</svg></button>
      <div class="chief"><img src="assets/chief.svg" alt="Chief"><strong>Chief</strong><small>Chief of Staff</small></div>
      <nav aria-label="Bot 对话">
        <button class="bot-nav" data-page="华子"><img src="assets/huazi.svg" alt=""><div><b>华子</b><p>把刚才的讨论整理成三点吧。</p></div></button>
        <button class="bot-nav" data-page="才子"><img src="assets/caizi.svg" alt=""><div><b>才子</b><p>文字可以俏皮，逻辑得站稳。</p></div></button>
      </nav>
      <div class="sidebar-bottom"><div class="sidebar-slot"></div><button class="sidebar-settings" data-action="demo">${icon('settings')}<span>设置</span></button></div>
    </aside>
    <main class="main">
      <header class="chat-heading"><div><h1 id="page-title">华子</h1><p id="page-subtitle">当前私聊</p></div><div class="heading-tools"><span>仅用于界面预览的示例对话</span><button class="icon-button" data-action="demo" title="更多（预览）">${icon('more')}</button></div></header>
      <section class="conversation" id="chat-view" aria-label="示例聊天"></section>
      <section class="moss-page" id="moss-view" hidden>
        <div class="moss-page-inner"><h2>MOSS Live</h2><p class="intro">实时语音对话。切换页面后，通话仍在继续。</p>
          <div class="moss-stage"><div class="orb" aria-hidden="true"></div><div><strong id="stage-title">我在听</strong><p id="stage-note">你可以随时开口，也可以打断我。</p></div></div>
          <div class="transcript-card"><div class="transcript-title"><h3>实时字幕</h3><span>同一通话 · <span id="session-time">02:32</span></span></div><div id="transcript-entries"></div></div>
          <p class="same-session-note">${icon('check')}<span id="session-note">已回到原通话，字幕和静音状态均保留。</span></p>
        </div>
      </section>
      <div class="composer-zone"><div class="composer"><textarea placeholder="发消息给华子…" aria-label="示例消息输入框"></textarea><div class="composer-actions"><div class="composer-meta"><button class="icon-button" data-action="demo" title="附件（预览）">${icon('paperclip')}</button><span>当前私聊</span></div><button class="send" data-action="send" title="发送示例消息">${icon('send')}</button></div></div><p class="composer-note">预览中的消息不会发送给 Bot</p></div>
      <div class="dock-slot"></div><div class="floating-slot"></div>
    </main>
  </div>
  <div class="scenario-panel" aria-label="预览通话状态"><span>预览状态</span><button data-scenario="listening">聆听</button><button data-scenario="speaking">说话</button><button data-scenario="muted">静音</button><button data-scenario="sharing">共享屏幕</button></div>
  <div class="toast" role="status" hidden></div>`;
// Keep desktop navigation text, and use the existing icon-rail pattern at narrow widths.
const mobileStyle = document.createElement('style');
mobileStyle.textContent = '.mobile-plugin{display:none}@media(max-width:760px){.mobile-plugin{display:block}}';
document.head.append(mobileStyle);

const controller = document.createElement('section');
controller.className = 'moss-controller';
controller.setAttribute('aria-label', 'MOSS Live 通话控制');
controller.innerHTML = `
  <div class="orb" aria-hidden="true"></div>
  <div class="call-info"><div class="moss-name">MOSS Live</div><div class="call-status"><span class="status-dot"></span><span class="status-text">正在聆听</span><span class="call-time">02:32</span></div></div>
  <div class="call-middle">${wave}<span class="call-caption">你继续忙，我在听。</span><button class="icon-button collapse-button" data-action="collapse" title="收起字幕" ${variant !== 'b' ? 'hidden' : ''}>${icon('arrow')}</button></div>
  <div class="sharing-strip" hidden>${icon('screen')}<span>正在共享屏幕</span><button data-action="stop-sharing">停止共享</button></div>
  <div class="call-actions">
    <button class="call-button mute-button" data-action="mute" title="静音麦克风" aria-label="静音麦克风" aria-pressed="false">${icon('mic')}<span>静音</span></button>
    <button class="call-button return-button" data-action="return" title="返回 MOSS Live" aria-label="返回 MOSS Live">${icon('return')}<span>${variant === 'c' ? '返回' : '返回 MOSS'}</span></button>
    <button class="call-button end-button" data-action="end" title="结束通话" aria-label="结束通话">${icon('end')}<span>结束</span></button>
    <button class="call-button restart-button" data-action="restart" title="重新开始预览" aria-label="重新开始预览" hidden>${icon('play')}<span>重新开始</span></button>
  </div>`;

const transcript = [
  ['你', '我先去看看华子的对话。'],
  ['MOSS', '去吧，我在这儿。页面可以换，搭子不用换。'],
];
function renderTranscript() {
  const entries = document.querySelector('#transcript-entries');
  entries.replaceChildren(...transcript.map(([author, text]) => {
    const entry = document.createElement('div');
    entry.className = 'transcript-entry';
    const label = document.createElement('b');
    label.textContent = author;
    entry.append(label, document.createTextNode(text));
    return entry;
  }));
}
function mountController() {
  const slot = variant === 'a' ? '.dock-slot' : variant === 'b' ? '.floating-slot' : matchMedia('(max-width:760px)').matches ? '.dock-slot' : '.sidebar-slot';
  document.querySelector(slot).append(controller);
}
function notify(text) {
  clearTimeout(toastTimer);
  const node = document.querySelector('.toast');
  node.textContent = text;
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 2300);
}
function renderCall() {
  controller.dataset.active = String(state.active);
  controller.dataset.muted = String(state.muted);
  controller.dataset.collapsed = String(state.collapsed);
  const label = !state.active ? '通话已结束' : state.muted ? '麦克风已静音' : state.speaking ? '正在说话' : '正在聆听';
  controller.querySelector('.status-text').textContent = label;
  controller.querySelector('.call-caption').textContent = !state.active ? '想聊的时候，随时回来。' : state.speaking ? '页面可以换，搭子不用换。' : state.muted ? '通话保留，麦克风已关闭。' : '你继续忙，我在听。';
  const mute = controller.querySelector('.mute-button');
  mute.innerHTML = `${icon(state.muted ? 'muted' : 'mic')}<span>${state.muted ? '取消静音' : '静音'}</span>`;
  mute.setAttribute('aria-pressed', String(state.muted));
  mute.title = mute.ariaLabel = state.muted ? '取消静音麦克风' : '静音麦克风';
  mute.hidden = !state.active;
  controller.querySelector('.end-button').hidden = !state.active;
  controller.querySelector('.restart-button').hidden = state.active;
  controller.querySelector('.sharing-strip').hidden = !state.sharing;
  const collapse = controller.querySelector('.collapse-button');
  collapse.title = state.collapsed ? '展开字幕' : '收起字幕';
  // A collapsed floating controller must still have a visible expand control.
  if (variant === 'b') {
    controller.querySelector('.call-actions').prepend(collapse);
    collapse.style.transform = state.collapsed ? 'rotate(180deg)' : '';
  }
  document.querySelector('#stage-title').textContent = !state.active ? '通话已结束' : state.muted ? '麦克风已静音' : state.speaking ? '正在说话' : '我在听';
  document.querySelector('#stage-note').textContent = state.active ? '同一通话，字幕持续保留。' : '需要时可以重新开始。';
  document.querySelectorAll('[data-scenario]').forEach(button => {
    const selected = state.active && (button.dataset.scenario === 'sharing' ? state.sharing : button.dataset.scenario === 'muted' ? state.muted : button.dataset.scenario === 'speaking' ? state.speaking : !state.muted && !state.speaking && !state.sharing);
    button.setAttribute('aria-pressed', String(selected));
  });
  renderTime();
}
function renderTime() {
  const time = `${String(Math.floor(state.seconds / 60)).padStart(2, '0')}:${String(state.seconds % 60).padStart(2, '0')}`;
  controller.querySelector('.call-time').textContent = time;
  document.querySelector('#session-time').textContent = time;
}
function openPage(page, announce = true) {
  state.page = page;
  const moss = page === 'MOSS';
  document.querySelector('#page-title').textContent = moss ? '插件 / MOSS Live' : page;
  document.querySelector('#page-subtitle').textContent = moss ? '实时语音' : '当前私聊';
  document.querySelector('#chat-view').hidden = moss;
  document.querySelector('#moss-view').hidden = !moss;
  document.querySelector('.composer-zone').hidden = moss;
  document.querySelectorAll('[data-page]').forEach(button => button.classList.toggle('selected', button.dataset.page === page));
  document.querySelector('textarea').placeholder = `发消息给${page}…`;
  if (!moss) {
    const isHuazi = page === '华子';
    document.querySelector('#chat-view').innerHTML = `<div class="date">今天 · 示例对话</div><article class="message user"><p>${isHuazi ? '把刚才的讨论整理成三点吧。' : '把这段话写得更俏皮一点，但别太长。'}</p></article><article class="message"><div class="message-author"><img src="assets/${isHuazi ? 'huazi' : 'caizi'}.svg" alt="">${page}</div><div class="assistant-content">${isHuazi ? '<p>好，收成三点：</p><ol><li><b>MOSS 负责对话。</b>需要办事时，再调用你授权的 Bot。</li><li><b>切换页面，通话继续。</b>看记录、发消息，都能一边聊一边做。</li><li><b>控制始终可见。</b>静音、结束、停止共享，随时够得着。</li></ol><p>一句话：你忙你的，它跟得上。</p>' : '<p>可以。文字可以俏皮，逻辑得站稳。</p><p>把原文发来，我帮你收一收——留下机灵，删掉啰嗦。</p>'}<div class="message-meta">示例内容 · 不代表真实 Bot 回复</div></div></article>`;
  }
  renderTranscript();
  if (announce) notify(moss ? (state.active ? '已返回原通话，没有重新连接。' : '通话已结束，字幕仍可查看。') : (state.active ? `已打开${page}，MOSS 通话继续。` : `已打开${page}。`));
}
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.page) { openPage(button.dataset.page); return; }
  if (button.dataset.scenario) {
    state.active = true;
    state.muted = button.dataset.scenario === 'muted';
    state.speaking = button.dataset.scenario === 'speaking';
    state.sharing = button.dataset.scenario === 'sharing';
    renderCall();
    return;
  }
  switch (button.dataset.action) {
    case 'mute': state.muted = !state.muted; notify(state.muted ? '麦克风已静音，通话继续。' : '麦克风已恢复。'); break;
    case 'return': openPage('MOSS'); break;
    case 'end': state.active = false; state.sharing = false; state.muted = false; state.speaking = false; notify('通话已结束，麦克风和屏幕共享已停止。'); break;
    case 'restart': state.active = true; state.seconds = 0; state.session += 1; transcript.splice(0, transcript.length, ['MOSS', '新的模拟通话已开始。']); renderTranscript(); document.querySelector('#session-note').textContent = '这是新通话；旧通话不会自动恢复。'; notify('已开始新的模拟通话。'); break;
    case 'stop-sharing': state.sharing = false; notify('屏幕共享已停止，语音通话继续。'); break;
    case 'collapse': state.collapsed = !state.collapsed; break;
    case 'send': notify('这是界面预览，消息不会发送给 Bot。'); break;
    case 'demo': notify('这里只预览常驻通话交互。'); break;
  }
  renderCall();
});
matchMedia('(max-width:760px)').addEventListener('change', mountController);
mountController();
openPage('华子', false);
renderCall();
setInterval(() => { if (state.active) { state.seconds += 1; renderTime(); } }, 1000);
