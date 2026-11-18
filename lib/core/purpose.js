/**
 * Purpose Engine 最小实现（2026-11-13，参考 SurfCore purpose-engine）：
 * 素材 → 需求亲和 → 轻量 appraisal → 目标假设（归属/证据/置信度/风险/下一步）。
 * 只产候选，不直接选行动；默认 shadow（tick 可读，不强制）。
 */
export const PURPOSE_NEEDS = ['play', 'learn', 'care', 'connect', 'share', 'create', 'identity', 'consume']
export const NEED_CN = { play: '玩', learn: '弄明白', care: '关心', connect: '靠近', share: '分享', create: '创造', identity: '我是谁', consume: '想吃/想去' }
export const NEED_TO_KIND = { play: 'browse_douyin', learn: 'read_archive', care: 'send_qq', connect: 'send_qq', share: 'send_qq', create: 'write_diary', identity: 'write_diary', consume: 'browse_douyin' }
export const PURPOSE_EMOTIONS = ['curious', 'excited', 'lonely', 'worried', 'proud', 'affectionate', 'bored', 'content', 'envious', 'amused']

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))
const HOUR = 3600000

const AFFINITY = [
  { re: /玩|游戏|开黑|一起|组队/, need: 'play' },
  { re: /怎么|为什么|教程|原理|学习|教程|工具|插件/, need: 'learn' },
  { re: /累|难过|生病|睡|吃|照顾|休息/, need: 'care' },
  { re: /想你|在吗|陪我|说话|晚安/, need: 'connect' },
  { re: /好看|好玩|分享|推荐|视频|图/, need: 'share' },
  { re: /写|画|做|剪|创作|唱/, need: 'create' },
  { re: /我|自己|性格|像不像|关系/, need: 'identity' },
  { re: /吃|喝|想去|旅游|买|馋/, need: 'consume' },
]

export function needAffinity(text) {
  const s = String(text ?? '')
  const out = Object.fromEntries(PURPOSE_NEEDS.map((n) => [n, 0]))
  for (const x of AFFINITY) if (x.re.test(s)) out[x.need] = Math.min(1, out[x.need] + 0.6)
  return out
}

export function emotionCues(text) {
  const s = String(text ?? '')
  const positive = /开心|好耶|喜欢|可爱|棒|笑|哈哈|谢谢|想你/.test(s)
  const negative = /累|难过|烦|气|哭|害怕|焦虑|孤单|生病/.test(s)
  const arousal = Math.min(1, ((s.match(/[!！]/g) ?? []).length) * 0.25 + (positive || negative ? 0.3 : 0))
  return { positive, negative, arousal }
}

export function appraiseMaterial({ text = '', need = 'share', selfRef = false, lastMasterAt = 0, now = Date.now() } = {}) {
  const cues = emotionCues(text)
  const hoursSinceMaster = lastMasterAt > 0 ? Math.max(0, (now - lastMasterAt) / HOUR) : 24
  if (selfRef && hoursSinceMaster >= 6) return 'lonely'
  if (/羡慕|嫉妒|别人|他们|都在/.test(text) && !selfRef) return 'envious'
  if (need === 'care' && cues.negative) return 'worried'
  if (need === 'identity' && selfRef && cues.positive) return 'proud'
  if (need === 'learn' || need === 'identity') return 'curious'
  if ((need === 'play' || need === 'consume') && (cues.positive || cues.arousal > 0.6)) return 'excited'
  if (need === 'connect' && cues.positive) return 'affectionate'
  if (need === 'share' && (cues.positive || cues.arousal > 0.6)) return 'amused'
  if (!cues.positive && !cues.negative && hoursSinceMaster >= 8) return 'bored'
  return 'content'
}

export function minePurposeSeeds({ materials = [], drives = {}, lastMasterAt = 0, now = Date.now(), limit = 8 } = {}) {
  const seeds = []
  for (const m of materials.slice(0, 50)) {
    const text = `${m?.title ?? ''} ${m?.text ?? ''}`.trim()
    if (!text) continue
    const affinity = needAffinity(text)
    const need = PURPOSE_NEEDS.map((n) => [n, affinity[n] * (0.35 + (Number(drives[n]) || 0.5))]).sort((a, b) => b[1] - a[1])[0][0]
    const selfRef = m?.selfRef === true || m?.kind === 'self'
    const emotion = appraiseMaterial({ text, need, selfRef, lastMasterAt, now })
    const confidence = clamp01(0.25 + affinity[need] * 0.3 + (selfRef ? 0.2 : 0) + (m?.repeated ? 0.1 : 0))
    const risk = need === 'connect' || need === 'identity' ? 0.15 : 0.05
    seeds.push({
      owner: m?.owner ?? ((selfRef || ['action', 'goal', 'memory'].includes(String(m?.kind ?? ''))) ? 'self' : (m?.kind === 'owner' ? 'owner' : 'member')),
      need, emotion, confidence, risk,
      evidence: text.slice(0, 120),
      nextStep: need === 'learn' ? '查一下/问主人' : need === 'play' ? '问问要不要一起' : '找个合适的时机说',
      topic: text.slice(0, 30),
    })
  }
  return seeds.sort((a, b) => (b.confidence - b.risk) - (a.confidence - a.risk)).slice(0, Math.max(1, Number(limit) || 8))
}
