# 需求与约束

> **本文档描述的是对现有记忆/人格系统的替换需求，不是新增模块。**
> 现有的 `longTimeMemory()` / `processMemory()` / `pets.user_memory` / `pets.system_instruction` 管道将被废弃。

## 功能需求

### FR-1：人格文件（SOUL.md）

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-1.1 | 应用首次启动时，在工作区创建 SOUL.md（默认模板，仅创建不覆盖） | P0 |
| FR-1.2 | 每轮对话开始时读取 SOUL.md 内容并注入 system prompt（**不受记忆开关影响**） | P0 |
| FR-1.3 | 用户可通过应用 UI 查看和编辑 SOUL.md | P1 |
| FR-1.4 | AI 修改 SOUL.md 前必须弹窗征求用户确认 | P0 |
| FR-1.5 | SOUL.md 缺失或为空时，宠物使用安全的默认人格 | P0 |
| FR-1.6 | 首次对话（Onboarding）时，引导用户和宠物一起定义人格 | P1 |

### FR-2：用户画像文件（USER.md）

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-2.1 | 应用首次启动时，在工作区创建 USER.md（默认模板） | P0 |
| FR-2.2 | 记忆开启时，每轮对话开始时读取 USER.md 内容并注入 system prompt | P0 |
| FR-2.3 | 记忆开启时，AI 在对话中学到用户信息时可自主更新 USER.md | P0 |
| FR-2.4 | 记忆关闭时，不读取 USER.md、不注入、不注册 USER.md 的 write/edit 工具 | P0 |
| FR-2.5 | AI 更新 USER.md 无需用户确认（静默更新） | P0 |
| FR-2.6 | 用户可通过 UI 查看和编辑 USER.md | P1 |
| FR-2.7 | 用户说"忘了这个"时，AI 应删除对应信息 | P1 |

### FR-3：记忆文件（MEMORY.md）

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-3.1 | MEMORY.md 不自动创建，由 AI 在需要时自行创建 | P0 |
| FR-3.2 | 记忆开启时，每轮对话开始时读取 MEMORY.md（如存在）并注入 system prompt | P0 |
| FR-3.3 | 记忆开启时，AI 可自主在 MEMORY.md 中添加、修改、删除记忆条目 | P0 |
| FR-3.4 | 记忆关闭时，不读取 MEMORY.md、不注入、不注册 MEMORY.md 的 write/edit 工具 | P0 |
| FR-3.5 | MEMORY.md 超过配置上限时自动截断注入内容 | P0 |
| FR-3.6 | 接近容量上限时，引导 AI 整理记忆 | P1 |
| FR-3.7 | 用户可通过 UI 查看和编辑 MEMORY.md | P1 |

### FR-6：记忆开关（复用现有 UI）

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-6.1 | 保留现有聊天输入框旁的 FaBrain 记忆按钮，per-conversation toggle | P0 |
| FR-6.2 | 记忆开关同时控制 USER.md 和 MEMORY.md 的读取与写入 | P0 |
| FR-6.3 | SOUL.md 不受记忆开关影响，始终读取注入 | P0 |
| FR-6.4 | 记忆关闭时，不向 LLM 注册 USER.md/MEMORY.md 相关的 write/edit 工具 | P0 |
| FR-6.5 | 保留 Settings 中 "Enable Memory by Default" 设置，控制新 tab 默认值 | P0 |
| FR-6.6 | per-conversation 记忆状态隔离（不同 tab 可独立开关） | P0 |

### FR-4：文件操作工具

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-4.1 | 实现 `read` 工具：读取工作区内的文件内容 | P0 |
| FR-4.2 | 实现 `write` 工具：创建或覆盖文件，自动创建目录 | P0 |
| FR-4.3 | 实现 `edit` 工具：精确查找替换文件局部内容 | P0 |
| FR-4.4 | 所有文件操作限制在工作区目录内（路径安全检查） | P0 |
| FR-4.5 | edit 工具支持模糊匹配（容忍空白差异）作为后备 | P2 |
| FR-4.6 | edit 工具在多重匹配时拒绝操作并返回清晰错误 | P0 |
| FR-4.7 | SOUL.md 的 write/edit 操作需要用户确认 | P0 |
| FR-4.8 | 三个工具注册为 LLM function calling 的 tool 定义 | P0 |

### FR-5：System Prompt 注入

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-5.1 | 每轮对话开始时始终从磁盘读取 SOUL.md | P0 |
| FR-5.2 | 记忆开启时，额外读取 USER.md 和 MEMORY.md | P0 |
| FR-5.3 | 按 SOUL → USER → MEMORY 顺序注入 system prompt | P0 |
| FR-5.4 | 超过单文件字符上限时按头70%+尾20%规则截断 | P0 |
| FR-5.5 | 文件缺失时跳过对应部分（不报错） | P0 |
| FR-5.6 | 根据文件状态和记忆开关动态生成引导指令 | P1 |

