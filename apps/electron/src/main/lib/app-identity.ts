/**
 * Proma MIT 运行时身份。
 *
 * 统一使用 proma-mit 标识（应用名、配置目录、userData、DeepLink 协议），
 * 不再区分开发/正式版本，避免出现 proma-mit-dev 与 proma-mit 并存。
 */
export const APP_DISPLAY_NAME = 'proma-mit'
export const APP_PROCESS_NAME = 'proma-mit'
export const APP_CONFIG_DIR_NAME = '.proma-mit'
export const APP_DEEP_LINK_PROTOCOL = 'proma-mit'

// 兼容旧常量（统一指向 proma-mit，不再有独立 dev 目录）
export const APP_DEV_CONFIG_DIR_NAME = APP_CONFIG_DIR_NAME
export const APP_DEV_USER_DATA_DIR_NAME = 'proma-mit'
