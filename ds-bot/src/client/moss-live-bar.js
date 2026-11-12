import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'
import { MicIcon, WaveIcon } from './icons.js'
import { frameLayout, RAIL_WIDTH } from './frame-layout.js'

const emptySource = { subscribe: () => () => {}, getSnapshot: () => null }
const useSource = source => useSyncExternalStore((source ?? emptySource).subscribe, (source ?? emptySource).getSnapshot)
const glyph = path => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: path }))
const Screen = () => glyph('M4 3h16a1 1 0 0 1 1 1v11H3V4a1 1 0 0 1 1-1ZM12 15v6M8 21h8')
const Return = () => glyph('m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12')
const End = () => glyph('M3 13c5-5 13-5 18 0l-2 4-4-2v-3M9 12v3l-4 2-2-4Z')
const Dial = () => glyph('M5 3h4l2 5-3 2a14 14 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2C10 21 3 14 3 5a2 2 0 0 1 2-2Z')

export function MossLiveCallBar({ controller, onReturn, geometry }) {
  const live = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const frame = useSource(geometry?.frame), pref = useSource(geometry?.sidebarPref), ui = useSource(geometry?.ui), surface = useSource(geometry?.surface)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live.visible || !live.active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live.visible, live.active, live.startedAt])
  if (!live.visible) return null
  let inset = 0
  if (frame) {
    if (surface?.mode === 'bot') {
      const layout = frameLayout({ ...frame, pref: pref ?? 'open', drawer: ui?.leftDrawer, panel: ui?.details ? { view: ui.view, yielded: ui.panelYield } : null })
      inset = layout.left === 'open' ? frame.sidebarWidth : layout.left === 'hidden' ? 0 : RAIL_WIDTH
    } else inset = frame.collapsed ? frame.collapsedWidth : frame.sidebarWidth
  }
  const seconds = live.startedAt ? Math.max(0, Math.floor(((live.endedAt ? Date.parse(live.endedAt) : now) - Date.parse(live.startedAt)) / 1000)) : 0
  const duration = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const status = !live.active ? live.busy ? '正在挂断' : live.sessionState === 'stopped' ? '已挂断' : live.sessionState === 'error' ? '连接异常' : '通话已断开' : live.muted ? '麦克风已静音' : ({ connecting: '正在连接', attached: '正在配置', greeting: '开场问候', speaking: '正在说话', thinking: '正在思考', ready: '正在聆听', listening: '正在聆听' }[live.sessionState] ?? '连接中')
  const last = live.transcript.at(-1)
  const caption = !live.active ? live.busy ? '正在结束通话…' : '需要时，点「重新拨打」继续聊。' : last?.text || (live.muted ? '通话保留，麦克风已静音。' : '你继续忙，我在听。')
  const button = (key, title, icon, onClick, extra = {}) => h('button', { type: 'button', className: `bt-moss-call-button bt-moss-call-${key}`, title, 'aria-label': title, [`data-moss-call-${key}`]: true, onClick, ...extra }, h(icon), h('span', null, title))
  return h('div', { className: 'bt-moss-call-seat', style: { '--moss-inset': `${inset}px` } },
    h('section', { className: 'bt-moss-call-bar', 'data-moss-call-bar': true, 'data-state': live.sessionState, 'data-muted': live.muted, 'data-active': live.active, 'aria-label': 'MOSS Live 通话控制' },
      h('div', { className: 'bt-moss-call-orb', 'aria-hidden': true }),
      h('div', { className: 'bt-moss-call-identity' }, h('strong', null, 'MOSS Live'), h('div', { className: 'bt-moss-call-status' }, h('i', { 'aria-hidden': true }), h('span', { role: 'status' }, status), h('time', null, duration))),
      h('div', { className: 'bt-moss-call-caption' }, h(WaveIcon), h('span', { title: caption }, caption)),
      live.screenStream ? h('div', { className: 'bt-moss-call-sharing' }, h(Screen), h('span', null, '正在共享屏幕'), h('button', { type: 'button', 'data-moss-call-share-stop': true, disabled: live.screenBusy, onClick: controller.stopScreenShare }, '停止共享')) : null,
      h('div', { className: 'bt-moss-call-controls' },
        live.active ? button('mute', live.muted ? '取消静音' : '静音', MicIcon, () => controller.setMuted(!live.muted), { 'aria-pressed': live.muted }) : null,
        button('return', '返回 MOSS', Return, onReturn),
        live.active ? button('end', '结束', End, () => { void controller.stop() }) : button('redial', '重新拨打', Dial, () => { void controller.start() }, { disabled: live.busy }))),
    live.error || live.screenError ? h('p', { className: 'bt-moss-call-error', role: 'alert' }, live.screenError || live.error) : null)
}

