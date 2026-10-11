# E01第五批子契约：保守文件effects元数据

> 2026-10-09 09:14 GMT+8用户继续；基线9d426f60。

只实施E01文件声明切片，不开并行、discovery或TCC，不实现E02–E05，不改变审批/允许范围。

## 类型与来源

复用CapabilityDescriptor及RuntimeToolDefinition，不建第二个能力目录。shared新增ToolEffects v1：resources为filesystem（mode read/write、pathParameter）或unknown，replay为never/idempotent_read。未知、损坏、版本不支持、原型继承或组合不一致时保守unknown；idempotent_read只表示无写入的读取候选，不证明数据不变或允许自动重试。

实际core factory只为Read/Write/Edit绑定effects，与其已导入的execute函数引用同源。主进程弱引用表保存实际注册对象的声明及name/execute/effects引用；这是已有工具的实例元数据，不是另一套tool catalog。绑定函数只识别三组精确name和已编译execute函数，不接受模型提供的effects或任意“trusted”字符串。

- Read：filesystem read，file_path，idempotent_read。
- Write：filesystem write，file_path，scope=path-and-ancestors，never；现有实现递归创建父目录，不能只标记文件本身。
- Edit：filesystem write，file_path，scope=path，never；Read同为path。
- capability投影返回effects及独立的independentReadCandidate，parallelSafe=false只收紧候选资格，不篡改实际effects或重放声明。
- Bash、Grep、其他builtin、MCP/workspace/外部工具先unknown；不靠名称、readOnlyHint、描述、parallelSafe提示推定无副作用。
- 副本/序列化DTO/同名伪execute不获得实例绑定；执行函数、name或effects字段替换后回退unknown。
- 既有descriptor向effects投影必须由main用实际注册对象查表；source非builtin、toolName不匹配或access矛盾时unknown。descriptor.parallelSafe最多收紧，不授予实际调度或权限。

## 边界

文件参数只是执行接口中的资源引用；仍需E02解析实际输入、cwd、realpath、目录包含关系和共享锁域，不能现在称为可安全并行。纯shared判定或DTO解析不鉴权，调度不能直接信任transport.effects。

没有跨进程锁、真实sandbox、重放保障或MCP效果认证。也不以effects元数据解决受保护测试采集；V02部分、V03仍阻塞。默认执行仍串行，schema投影、permissions和新feature flags保持原状。
