/**
 * Proma MIT 运行时身份。
 *
 * 这些值决定系统层面的应用名、单实例隔离、配置目录和 DeepLink 协议，
 * 需要与正式 Proma 分开，避免本机同时安装时互相抢占。
 */
export const APP_DISPLAY_NAME = 'proma-mit'
export const APP_PROCESS_NAME = 'proma-mit'
export const APP_CONFIG_DIR_NAME = '.proma-mit'
export const APP_DEV_CONFIG_DIR_NAME = '.proma-mit-dev'
export const APP_DEV_USER_DATA_DIR_NAME = '@proma-mit/electron-dev'
export const APP_DEEP_LINK_PROTOCOL = 'proma-mit'
