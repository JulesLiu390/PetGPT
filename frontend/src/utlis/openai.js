import OpenAI from "openai/index.mjs";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const StructuredResponseSchema = z.object({
  content: z.string(),
  mood: z.enum(["angry", "normal", "smile"]),
});

// 定义不支持结构化输出的模型列表
const notSupportedModels = ["gpt-3.5-turbo", "gpt-4-turbo"];

export const callOpenAI = async (messages, apiKey, model, baseURL) => {
  // 直接使用传入的 apiKey 和 model 参数
  if(baseURL == "default") {
    baseURL = "https://api.openai.com/v1"
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

export const callGemini = async (messages, apiKey, model) => {
  // Gemini API 的兼容性端点
  const geminiBaseURL = "https://generativelanguage.googleapis.com/v1beta/openai";

  const openai = new OpenAI({
      apiKey: apiKey,
      baseURL: geminiBaseURL,
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
      console.error("Gemini 请求出错：", error);
      return error;
  }
};