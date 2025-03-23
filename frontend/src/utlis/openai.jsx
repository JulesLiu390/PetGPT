import OpenAI from "openai/index.mjs";

export const callOpenAI = async (messages, apiKey, model) => {
  // 直接使用传入的 apiKey 和 model 参数
  const openai = new OpenAI({
    apiKey: apiKey,
    dangerouslyAllowBrowser: true,
  });

  try {
    const chatCompletion = await openai.chat.completions.create({
      model: model,
      messages: messages,
    });
    return chatCompletion.choices[0].message.content;
  } catch (error) {
    console.error("OpenAI 请求出错：", error);
    alert(error)
    return "出错啦，请稍后再试～";
  }
};