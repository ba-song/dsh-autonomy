/**
 * 通道适配层（阶段 2：**没有真实通道**）
 *
 * 这里故意做成「显式不可用」，而不是「悄悄能发」：
 *   - 任何真实外发（QQ / 抖音 / 写日记到生产目录）在本版本一律 false
 *   - 与 speak-up 的互斥检查只做「能看就看一眼」，看不到就报 unknown，由统筹者的 C 任务卡收口
 *
 * 以后接真实通道：必须在 executors 注册真实实现，并满足 sendEnabled 三闸门。
 */

export const STAGE = 'offline-mock-only'

export function createChannelAdapter({ getService = () => null } = {}) {
  const supportsReal = false // 阶段 2 写死；改这里等于改交付边界，需要书面同意

  return {
    stage: STAGE,
    supportsRealChannel: () => supportsReal,

    /** 真实外发是否可用（永远 false，除非改上面的常量） */
    canSendReal() {
      return supportsReal
    },

    /** 抖音真实浏览是否可用（同样 false） */
    canBrowseReal() {
      return supportsReal
    },

    /**
     * 与 dsh-speak-up 的冲突状态。
     * 阶段 2 不读别人的配置文件；拿不到服务就老实说 unknown。
     */
    speakUpConflict() {
      let speakUp = null
      try {
        speakUp = getService('speak-up') ?? null
      } catch {
        speakUp = null
      }
      if (!speakUp) return { status: 'unknown', reason: '未提供 speak-up 服务，无法自动判定（C 任务卡负责收口）' }
      const active = speakUp?.active?.() ?? speakUp?.enabled?.() ?? null
      if (active === true) return { status: 'conflict', reason: 'speak-up 仍在对外发送' }
      return { status: 'ok', reason: 'speak-up 未对外发送' }
    },
  }
}
