import { callCommand } from "./openai.js";

(async () => {
  const messages = [
    { role: "user", content: "写一个计算1000以内素数的python程序" }
  ];
  const provider = "openai";
  const apiKey = "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";
  const model = "gpt-4o";
  const baseURL = "default";

  const result = await callCommand(messages, provider, apiKey, model, baseURL);
  console.log(result);
})();