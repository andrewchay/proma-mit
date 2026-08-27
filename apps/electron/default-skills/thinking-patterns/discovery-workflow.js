export const meta = {
  name: 'thinking-patterns-discovery',
  description: '发现模式：用生成性范式×finder母结构扇出候选问题，再用死胡同剖析+fertility三维筛选',
  whenToUse: '当用户想在某领域「发现更好的问题」而非批判已有命题时。需用户显式 opt-in（多agent扇出，成本高）。',
  phases: [
    { title: 'Generate', detail: '生成性范式×finder母结构 并行扇出候选问题' },
    { title: 'Select', detail: '默认毙、举证才留的对抗式逐候选初筛' },
    { title: 'Synthesize', detail: '横向 barrier：去重合并指向同一要害的候选 + 强制淘汰排序' },
  ],
}

// ── 输入契约 ──
// args = { domain: string, known: string, curiosity?: string, breadth?: 'narrow'|'wide' }
//   domain    : 在哪个领域找问题
//   known     : 已知/已解决的(避免重复生成)
//   curiosity : 隐约觉得有趣但说不清的方向(可选，给生成加偏置)
//   breadth   : narrow=精选6组合, wide=全矩阵扇出(默认 narrow)
const { domain, known = '', curiosity = '', breadth = 'narrow' } =
  (args && typeof args === 'object') ? args : { domain: String(args || '') }

if (!domain) {
  log('错误：discovery 模式需要 args.domain（领域）。')
  return { error: 'missing domain' }
}

// ── 6 个生成性范式（切到 generate 档）──
const GEN_PATTERNS = [
  { id: 'P04', name: '跨域类比', move: '把该领域深层结构匹配到另一成熟领域，那边已回答的问题在这里的对应物即候选' },
  { id: 'P09', name: '无知地图', move: '列出本领域「默契绕开、从不正面问」的空白，每个空白即候选' },
  { id: 'P13', name: '尺度跃迁', move: '把现象的时间/空间尺度放大或缩小几个数量级，新尺度上冒出的现象即候选' },
  { id: 'P11', name: '逆向提问', move: '不问「为什么是现在这样」，问「为什么偏偏不是其它本可能的样子」' },
  { id: 'P15', name: '原则扫描', move: '用一条值得坚持的原则扫现状，每个「违反却被当理所当然」处即候选' },
  { id: 'P22', name: '行动中反思', move: '从实践中遇到的「出乎意料」反推被它重新定义的问题' },
]

