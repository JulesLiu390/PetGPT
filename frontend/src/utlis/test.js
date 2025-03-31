import OpenAI from 'openai';
import {callOpenAILib} from "./openai.js"

// 定义一个测试函数
const testCallOpenAILib = async () => {
    // 构造对话消息
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: '你好，测试一下qwen2.5:1.5b是否兼容OpenAI库' }
    ];
  
    // 使用你在配置中的参数
    const provider = 'openai';
    const apiKey = 'ollama';
    const model = 'qwen2.5:1.5b';
    const baseURL = 'http://localhost:11434'; // 注意：函数内部会自动添加 '/v1'
  
    try {
      const result = await callOpenAILib(messages, provider, apiKey, model, baseURL);
      console.log('测试返回结果：', result);
    } catch (error) {
      console.error('调用 callOpenAILib 出错：', error);
    }
  };
  
  // 执行测试函数
  testCallOpenAILib();

