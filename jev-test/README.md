# Jev 测试沙盒

试 TypeSafe 的 Jev（System One 模型）能不能用在 PetGPT 上。独立目录，不碰主项目代码。

## 用法

```bash
cp .env.example .env     # 填入 TYPESAFE_API_KEY
node 1-smoke.mjs         # key 通不通 + 三种题型长什么样
node 2-intent-replay.mjs # 用真实群聊场景对照 Intent 的决策
```

Node 18+ 即可，无依赖（用原生 fetch）。

## Jev 跟 LLM 的区别

不发 messages、不收字符串。给一段 `state`（材料）和一组 `questions`，
它**并行独立地**对同一份 state 回答每个问题，返回类型化的值 + 校准概率。
答案跑不出你预先声明的 schema——所以它设计上不会"幻觉出一个不存在的选项"。

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <key>

{
  "state": "要判断的材料",
  "model": "jev-latest",
  "questions": {
    "名字": { "type": "choice|score|noul", "instructions": "...", "criteria": ... }
  }
}
```

三种题型：

| type | criteria | 返回 |
|---|---|---|
| `choice` | `{选项: 含义}` | `{choice, probabilities, confidence}` |
| `score` | `[低, 中, 高]` 刻度说明 | `{score, legend, confidence}` |
| `noul` | 不需要 | `{noul}` — 0~1 的概率 |

## 为什么值得试

PetGPT 的 **Intent loop** 本质上就是三个判断：要不要回、回多重、多相关。
正好是 noul / choice / score 各一个，一次调用全出来。

两处实测痛点：

**1. 类型错误真实发生过**（2026-09-19 06:05:29 日志）

```
write_intent_plan ❌ Error: brief 第 1 行必须且只能是档位标签：
[接梗] / [闲扯] / [观点] / [展开] / [深答]
```

LLM 吐了不合 schema 的东西被拒、重试。Jev 声称这类错误在设计上不可能。

**2. Intent 慢到被群聊甩开**

单轮 6–36 秒，于是日志里全是：

```
+1 new msg during eval → re-eval
🛑 intercept write_intent_plan: 3 条新消息
```

Jev 官方数字是 70–500ms。

## 已知的坎

- **上下文只有 32K**（state + 最长问题；全部合计 64K）。线上 Intent 现在喂
  90k–247k tokens，差一个数量级。要用必须先砍输入——而被砍掉的人物档案和
  历史摘要，恰恰是它判断"这条该不该接"的依据。质量掉多少是未知数。
- **只做决策，不生成文本**。Reply 那层（写回复内容）和 Observer（写群档案）
  都替代不了，只有 Intent 的决策部分能换。
- 单阶段 choice 的基数上限 255（PetGPT 的 5 个档位远低于此，无影响）。
- 官方自己承认 benchmark 偏向：对比 demo 输入"高度简化"，评测 workflow 由
  自家团队构建，结论是"真实收益的上限"。40–200x 要打折看。
- 发布于 2026-09-16，没有第三方长期实测。

## 如果要真上

别直接替换。建议的路子是**拆分**而不是替换：

```
Intent 决策（要不要回 / 什么档位）  → Jev      70–500ms
Reply 生成（具体写什么）            → LLM 不变
Observer 写档案                     → LLM 不变
```

先用 `2-intent-replay.mjs` 扩样本量（几十个场景），看一致率和不一致的都是什么情况，
再决定要不要接线。