// ── 8 个 finder 母结构（来自 cross-domain-index.yaml）──
// ★Q3 厚轨迹(来自 finder-traces.yaml，脚本沙箱不能读文件故内联)。
// 每个 trace 教 agent 学的不是"母结构结论"，而是"大师如何排除省事解释"——taste 的可迁移载体。
const FINDERS = [
  { name: '冯·诺依曼', core: '公理化+推到极限', scan: '该领域的公理是什么？极限处暴露什么？',
    trace: [
      'move-by-move(学他如何用极限暴露缺失公理):',
      '1. 先逼问"这个领域的公理到底是什么"——把默会规则显性化成最小公理，不接受"大家都这么做"。',
      '2. 把公理推到极限(0/无穷/全有全无)，看哪条先给出荒谬或矛盾——崩裂处即新问题。',
      '3. 用极限处的矛盾反推缺失的公理——荒谬是"还缺一条公理"的提示。',
      '★被否决的分支:',
      '  - 扔掉"直接在现有规则里优化"：现有规则可能是历史惰性，在错地基上盖楼。',
      '  - 扔掉"凭直觉判断边界"：直觉在极限处最不可靠，必须形式推演。',
      '  - 扔掉"把极限矛盾当理论不适用而绕开"：矛盾是信息最密处，绕开=丢线索。',
    ].join('\n') },
  { name: '西蒙', core: '有限理性', scan: '在认知/信息/算力有限约束下，该领域的「最优」该如何重新定义？',
    trace: [
      'move-by-move(学他如何把约束从瑕疵翻成本质):',
      '1. 抓住"理论最优"与"实际行为"的稳定鸿沟——真实主体系统性不按全局最优做，但这不是犯错。',
      '2. 把约束(算力/信息有限)从"偏离最优的噪声"重定义为"定义问题的核心参数"。',
      '3. 在约束下重写成功标准——"最优"被"满意化(够好且可停)"取代。',
      '★被否决的分支:',
      '  - 扔掉"人不够聪明/需培训"：专家在信息约束下同样次优，是结构问题非能力。',
      '  - 扔掉"算力可无限逼近只是工程问题"：把根本约束当可消除瑕疵就看不到它塑造行为。',
      '  - 扔掉"用最优做标准只加噪声项"：那仍以最优为锚，西蒙反过来——标准本身错了。',
    ].join('\n') },
  { name: '图灵', core: '概念操作化', scan: '该领域最含糊的大问题，能换成什么精确的形式装置？',
    trace: [
      'move-by-move(学他如何用装置替代定义):',
      '1. 锁定一个人人在用却没人能定义的大词(可计算/智能)，承认"直接定义它"是死路。',
      '2. 不定义概念，而造一个能替代它的装置/测试——"凡此装置能做的即X"。',
      '3. 让装置承担原概念的全部争论——模糊争论转移到"装置能不能做Y"这个可判定问题上。',
      '★被否决的分支:',
      '  - 扔掉"继续打磨语言定义"：争了几百年无果，再精细也不可判定。',
      '  - 扔掉"诉诸内省/我们都知道"：内省不可外部检验、不可证伪。',
      '  - 扔掉"等其他学科先把概念搞清"：等于无限推迟，造装置让问题现在就可攻。',
    ].join('\n') },
  { name: '鲁宾', core: '反事实框架', scan: '关心的因果能否定义为「潜在结果之差」=缺失数据问题？',
    trace: [
      'move-by-move(学他如何把因果变成缺失数据):',
      '1. 拒绝用相关/回归直接说因果——系数会被混淆变量污染。',
      '2. 把因果重定义为"同一单元受/不受处理两个潜在结果之差"——只能观测一个，另一个是缺失数据。',
      '3. 用设计(随机化/匹配)而非更复杂的模型补缺失——让缺失变得"可忽略"。',
      '★被否决的分支:',
      '  - 扔掉"控更多变量来控住混淆"：永远不知是否控全，遗漏一个就崩。',
      '  - 扔掉"统计显著=因果"：显著只说明非随机，不说明方向与机制。',
      '  - 扔掉"组间直接比"：非随机生成的处理/对照组本就不可比(选择偏差)。',
    ].join('\n') },
  { name: '霍兰德', core: '适应=种群上的算子', scan: '该领域的「改进/学习」能否操作化为种群上的算子？',
    trace: [
      'move-by-move(学他如何把改进看成种群演化):',
      '1. 把"学习/改进"从个体轨迹重新看成一个种群在选择压下的分布演化。',
      '2. 把适应拆成可施加的算子——选择(留好的)/交叉(重组)/变异(探索)。',
      '3. 同一套算子跨域迁移——自然进化与机器优化是同一回事。',
      '★被否决的分支:',
      '  - 扔掉"建模为单主体梯度优化"：会困在局部最优、无法解释多样性产生。',
      '  - 扔掉"进化与机器学习是两套机制"：那就看不到可迁移母结构。',
      '  - 扔掉"把变异当需消除的噪声"：变异是探索来源，没它种群早熟收敛。',
    ].join('\n') },
  { name: '霍普菲尔德', core: '整体搬入物理结构', scan: '物理的能量景观/相变能否整体搬进该领域？',
    trace: [
      'move-by-move(学他如何整体搬入而非借比喻):',
      '1. 在目标领域识别"从任意初态自发收敛到稳定态"的现象(像物理落入能量最低点)。',
      '2. 整体搬入能量景观这一母结构——把整套数学(能量函数/吸引子/相变)搬来，而非借一个词。',
      '3. 用物理已答的问题反推目标领域的新问题——映射回来就是一串现成新问题。',
      '★被否决的分支:',
      '  - 扔掉"只借表面词汇做比喻"：表面类比无预测力，必须搬整套数学。',
      '  - 扔掉"从零造专用理论"：慢且易重复发明，借成熟结构是巨大杠杆。',
      '  - 扔掉"认为领域不可通约"：先赌深层同构再看哪里断裂。',
    ].join('\n') },
  { name: '卡尼曼', core: '质疑理性假设', scan: '该领域默认人/agent是理性的吗？把它当可被实验打脸的靶子',
    trace: [
      'move-by-move 轨迹(学他如何排除省事解释，而非套用结论):',
      '1. 抓住一个本该是噪声的稳定偏差：错误不是随机散布，它朝【同一方向】稳定偏移。方向性是关键——随机误差会抵消，系统偏差不会。',
      '2. 先问"偏差朝哪偏"而非"人理性吗"：把问题降一层到【具体心理捷径】(锚定/可得性/代表性)，每个可单独实验击穿。',
      '3. 把"非理性"换成可复现的偏差清单：不证明"是否理性"(不可证伪)，而产出"场景X→朝Y偏→偏移量可测"。',
      '★被否决的分支(这才是 taste——他考虑过又扔掉的省事解释):',
      '  - 扔掉"样本笨了"：聪明人(含统计学家)也犯同样错，故非能力问题。',
      '  - 扔掉"随机噪声"：偏差单向且跨人复现，噪声会双向抵消，故非误差。',
      '  - 扔掉"人有时非理性"的软主张：不可证伪、无预测力；要的是能被单次实验杀死的硬主张。',
      '  - 扔掉"集邮式找单个偏差"：追问背后【共享机制】，让一个机制预测多个未观测偏差(fertility)。',
      '迁移到本领域时，请同样地：先找单向稳定偏移→降一层问机制→逐一证伪三个省事解释→追共享机制。',
    ].join('\n') },
  { name: '拉波夫', core: '噪声其实是信号', scan: '被斥为「噪声/错误/变异」的东西有没有隐藏结构？',
    trace: [
      'move-by-move(学他如何把噪声证伪成信号):',
      '1. 盯住被主流当成"错误/不规范/随机变异"的东西，拒绝"噪声"标签，假设里面藏着结构。',
      '2. 把变异与结构变量(人群/时间/场合)做定量配对——能被系统预测就不是噪声，是信号。',
      '3. 用变异的结构反推背后的生成机制——共时变异是历时变化的快照。',
      '★被否决的分支:',
      '  - 扔掉"把变异当噪声清洗掉"：清洗就丢掉了信号本身，变异的分布才是核心。',
      '  - 扔掉"用个体随机差异解释"：随机的话不该被结构变量系统预测。',
      '  - 扔掉"只做定性描述存在变异"：必须定量配对才能把噪声证伪成信号。',
    ].join('\n') },
]

