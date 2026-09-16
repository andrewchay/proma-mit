import type { PlatformAdapter } from '../platform-adapter'
import { LOCAL_ONLY_CAPABILITIES, PlatformAdapterError } from '../platform-adapter'

export const xiaohongshuLocalAdapter: PlatformAdapter = {
  platform: 'xiaohongshu',
  displayName: '小红书',
  authorization: {
    method: 'unavailable',
    available: false,
    description: '当前版本仅支持本地草稿，尚未提供小红书官方账号连接器。',
    requestedScopes: [],
  },
  getCapabilities: () => ({ ...LOCAL_ONLY_CAPABILITIES }),
  async beginAuthorization() {
    throw new PlatformAdapterError('authorization_unavailable', this.authorization.description)
  },
  async validateAuthorization() {
    throw new PlatformAdapterError('authorization_unavailable', this.authorization.description)
  },
}
