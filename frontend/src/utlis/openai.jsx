import OpenAI from "openai/index.mjs";
const openai = new OpenAI({
  apiKey: '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',
  dangerouslyAllowBrowser: true, 
});

export const callOpenAI = async (messages) => {
  try {
    const chatCompletion = await openai.chat.completions.create({
      // messages: [{ role: "user", content: userInput }],
      model: "gpt-3.5-turbo",
      messages: messages,
    });

    return chatCompletion.choices[0].message.content;
  } catch (error) {
    console.error("OpenAI 请求出错：", error);
    return "出错啦，请稍后再试～";
  }
};