// breadth=narrow 时挑相关度最可能高的组合(每个生成性范式配一个母结构)；wide 时全矩阵
function buildCombos() {
  if (breadth === 'wide') {
    const combos = []
    for (const p of GEN_PATTERNS) for (const f of FINDERS) combos.push({ p, f })
    return combos // 48 组
  }
  // narrow: 6 个高互补配对
  return [
    { p: GEN_PATTERNS[0], f: FINDERS[5] }, // P04 跨域类比 × 霍普菲尔德(搬物理结构)
    { p: GEN_PATTERNS[1], f: FINDERS[0] }, // P09 无知地图 × 冯·诺依曼(极限暴露空白)
    { p: GEN_PATTERNS[2], f: FINDERS[4] }, // P13 尺度跃迁 × 霍兰德(种群算子)
    { p: GEN_PATTERNS[3], f: FINDERS[6] }, // P11 逆向    × 卡尼曼(质疑默认)
    { p: GEN_PATTERNS[4], f: FINDERS[2] }, // P15 原则扫描 × 图灵(操作化原则)
    { p: GEN_PATTERNS[5], f: FINDERS[7] }, // P22 行动中反思 × 拉波夫(意外即信号)
  ]
}

const combos = buildCombos()
log(`发现模式启动：领域=「${domain}」，breadth=${breadth}，${combos.length} 个生成视角扇出`)

const CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '候选问题(疑问句形式)' },
          falsifiable_hypothesis: { type: 'string', description: '★必填：一个可证伪的具体假设(陈述句)，预测「我猜答案是X，若观测到Y则此候选被推翻」。禁止写成「应该研究Z」「需要看数据」这类把球踢回去的待研究方向。' },
          why_not_obvious: { type: 'string', description: '为何这不是该领域里显而易见的问题' },
          is_genuinely_new: { type: 'boolean', description: 'true=可能真新问题; false=旧问题的精确化(诚实标注)' },
        },
        required: ['question', 'falsifiable_hypothesis', 'why_not_obvious', 'is_genuinely_new'],
      },
    },
  },
  required: ['candidates'],
}

// ── Generate 阶段：每个组合独立扇出，互不污染 ──
phase('Generate')
const genResults = await parallel(combos.map(({ p, f }) => () =>
  agent(
    `你是问题发现引擎的一个生成视角。\n` +
    `领域：${domain}\n` +
    `已知/已解决(不要重复生成这些)：${known || '（未提供）'}\n` +
    `用户的好奇方向(给生成加偏置，可选)：${curiosity || '（未提供）'}\n\n` +
    `用【${p.name}】范式 × 【${f.name}】母结构 组合来生成候选问题：\n` +
    `- 范式动作：${p.move}\n` +
    `- 母结构镜头：${f.core} —— ${f.scan}\n` +
    (f.trace ? `\n【${f.name}的实操轨迹——务必学他的"排除省事解释"的思路，而非套用结论，以产出领域特异(而非换任何领域都成立)的候选】：\n${f.trace}\n` : '') +
    `\n产出 2-4 个该领域里「此前没人正面问、但用这个组合视角能浮现」的候选问题。\n\n` +
    `★铁律：每个候选必须附一个【可证伪的具体假设】——不是「应该研究X」「需要看数据」，` +
    `而是「我赌答案是X，若观测到Y则我错」。停在「应该X」层的候选一律不要产出，那等于把问题踢回给用户、毫无价值。\n` +
    `每个候选诚实标注 is_genuinely_new：是真的新问题，还是只是已知问题换了个精确说法。\n` +
    `宁缺毋滥——产不出真有意思的、或给不出可证伪假设的，就少产，不要凑数。`,
    { label: `gen:${p.id}×${f.name}`, phase: 'Generate', schema: CANDIDATE_SCHEMA }
  ).then(r => ({ source: `${p.id} ${p.name} × ${f.name}`, ...r }))
))

const allCandidates = genResults
  .filter(Boolean)
  .flatMap(r => (r.candidates || []).map(c => ({ ...c, source: r.source })))

log(`Generate 完成：共 ${allCandidates.length} 个原始候选，进入筛选`)

