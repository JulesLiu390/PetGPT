/**
 * Jev（TypeSafe System One）最小客户端。
 *
 * 刻意不装 SDK：整个 API 就是一个 POST，用 Node 自带的 fetch 就够了。
 * 最终如果要接进 PetGPT，也是 JS 这边直接调，不会引 Python 依赖。
 *
 * 与 LLM 的根本区别：不发 messages、不收字符串。你给一段 `state`（要判断的
 * 材料）和一组 `questions`（每个问题预先声明好可能的输出），它并行地对同一份
 * state 独立回答所有问题，返回带校准概率的类型化值。schema 之外的答案它给不出来。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** 读 .env（只认最简单的 KEY=VALUE，不引 dotenv） */
export const loadEnv = () => {
  const env = {};
  try {
    for (const line of readFileSync(join(HERE, '.env'), 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // 没有 .env 就退回进程环境变量
  }
  return { ...env, ...process.env };
};

/**
 * 问 Jev 一组问题。
 *
 * @param state     被判断的材料（一段文本）
 * @param questions { [名字]: { type: 'choice'|'score'|'noul', instructions, criteria? } }
 *                  - choice: criteria 是 { 选项: 该选项的含义 }
 *                  - score:  criteria 是刻度说明数组，从低到高
 *                  - noul:   不需要 criteria，返回 0–1 的概率
 * @returns { answers, usage, latencyMs }
 */
export const ask = async (state, questions, { model, apiKey, signal } = {}) => {
  const env = loadEnv();
  const key = apiKey || env.TYPESAFE_API_KEY;
  if (!key || key.startsWith('sk-...')) {
    throw new Error('缺少 TYPESAFE_API_KEY —— 把 .env.example 复制成 .env 并填入');
  }

  const started = Date.now();
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      state,
      model: model || env.JEV_MODEL || 'jev-latest',
      questions,
    }),
    signal,
  });

  const text = await resp.text();
  if (!resp.ok) {
    // 原样带出响应体：认证/额度/schema 报错的细节都在里面，吞掉会很难查
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 400)}`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON: ${text.slice(0, 200)}`);
  }
  return { ...body, latencyMs: Date.now() - started };
};

/** 把一次回答打印成人能看的形状 */
export const printAnswers = (result, { indent = '  ' } = {}) => {
  const { answers = {}, usage = {}, latencyMs } = result;
  for (const [name, a] of Object.entries(answers)) {
    if ('choice' in a) {
      const probs = Object.entries(a.probabilities || {})
        .sort((x, y) => y[1] - x[1])
        .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
        .join(', ');
      console.log(`${indent}${name}: ${a.choice}  (置信 ${fmt(a.confidence)})`);
      if (probs) console.log(`${indent}   分布: ${probs}`);
    } else if ('score' in a) {
      console.log(`${indent}${name}: ${a.score?.toFixed?.(2) ?? a.score}  (置信 ${fmt(a.confidence)})`);
    } else if ('noul' in a) {
      console.log(`${indent}${name}: ${(a.noul * 100).toFixed(1)}%`);
    } else {
      console.log(`${indent}${name}: ${JSON.stringify(a)}`);
    }
  }
  console.log(`${indent}— ${latencyMs}ms, in=${usage.input_tokens ?? '?'} out=${usage.output_tokens ?? '?'}`);
};

const fmt = (v) => (typeof v === 'number' ? v.toFixed(3) : String(v));

export default { ask, loadEnv, printAnswers };
