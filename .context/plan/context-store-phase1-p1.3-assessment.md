# P1.3 存储引擎升级评估报告

## 评估结论：保持 sql.js，不迁移到 better-sqlite3

### better-sqlite3 的优势（mycontext 选用理由）

| 特性 | better-sqlite3 | sql.js |
|------|---------------|--------|
| 性能 | 原生 C++ 绑定，快 10-100x | WASM/Emscripten，纯 JS |
| WAL 模式 | ✅ 原生支持 | ❌ 不支持（内存库） |
| 并发 | ✅ 多进程只读 + 单进程写 | ❌ 单实例 |
| 事务 | ✅ `db.transaction()` 原生 | ⚠️ 手动 BEGIN/COMMIT |
| 预编译语句缓存 | ✅ 自动 | ⚠️ 手动管理 |
| 用户自定义函数 | ✅ 支持 | ❌ 不支持 |

### 不迁移的关键原因

#### 1. Electron 打包复杂度（决定性因素）

- **native 模块**：better-sqlite3 含 `.node` 二进制（当前安装的是 v12.11.1，已编译为 `darwin-arm64`）
- **esbuild 处理**：`build:main` 使用 `--bundle --platform=node`，native 模块不会被自动打包进 `dist/main.cjs`
- **electron-builder 配置**：需要：
  1. 将 `better-sqlite3` 加入 `asarUnpack`（解压到 `app.asar.unpacked/`）
  2. 确保 `prebuilds/` 目录的 `.node` 文件被复制到产物
  3. 多平台构建时每个平台需要对应的预编译 binary（darwin-arm64/x64, win32-x64, linux-x64）
- **对比现有复杂度**：当前只有 `@anthropic-ai/claude-agent-sdk` 和 `@earendil-works/pi-tui` 两个 native 依赖，管理已经很复杂。增加第三个会显著增加打包失败率。

#### 2. 当前 context-store 的使用场景不匹配 better-sqlite3 的优势

- **无并发需求**：context-store 当前没有任何调用方，未来消费方是主进程内的 Agent 运行时，单线程访问
- **无 WAL 需求**：不需要"我们写 + 其他进程只读"的并发模式
- **数据量小**：上下文图存储的是结构化元数据（实体/关系/事实），不是消息全量，预计单库 < 100MB
- **性能足够**：sql.js 的 WASM 性能对元数据 CRUD 和 FTS5 查询完全够用

#### 3. sql.js 的独特优势

- **零 native 依赖**：Electron 打包零额外配置
- **内存/文件双模式**：测试用内存库（`openContextStore()`），生产用文件导出（`persist()`），切换无缝
- **FTS5 已编译**：sql.js 的 WASM 构建已包含 FTS5 扩展，无需额外配置
- **Bun 兼容**：纯 JS/WASM，Bun 运行时无 ABI 问题

### 决策

**保持 sql.js，不引入 better-sqlite3。**

将 P1.3 的目标调整为：在 sql.js 基础上完善 WAL 语义模拟（通过文件级锁 + 定期持久化），而非替换存储引擎。

### 后续行动

1. **P1.3 改为「sql.js 持久化语义完善」**：
   - 文件级锁（`~/.proma/context-store.lock`）防止多实例并发写
   - 定期自动持久化（而非仅 `close()` 时）
   - 崩溃恢复（启动时检测未正常关闭的 db 文件）

2. **跳过 P1.3，直接进入 P1.4 Repository 模式**：
   - 存储引擎不变，架构分层仍可推进
   - Repository 模式让未来替换存储引擎更容易（接口隔离）

请确认优先哪个方向。
