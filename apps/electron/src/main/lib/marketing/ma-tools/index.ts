/**
 * MA 营销工具集 —— 统一导出
 *
 * 为 MAPro Chat 模式提供社交营销相关的内置工具：
 * - strategy-iq: 策略生成
 * - match-ai: KOL 匹配
 * - connect-bot: 智能建联
 * - creative-pilot: 创意指导
 * - kol-search: KOL 数据搜索与采集
 */

// KOL 数据服务
export {
  searchKOLs,
  getKOLById,
  getKOLStats,
  upsertKOL,
  deleteKOL,
  clearAllKOLs,
  seedMockKOLs,
  collectFromSource,
  collectAllSources,
  closeKolDatabase,
  type KOLRecord,
  type KOLSearchFilters,
  type KOLSearchResult,
  type KOLCollectorReport,
  type KOLCollectorConfig,
} from './kol-data-service'

// LLM 服务
export {
  complete,
  completePrompt,
  extractJSON,
  type LLMMessage,
  type LLMCompleteOptions,
  type LLMCompleteResult,
} from './llm-service'

// StrategyIQ
export {
  STRATEGY_IQ_TOOL_DEFINITIONS,
  executeStrategyIQTool,
} from './strategy-iq'

// MatchAI
export {
  MATCH_AI_TOOL_DEFINITIONS,
  executeMatchAITool,
} from './match-ai'

// ConnectBot
export {
  CONNECT_BOT_TOOL_DEFINITIONS,
  executeConnectBotTool,
} from './connect-bot'

// CreativePilot
export {
  CREATIVE_PILOT_TOOL_DEFINITIONS,
  executeCreativePilotTool,
} from './creative-pilot'

// KOL Search
export {
  KOL_SEARCH_TOOL_DEFINITIONS,
  executeKOLSearchTool,
} from './kol-search'

// KOL Data MCP Server
export {
  injectKOLDataMcpServer,
} from './kol-data-mcp'

// KOL Data MCP Tool Meta (for registry)
export {
  KOL_DATA_MCP_TOOL_DEFINITIONS,
} from './kol-data-mcp-tool'

// KOL CRM
export {
  KOL_CRM_TOOL_DEFINITIONS,
  executeKOLCRMTool,
} from './kol-crm'

// CampaignOptimizer
export {
  CAMPAIGN_OPTIMIZER_TOOL_DEFINITIONS,
  executeCampaignOptimizerTool,
} from './campaign-optimizer'

// ScriptStudio
export {
  SCRIPT_STUDIO_TOOL_DEFINITIONS,
  executeScriptStudioTool,
} from './script-studio'

// ContentAudit
export {
  CONTENT_AUDIT_TOOL_DEFINITIONS,
  executeContentAuditTool,
} from './content-audit'

// CampaignTester
export {
  CAMPAIGN_TESTER_TOOL_DEFINITIONS,
  executeCampaignTesterTool,
} from './campaign-tester'

// KOL Portal
export {
  KOL_PORTAL_TOOL_DEFINITIONS,
  executeKOLPortalTool,
} from './kol-portal'


// BudgetForecast
export {
  BUDGET_FORECAST_TOOL_DEFINITIONS,
  executeBudgetForecastTool,
} from './budget-forecast'



// Campaign Agent
export {
  CAMPAIGN_AGENT_TOOL_DEFINITIONS,
  executeCampaignAgentTool,
} from './campaign-agent'

// ContentTracker (内容数据追踪)
export {
  CONTENT_TRACKER_TOOL_DEFINITIONS,
  executeContentTrackerTool,
} from './content-tracker'

// PhaseReviewer (阶段复盘)
export {
  PHASE_REVIEWER_TOOL_DEFINITIONS,
  executePhaseReviewerTool,
} from './ma-phase-reviewer'
