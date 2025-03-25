import OpenAI from "openai/index.mjs";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const StructuredResponseSchema = z.object({
  content: z.string(),
  mood: z.enum(["angry", "normal", "smile"]),
});

export const callOpenAI = async (messages, apiKey, model) => {
  // 直接使用传入的 apiKey 和 model 参数
  const openai = new OpenAI({
    apiKey: apiKey,
    dangerouslyAllowBrowser: true,
  });


  try {
        // 使用 response_format 指定结构化输出
        const chatCompletion = await openai.beta.chat.completions.parse({
          model: model,
          messages: messages,
          response_format: zodResponseFormat(StructuredResponseSchema, "response"),
        });
        // 返回结构化后的 JSON 对象
        return chatCompletion.choices[0].message.parsed;
    // const chatCompletion = await openai.chat.completions.create({
    //   model: model,
    //   messages: messages,
    // });
    // return chatCompletion.choices[0].message.content;
  } catch (error) {
    console.error("OpenAI 请求出错：", error);
    // alert(error)
    return "出错啦，请稍后再试～";
  }
};