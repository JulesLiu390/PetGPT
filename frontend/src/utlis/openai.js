import OpenAI from "openai/index.mjs";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const StructuredResponseSchema = z.object({
  content: z.string(),
  mood: z.enum(["angry", "normal", "smile"]),
});

// 定义不支持结构化输出的模型列表
const notSupportedModels = ["gpt-3.5-turbo", "gpt-4-turbo", "grok-2-latest", "grok-vision-beta", "grok-2-1212"];



export const callOpenAILib = async (messages, provider, apiKey, model, baseURL) => {
  // 直接使用传入的 apiKey 和 model 参数

  if(baseURL == "default") {
    if(provider == "openai") {
      baseURL = "https://api.openai.com/v1";
    } else if(provider == "gemini") {
      baseURL = "https://generativelanguage.googleapis.com/v1beta/openai"
    } else if(provider == "anthropic") {
      baseURL = "https://api.anthropic.com/v1"
    }
  } else {
    baseURL += '/v1'
  }
  const openai = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
    dangerouslyAllowBrowser: true,
  });

  try {
    if (notSupportedModels.includes(model)) {
      // 模型不支持结构化输出，采用普通调用并人工构造 JSON 回复，情绪默认 normal
      const chatCompletion = await openai.chat.completions.create({
        model: model,
        messages: messages,
      });
      return {
        content: chatCompletion.choices[0].message.content,
        mood: "normal",
      };
    } else {
      // 支持结构化输出
      const chatCompletion = await openai.beta.chat.completions.parse({
        model: model,
        messages: messages,
        response_format: zodResponseFormat(StructuredResponseSchema, "response"),
      });
      return chatCompletion.choices[0].message.parsed;
    }
  } catch (error) {
    console.error("OpenAI 请求出错：", error);
    return error;
  }
};


const LongTermMemoryResponseSchema = z.object({
  isImportant: z.boolean(),
  score: z.number(), // ⚠️ 移除 .min(0).max(1)
});

export const longTimeMemory = async (message, provider, apiKey, model, baseURL) => {
  if (baseURL === "default") {
    baseURL = provider === "openai"
      ? "https://api.openai.com/v1"
      : "https://generativelanguage.googleapis.com/v1beta/openai";
  } else {
    baseURL += "/v1";
  }

  const openai = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
    dangerouslyAllowBrowser: true,
  });

  const notSupportedModels = ["gpt-3.5-turbo", "gpt-4-turbo", "grok-2-latest", "grok-vision-beta", "grok-2-1212"];

  const prompt = `你是一个用户记忆提取器，只需要判断下面这句话是否值得被长期记住，并给出重要性评分（0 到 1 之间）：\n\n“${message}”\n\n返回如下 JSON 格式：\n{ "isImportant": true/false, "score": 0.xx }`;

  try {
    if (notSupportedModels.includes(model)) {
      // 不支持结构化输出，使用普通方式
      const chatCompletion = await openai.chat.completions.create({
        model: model,
        messages: [
          { role: "system", content: "你是一个逻辑判断机器人，用于提取对话中的长期重要信息。" },
          { role: "user", content: prompt },
        ],
      });

      const raw = chatCompletion.choices[0].message.content ?? "";
      try {
        return JSON.parse(raw);
      } catch (e) {
        console.error("解析 JSON 出错：", e);
        return { isImportant: false, score: 0.0, raw };
      }
    } else {
      // 支持结构化输出，使用 zodResponseFormat
      const chatCompletion = await openai.beta.chat.completions.parse({
        model: model,
        messages: [
          { role: "system", content: "你是一个逻辑判断机器人，用于提取对话中的长期重要信息。" },
          { role: "user", content: prompt },
        ],
        response_format: zodResponseFormat(LongTermMemoryResponseSchema, "response"),
      });

      return chatCompletion.choices[0].message.parsed;
    }
  } catch (error) {
    console.error("OpenAI 请求出错：", error);
    return error;
  }
};