import OpenAI from "openai/index.mjs";
const openai = new OpenAI({
  apiKey: import.meta.env.VITE_OPENAI_API,
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