// Root-owned styles survive main-page and Bot/Agent surface changes.
export const MOSS_CALL_CSS = `
.bt-moss-call-seat{--call-card:var(--bt-card,var(--dsw-alias-bg-base));--call-ink:var(--bt-ink,var(--dsw-alias-text-primary));--call-line:var(--bt-line,color-mix(in srgb,var(--call-ink) 12%,transparent));--call-accent:var(--bt-accent,var(--call-ink));--call-danger:var(--bt-danger,var(--call-ink));--call-secondary:var(--bt-ink-2,color-mix(in srgb,var(--call-ink) 60%,transparent));background:var(--bt-sidebar,var(--dsw-specific-sidebar-fill));color:var(--call-ink);padding-inline-start:var(--moss-inset,0);font:12px var(--bt-font,var(--dsw-font-family,system-ui));box-sizing:border-box}
.bt-moss-call-bar{display:flex;align-items:center;gap:14px;min-height:68px;padding:12px 26px;border-top:1px solid var(--call-line);background:var(--call-card);box-sizing:border-box}
.bt-moss-call-orb{width:34px;height:34px;flex:none;border-radius:50%;background:radial-gradient(40% 38% at 64% 40%,color-mix(in srgb,var(--call-accent) 12%,var(--call-card)),transparent 75%),radial-gradient(46% 42% at 42% 68%,color-mix(in srgb,var(--call-accent) 55%,transparent),transparent 78%),radial-gradient(120% 120% at 50% 50%,var(--call-card),color-mix(in srgb,var(--call-accent) 35%,var(--call-card)) 58%,var(--call-accent) 100%);box-shadow:inset -5px -4px 9px color-mix(in srgb,var(--call-ink) 12%,transparent),0 0 0 4px color-mix(in srgb,var(--call-accent) 7%,transparent);animation:bt-moss-call-breathe 5s ease-in-out infinite}
.bt-moss-call-identity{min-width:112px;flex:none}.bt-moss-call-identity strong{font-size:12px;font-weight:600}.bt-moss-call-status{display:flex;align-items:center;gap:6px;margin-top:5px;color:var(--call-secondary);font-size:11px;white-space:nowrap}.bt-moss-call-status i{width:5px;height:5px;border-radius:50%;background:var(--bt-green,var(--call-accent))}.bt-moss-call-status time{color:var(--bt-ink-3,var(--call-secondary));font-variant-numeric:tabular-nums}
.bt-moss-call-caption{display:flex;align-items:center;gap:10px;flex:1;min-width:0;color:var(--call-secondary)}.bt-moss-call-caption>svg{color:var(--call-accent);flex:none}.bt-moss-call-caption>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.bt-moss-call-controls{display:flex;align-items:center;gap:6px;margin-inline-start:auto;flex:none}.bt-moss-call-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:35px;padding:8px 11px;border:1px solid var(--call-line);border-radius:10px;background:var(--call-card);color:inherit;cursor:pointer;font:inherit;white-space:nowrap;touch-action:manipulation}.bt-moss-call-button:hover{background:var(--bt-hover,color-mix(in srgb,var(--call-ink) 5%,var(--call-card)))}.bt-moss-call-button svg{flex:none}.bt-moss-call-button:disabled{opacity:.45;cursor:default}.bt-moss-call-button:focus-visible,.bt-moss-call-sharing button:focus-visible{outline:2px solid var(--call-accent);outline-offset:3px}
.bt-moss-call-end{color:var(--call-danger);background:color-mix(in srgb,var(--call-danger) 6%,var(--call-card));border-color:color-mix(in srgb,var(--call-danger) 13%,var(--call-card))}.bt-moss-call-mute[aria-pressed=true]{color:var(--call-danger);background:color-mix(in srgb,var(--call-danger) 7%,var(--call-card))}.bt-moss-call-bar[data-muted=true] .bt-moss-call-orb{filter:grayscale(.85);opacity:.7}.bt-moss-call-bar[data-muted=true] .bt-moss-call-status i{background:var(--bt-star,var(--call-ink))}.bt-moss-call-bar[data-active=false] .bt-moss-call-status i{background:var(--call-danger)}.bt-moss-call-bar[data-active=false] .bt-moss-call-orb{filter:grayscale(1);animation:none}
.bt-moss-call-redial{color:var(--call-accent);background:color-mix(in srgb,var(--call-accent) 7%,var(--call-card));border-color:color-mix(in srgb,var(--call-accent) 15%,var(--call-card))}.bt-moss-call-bar[data-state=stopped] .bt-moss-call-status i{background:var(--call-secondary)}
.bt-moss-call-sharing{display:flex;align-items:center;gap:6px;padding:7px 9px;border-radius:8px;background:color-mix(in srgb,var(--bt-green,var(--call-accent)) 7%,var(--call-card));color:color-mix(in srgb,var(--bt-green,var(--call-accent)) 55%,var(--call-ink));font-size:11px;white-space:nowrap}.bt-moss-call-sharing button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0 0 0 6px;text-decoration:underline;text-underline-offset:3px}.bt-moss-call-error{margin:0;padding:0 20px 10px;background:var(--call-card);color:var(--call-danger);font-size:11px;overflow-wrap:anywhere}
@keyframes bt-moss-call-breathe{0%,100%{transform:scale(.94)}50%{transform:scale(1.03)}}
@media(max-width:1100px){.bt-moss-call-caption>span{display:none}.bt-moss-call-caption{flex:0}.bt-moss-call-bar{padding:12px 18px;gap:11px}}
@media(max-width:760px){.bt-moss-call-bar{min-height:74px;padding:12px;gap:10px;flex-wrap:wrap}.bt-moss-call-orb{width:26px;height:26px}.bt-moss-call-identity{min-width:0;flex:1}.bt-moss-call-identity strong{font-size:11px}.bt-moss-call-status{font-size:10px;gap:5px}.bt-moss-call-caption{display:none}.bt-moss-call-controls{gap:4px}.bt-moss-call-button{width:30px;height:30px;padding:6px;border:0;border-radius:50%}.bt-moss-call-button>span{display:none}.bt-moss-call-sharing{width:100%;order:4;font-size:10px}.bt-moss-call-sharing button{margin-inline-start:auto}.bt-moss-call-error{padding:0 12px 10px}}
@media(prefers-reduced-motion:reduce){.bt-moss-call-orb{animation:none}}
`