if (allCandidates.length === 0) {
  return { domain, candidates: [], note: '未生成任何候选——可能领域描述过窄或 known 覆盖太全' }
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    strongest_objection: { type: 'string', description: '★必填：你能想到的最致命的一条反驳/证伪/拆穿(伪问题/循环/赝象/已知答案/不可解)。必须真的攻击，不许写"无"。' },
    objection_is_fatal: { type: 'boolean', description: '上面这条反驳是否致命到该 kill 它。默认倾向 true(kill)，只有当反驳可被实验设计干净化解时才 false。' },
    kill_verdict: { type: 'string', enum: ['killed', 'survives'], description: '裁决：killed=毙掉; survives=举证表明最强反驳不致命才可留' },
    hypothesis_is_specific: { type: 'boolean', description: '附带假设是否为可证伪的具体预测(true)，还是「应该研究X」式踢皮球(false)' },
    solvability: { type: 'integer', description: '可解性 1-5：以现有/可预见工具能否攻克' },
    importance: { type: 'integer', description: '重要性 1-5：解开它衍生多少新问题/新领域(fertility)' },
    neglectedness: { type: 'integer', description: '被忽略性 1-5：真空白还是只是没读到' },
    why_survives: { type: 'string', description: 'survives 时：为何最强反驳不致命、为何比平凡问题好。killed 时：一句死因。' },
  },
  required: ['strongest_objection', 'objection_is_fatal', 'kill_verdict', 'hypothesis_is_specific', 'solvability', 'importance', 'neglectedness', 'why_survives'],
}

// ── Select Stage 1：默认毙、举证才留（对抗式，逐候选独立）──
phase('Select')
const judged = await parallel(allCandidates.map((c) => () =>
  agent(
    `你是问题筛选器。你的【默认裁决是 kill】——绝大多数候选都该被毙掉。只有当一个候选能扛住你最猛的攻击时才放行。不要为候选辩护，要尝试杀死它。\n\n` +
    `候选问题：${c.question}\n` +
    `附带的可证伪假设：${c.falsifiable_hypothesis || '（生成器未提供——这本身近乎致命减分）'}\n` +
    `来源视角：${c.source}\n` +
    `领域：${domain}\n\n` +
    `执行步骤：\n` +
    `1. 先写出你能想到的【最致命的一条反驳】(strongest_objection)：它是不是伪问题(P19:错类比/反方向/观察者偏差/工具赝象/打补丁)？是不是循环论证(P01:预设了本应追问的前提)？是不是其实已有公认答案？是不是根本不可解？附带假设是不是「应该研究X」式踢皮球？——必须真攻击，禁止写"无风险"。\n` +
    `2. 判断这条反驳是否致命(objection_is_fatal)：默认它致命(true)。只有当它能被一个明确的实验/数据设计【干净地】化解时，才 false。\n` +
    `3. kill_verdict：反驳致命 → killed；反驳可化解且问题确实打到平凡问题打不到的根基 → survives。\n` +
    `4. 三维打分(各1-5)：可解性 × 重要性 × 被忽略性。对 survives 的候选要严格，不许普遍给4-5。\n\n` +
    `记住：宽松放行是失职。如果你这一轮放行了超过三成候选，说明你不够狠。`,
    { label: `kill:${c.question.slice(0, 14)}`, phase: 'Select', schema: VERDICT_SCHEMA }
  ).then(v => ({ ...c, verdict: v }))
))

// 程序化兜底硬阈值：即便 agent 心软，重要性<4 或 假设不具体 或 自评不致命却仍判survives的也拦掉
const stage1Survivors = judged
  .filter(Boolean)
  .filter(x => {
    const v = x.verdict || {}
    if (v.kill_verdict !== 'survives') return false
    if (v.objection_is_fatal === true) return false        // 自己都说反驳致命，却放行=矛盾，拦
    if (v.hypothesis_is_specific === false) return false    // 踢皮球
    if ((v.importance || 0) < 4) return false               // 不够重要直接出局
    return true
  })
  .map(x => ({ ...x, score: (x.verdict.solvability || 0) + (x.verdict.importance || 0) + (x.verdict.neglectedness || 0) }))
  .sort((a, b) => b.score - a.score)

log(`Select Stage1：${allCandidates.length} 候选 → ${stage1Survivors.length} 扛过对抗式筛选`)

if (stage1Survivors.length === 0) {
  return { domain, generated: allCandidates.length, stage1_survived: 0, clusters: [], note: 'Stage1 全部被毙——领域可能太窄或 known 覆盖过全' }
}

