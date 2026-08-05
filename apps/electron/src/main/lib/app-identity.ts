/**
 * Gravitas 运行时身份。
 *
 * 统一使用 gravitas 标识（应用名、配置目录、userData、DeepLink 协议）。
 * 由 proma-mit 品牌更名而来；旧环境残留的 .proma-mit 数据不受影响，但新数据写入 .gravitas。
 */
export const APP_DISPLAY_NAME = 'Gravitas'
export const APP_PROCESS_NAME = 'gravitas'
export const APP_CONFIG_DIR_NAME = '.gravitas'
export const APP_DEEP_LINK_PROTOCOL = 'gravitas'

// 兼容旧常量（统一指向 gravitas，不再有独立 dev 目录）
export const APP_DEV_CONFIG_DIR_NAME = APP_CONFIG_DIR_NAME
export const APP_DEV_USER_DATA_DIR_NAME = 'gravitas'
