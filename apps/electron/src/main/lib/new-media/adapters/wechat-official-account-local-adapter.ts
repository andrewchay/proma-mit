import type { PlatformAdapter } from '../platform-adapter'
import { LOCAL_ONLY_CAPABILITIES, PlatformAdapterError } from '../platform-adapter'

/**
 * 微信公众号本地占位 Adapter。
 *
 * 真实授权（stable token 换取与校验）属于 P2-02，尚未实现。
 * 因此这里：
 * - authorization.available 保持 false，不会把账号伪装成已连接；
 * - 能力只在账号已由能力协商服务写入快照时照实返回，Adapter 自己不推断任何能力。
 */
export const wechatOfficialAccountLocalAdapter: PlatformAdapter = {
  platform: 'wechat-official-account',
  displayName: '微信公众号',
  authorization: {
    method: 'unavailable',
    available: false,
    description: '当前版本仅支持本地草稿与凭据录入，尚未实现微信 stable token 换取与校验。',
    requestedScopes: [],
  },
  getCapabilities: (account) => account?.capabilities ? { ...account.capabilities } : { ...LOCAL_ONLY_CAPABILITIES },
  async beginAuthorization() {
    throw new PlatformAdapterError('authorization_unavailable', this.authorization.description)
  },
  async validateAuthorization() {
    throw new PlatformAdapterError('authorization_unavailable', this.authorization.description)
  },
}