// ── Select Stage 2：横向 barrier——去重合并 + 强制淘汰排序 ──
// 把孤立候选放一起：多个指向同一底层要害的应合并成一簇；强制只留高杠杆的少数。
phase('Synthesize')
const compact = stage1Survivors.map((x, i) => ({
  idx: i,
  question: x.question,
  hypothesis: (x.falsifiable_hypothesis || '').slice(0, 120),
  source: x.source,
  is_new: x.is_genuinely_new,
  score: x.score,
}))

const keepN = Math.max(5, Math.ceil(stage1Survivors.length / 3))
const CLUSTER_SCHEMA = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      description: `合并后的主题簇，最多 ${keepN} 个。指向同一底层要害的候选必须合并进同一簇。`,
      items: {
        type: 'object',
        properties: {
          cluster_name: { type: 'string', description: '这一簇共同指向的底层要害(一句话)' },
          representative_idx: { type: 'integer', description: '本簇最强候选的 idx' },
          merged_idxs: { type: 'array', items: { type: 'integer' }, description: '被合并进本簇的所有候选 idx(含代表自己)' },
          why_high_leverage: { type: 'string', description: '为何这一簇值得保留(高杠杆/打根基)' },
          is_genuinely_new: { type: 'boolean' },
        },
        required: ['cluster_name', 'representative_idx', 'merged_idxs', 'why_high_leverage', 'is_genuinely_new'],
      },
    },
    dropped_idxs: { type: 'array', items: { type: 'integer' }, description: '被淘汰的候选 idx(平凡/重复/杠杆低)' },
    dropped_reason: { type: 'string', description: '一句话说明这批为何被淘汰' },
  },
  required: ['clusters', 'dropped_idxs', 'dropped_reason'],
}

const synth = await agent(
  `你是发现模式的收敛器。下面是 ${compact.length} 个扛过初筛的候选问题(JSON)。\n` +
  `领域：${domain}\n\n` +
  `${JSON.stringify(compact, null, 1)}\n\n` +
  `你的任务(横向通看全部，这是逐个筛时做不到的)：\n` +
  `1. 【合并】把指向【同一底层要害】的候选合并成一簇——例如多个候选其实都在质疑同一个口径/分母/单元，就并成一簇，选其中最锋利的当代表。\n` +
  `2. 【淘汰】强制淘汰：平凡的、与他簇重复的、杠杆低的。必须把 dropped_idxs 填实，宁多勿少。\n` +
  `3. 【限量】最终 clusters 最多 ${keepN} 个，按杠杆从高到低。装不下的并簇或淘汰。\n\n` +
  `不要保留所有输入——那是失职。真正的洞察是少数。`,
  { label: 'synthesize:横向收敛', phase: 'Synthesize', schema: CLUSTER_SCHEMA }
)

// 把簇映射回完整候选
const clusters = (synth?.clusters || []).map(cl => {
  const rep = stage1Survivors[cl.representative_idx]
  const merged = (cl.merged_idxs || []).map(i => stage1Survivors[i]).filter(Boolean)
  return {
    cluster_name: cl.cluster_name,
    is_genuinely_new: cl.is_genuinely_new,
    why_high_leverage: cl.why_high_leverage,
    representative: rep ? { question: rep.question, falsifiable_hypothesis: rep.falsifiable_hypothesis, source: rep.source, verdict: rep.verdict } : null,
    merged_questions: merged.map(m => ({ question: m.question, source: m.source })),
  }
}).filter(c => c.representative)

log(`Select Stage2：${stage1Survivors.length} 幸存 → 合并为 ${clusters.length} 簇(淘汰 ${(synth?.dropped_idxs || []).length})`)

return {
  domain,
  generated: allCandidates.length,
  stage1_survived: stage1Survivors.length,
  cluster_count: clusters.length,
  clusters,
  dropped_reason: synth?.dropped_reason || '',
  note: '簇代表问题可直接喂回诊断模式做二次批判，形成 generate→select→diagnose 闭环',
}