## 非功能需求

### NFR-1：性能

| ID | 需求 | 指标 |
|----|------|------|
| NFR-1.1 | 文件读取不应显著延迟对话响应 | 文件读取 + prompt 构建 < 50ms |
| NFR-1.2 | 文件写入不应阻塞 UI | write/edit 操作异步执行 |

### NFR-2：安全

| ID | 需求 |
|----|------|
| NFR-2.1 | 文件操作必须限制在工作区目录内 |
| NFR-2.2 | 不记录密码、密钥等敏感信息到文件 |
| NFR-2.3 | AI 修改 SOUL.md 需要用户确认 |
| NFR-2.4 | 路径遍历攻击（`../` 逃逸）必须被阻止 |

### NFR-3：用户体验

| ID | 需求 |
|----|------|
| NFR-3.1 | 文件操作对用户透明，不需要用户理解技术细节 |
| NFR-3.2 | AI 对文件的修改应该自然融入对话，不打断体验 |
| NFR-3.3 | 首次使用时 Onboarding 体验应流畅自然 |
| NFR-3.4 | 用户可以选择用中文或英文的默认模板 |

### NFR-4：可维护性

| ID | 需求 |
|----|------|
| NFR-4.1 | 文件格式使用纯 Markdown，用户/开发者可直接用任何编辑器打开 |
| NFR-4.2 | 默认模板可配置/替换，不硬编码在代码中 |
| NFR-4.3 | 截断参数可通过配置调整 |

## 验收标准

### 基础场景

- [ ] 首次启动应用后，`~/.app/workspace/` 下存在 SOUL.md 和 USER.md
- [ ] 与宠物对话时，宠物的回复风格与 SOUL.md 定义一致
- [ ] 告诉宠物"叫我小明"后，USER.md 中出现"小明"
- [ ] 告诉宠物"记住我明天有面试"后，MEMORY.md 中出现相关记忆
- [ ] 关闭应用重新打开，宠物仍记得用户名和之前的记忆
- [ ] 手动编辑 SOUL.md 修改性格后，宠物的回复风格随之改变
- [ ] 现有的 `longTimeMemory()` / `processMemory()` 调用链已完全移除
- [ ] 现有的 `pets.user_memory` 字段不再使用

### 记忆开关场景

- [ ] 记忆开启时，USER.md 和 MEMORY.md 的内容注入到 system prompt
- [ ] 记忆开启时，AI 可以调用 write/edit 工具更新 USER.md 和 MEMORY.md
- [ ] 记忆关闭时，system prompt 中不包含 USER.md 和 MEMORY.md 的内容
- [ ] 记忆关闭时，AI 无法调用 USER.md/MEMORY.md 的 write/edit 工具
- [ ] 记忆关闭时，SOUL.md 仍然正常注入（人格不受影响）
- [ ] 不同 tab 的记忆开关状态互不影响
- [ ] Settings 中 "Enable Memory by Default" 正确控制新 tab 的默认记忆状态

### 安全场景

- [ ] AI 尝试修改 SOUL.md 时弹出确认对话框
- [ ] AI 调用 read/write/edit 时无法访问工作区外的文件
- [ ] 路径参数包含 `../` 时操作被拒绝

### 边界场景

- [ ] SOUL.md 被删除后，宠物使用默认人格正常对话
- [ ] MEMORY.md 超过 20000 字符时，注入的内容被正确截断
- [ ] 三个文件同时不存在时，应用不崩溃，宠物可正常对话

## 实现阶段

| 阶段 | 内容 | 交付物 |
|------|------|--------|
| **Phase 1** | 文件读写模块 + read/write/edit 工具 | Rust 后端工作区文件操作命令 |
| **Phase 2** | System prompt 注入管道（替换现有 prompt 拼接逻辑） | 统一的 Prompt 构建器，废弃旧 4 分支代码 |
| **Phase 3** | SOUL.md + USER.md + MEMORY.md 集成 + 记忆开关联动 | 模板、创建逻辑、记忆按钮控制 USER.md/MEMORY.md 读写 |
| **Phase 4** | 移除旧系统（`longTimeMemory` / `processMemory` / `user_memory`） | 清理代码，确保无残留 |
| **Phase 5** | Onboarding 流程 | 首次对话引导体验 |
| **Phase 6** | UI 集成 | 文件查看/编辑界面、SOUL.md 确认对话框 |

每个阶段独立可测试，可以逐步交付。
