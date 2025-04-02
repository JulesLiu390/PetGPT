import { callCommand } from "./openai.js";

(async () => {
  const messages = [
    { role: "user", content: "写一个计算1000以内素数的python程序" }
  ];
  const provider = "openai";
  const model = "gpt-4o";
  const baseURL = "default";

  const result = await callCommand(messages, provider, apiKey, model, baseURL);
  console.log(result);
})();