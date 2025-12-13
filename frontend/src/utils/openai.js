import OpenAI from "openai/index.mjs";
import { zodResponseFormat } from "openai/helpers/zod";
import { searchDuckDuckGo } from './search';
import { z } from "zod";
import { callGeminiLib, callGeminiLibStream, fetchGeminiModels } from './gemini';

// 定义 provider 对应的 URL 字典
const providerURLs = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  anthropic: "https://api.anthropic.com/v1",
  grok: "https://api.x.ai/v1"
};

const sanitizeMessages = (messages) => {
  return messages.map(msg => {
    if (Array.isArray(msg.content)) {
      const newContent = msg.content.map(part => {
        if (part.type === 'text') return part;
        if (part.type === 'image_url') return part;
        if (part.type === 'file_url') {
           // Convert file_url to text representation for now
           return { type: 'text', text: `\n[Attachment: ${part.file_url.url}]` };
        }
        return null;
      }).filter(Boolean);
      return { ...msg, content: newContent };
    }
    return msg;
  });
};

const StructuredResponseSchema = z.object({
  content: z.string(),
  mood: z.enum(["angry", "normal", "smile"]),
});

const MoodSchema = z.object({
  mood: z.enum(["angry", "normal", "smile"]),
});

// 定义不支持结构化输出的模型列表
const notSupportedModels = ["gpt-3.5-turbo", "gpt-4-turbo", "claude-3-7-sonnet-20250219", "deepseek-r1-searching","huihui_ai/gemma3-abliterated:4b"];

// 独立的情绪判断函数
const detectMood = async (messages, provider, apiKey, model, baseURL) => {
  // 构造一个新的 client 实例，避免干扰
  let url = baseURL;
  if (url === "default") {
    url = providerURLs[provider] || url;
  } else {
    if(url.slice(-1) == "/") {
      url += 'v1';
    } else {
      url += '/v1'
    }
  }

  const openai = new OpenAI({
    apiKey: apiKey,
    baseURL: url,
    dangerouslyAllowBrowser: true,
  });

  // 构造专门用于判断情绪的消息列表
  // 我们需要让模型根据当前的对话上下文（主要是用户的最后一句话）来判断助手应该有的情绪
  // 为了不破坏原有 messages 的结构（可能包含 system prompt），我们构建一个新的上下文
  const moodMessages = [
    ...messages,
    { 
      role: "system", 
      content: "Analyze the conversation context and the user's last message. Determine the appropriate mood for the assistant's response. Choose exactly one from: 'angry', 'normal', 'smile'. Return only the JSON object: {\"mood\": \"...\"}." 
    }
  ];

  try {
    if (notSupportedModels.includes(model)) {
      // 不支持结构化输出，使用普通对话并解析
      const completion = await openai.chat.completions.create({
        model: model,
        messages: sanitizeMessages(moodMessages),
        stream: false
      });
      const content = completion.choices[0]?.message?.content?.toLowerCase() || "";
      if (content.includes("angry")) return "angry";
      if (content.includes("smile")) return "smile";
      return "normal";
    } else {
      // 支持结构化输出
      const completion = await openai.beta.chat.completions.parse({
        model: model,
        messages: sanitizeMessages(moodMessages),
        response_format: zodResponseFormat(MoodSchema, "mood_response"),
      });
      return completion.choices[0]?.message?.parsed?.mood || "normal";
    }
  } catch (error) {
    console.warn("Mood detection failed, defaulting to normal:", error);
    return "normal";
  }
};

export const callOpenAILib = async (messages, provider, apiKey, model, baseURL) => {
  if (provider === 'gemini') {
    return await callGeminiLib(messages, apiKey, model);
  }

  // 直接使用传入的 apiKey 和 model 参数
  if (baseURL === "default") {
    baseURL = providerURLs[provider] || "https://api.openai.com/v1";
  } else {
    // baseURL += '/v1';
    if (!baseURL.endsWith("/v1") && !baseURL.endsWith("/v1/")) {
        if(baseURL.slice(-1) == "/") {
            baseURL += 'v1';
        } else {
            baseURL += '/v1'
        }
    }
  }
  const openai = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
    dangerouslyAllowBrowser: true,
  });

  try {
    // 并发执行：内容生成 + 情绪判断
    const moodPromise = detectMood(messages, provider, apiKey, model, baseURL === providerURLs[provider] ? "default" : baseURL.replace(/\/v1$/, ''));
    
    // 主回复生成（不再强制 schema，除非是特定需求，但这里为了保持一致性，我们改为普通文本生成）
    // 注意：原代码中 callOpenAILib 是非流式的，且使用了 StructuredResponseSchema。
    // 用户要求 "模型本身的回复应该是非schema的"。
    // 所以我们将 content 生成改为普通 chat completion。
    
    const contentPromise = openai.chat.completions.create({
        model: model,
        messages: sanitizeMessages(messages),
        stream: false
    });

    const [moodResult, contentResult] = await Promise.all([moodPromise, contentPromise]);
    
    const content = contentResult.choices[0]?.message?.content || "Error: Empty response";

    return {
        content: content,
        mood: moodResult
    };

  } catch (error) {
    const fakeChatCompletion = {
      choices: [
        {
          message: {
            parsed: {
              content: error.message,
              mood: "normal"
            }
          }
        }
      ]
    };
    // 保持原有错误处理结构，虽然现在我们不再直接返回 parsed
    return { content: error.message, mood: "normal" };
  }
};

export const callOpenAILibStream = async (messages, provider, apiKey, model, baseURL, onChunk, abortSignal) => {
  if (provider === 'gemini') {
    return await callGeminiLibStream(messages, apiKey, model, onChunk, abortSignal);
  }

  // 直接使用传入的 apiKey 和 model 参数
  let url = baseURL;
  if (url === "default") {
    url = providerURLs[provider] || "https://api.openai.com/v1";
  } else {
    // baseURL += '/v1';
    if (!url.endsWith("/v1") && !url.endsWith("/v1/")) {
        if(url.slice(-1) == "/") {
            url += 'v1';
        } else {
            url += '/v1'
        }
    }
  }

  const openai = new OpenAI({
    apiKey: apiKey,
    baseURL: url,
    dangerouslyAllowBrowser: true,
  });

  try {
    // 启动并发的情绪判断
    // 注意：这里传入原始 baseURL (未加 v1 的)，因为 detectMood 内部会处理
    const moodPromise = detectMood(messages, provider, apiKey, model, baseURL);

    const stream = await openai.chat.completions.create({
      model: model,
      messages: sanitizeMessages(messages),
      stream: true,
    }, { signal: abortSignal });

    let fullContent = "";

    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
         break;
      }
      const content = chunk.choices[0]?.delta?.content || "";
      if (content) {
        fullContent += content;
        if (onChunk) {
            onChunk(content);
        }
      }
    }
    
    // 等待情绪判断完成
    // 按照需求：每次等问题回答完了再更新表情
    // 这里我们在流式传输结束后，再等待 moodPromise，确保返回时 mood 已经就绪
    const mood = await moodPromise;
    
    return {
        content: fullContent,
        mood: mood
    };

  } catch (error) {
    if (error.name === 'AbortError') {
        console.log('Stream aborted');
        return {
            content: fullContent || "Aborted", // Return what we have so far
            mood: "normal"
        };
    }
    console.error("Streaming error:", error);
    return {
        content: "Error: " + error.message,
        mood: "normal"
    };
  }
};

export const refinedSearchFromPrompt = async (
  userPrompt,
  provider,
  apiKey,
  model,
  baseURL
) => {
  // 步骤 1：调用 LLM 提取关键词
  const messages = [
    {
      role: "system",
      content: "你是一个关键词压缩器。用户会给出一句话，请你从中提炼出最核心的一个关键词并且改正拼写（英语），如果是非英语则返回英语，只返回关键词，不加任何解释。",
    },
    {
      role: "user",
      content: userPrompt
    }
  ];
  // 直接使用传入的 apiKey 和 model 参数
  if (baseURL === "default") {
    baseURL = providerURLs[provider] || baseURL;
  } else {
    // baseURL += '/v1';
    if(baseURL.slice(-1) == "/") {
      baseURL += 'v1';
    } else {
      baseURL += '/v1'
    }
  }
  const openai = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
    dangerouslyAllowBrowser: true,
  });
  const chatCompletion = await openai.chat.completions.create({
    model: model,
    messages: messages,
  });
  return chatCompletion.choices[0].message.content
};



export const callCommand = async (messages, provider, apiKey, model, baseURL) => {
  // 直接使用传入的 apiKey 和 model 参数
  if (baseURL === "default") {
    baseURL = providerURLs[provider] || baseURL;
  } else {
    if(baseURL.slice(-1) == "/") {
      baseURL += 'v1';
    } else {
      baseURL += '/v1'
    }
  }
  const openai = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
    dangerouslyAllowBrowser: true,
  });

  try {
    const chatCompletion = await openai.chat.completions.create({
      model: model,
      messages: [
        {
          role: 'system',
          content: `你是终端命令专家。只输出可直接复制粘贴到macOS终端执行的一条或多条命令，不含任何前缀、后缀或说明。不要使用代码块，不要使用任何标记，不要添加任何解释。如果涉及到编写代码文件请使用heredoc；不要输出任何自然语言内容。

要求写文件时候的样例（不要用在执行程序上了）：
cat <<EOF
多行文本内容
可以包含变量、命令替换等
EOF
不要忘记EOF！！！
(编写完文件之后再运行其他命令(比如运行编写好的程序，打开文件这类)， 不要弄混了， 谢谢)

如果让你编写word文档或者pdf， 就先用md写， 写好后用pandoc转换即可`
        },
        ...messages
      ],
      temperature: 0.2
    });
    const explainCode = await openai.chat.completions.create({
      model: model,
      messages: [
        {
          role: 'system',
          content: `explain those macOS terminal codes shortly.
for example:
step 1: xxx
step 2: xxx
step 3: xxx`
        },
        { role: 'user', content: chatCompletion.choices[0].message.content }
      ]
    });
    return {
      excution: chatCompletion.choices[0].message.content,
      content: explainCode.choices[0].message.content,
      mood: "normal"
    }
  } catch (error) {
    console.error("OpenAI 请求出错：", error);
    return error;
  }
};

const LongTermMemoryResponseSchema = z.object({
  isImportant: z.boolean(),
  score: z.number(), // ⚠️ 移除 .min(0).max(1)
  key: z.string(),
  value: z.string(),
});

export const longTimeMemory = async (message, provider, apiKey, model, baseURL) => {
  if (baseURL === "default") {
    baseURL = providerURLs[provider] || baseURL;
  } else {
    if(baseURL.slice(-1) == "/") {
      baseURL += 'v1';
    } else {
      baseURL += '/v1'
    }
  }

  const openai = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
    dangerouslyAllowBrowser: true,
  });

  const notSupportedModels = ["gpt-3.5-turbo", "gpt-4-turbo", "grok-2-latest", "grok-vision-beta", "grok-2-1212"];

  const prompt = `你是一个用户记忆提取器，只需要判断下面这句话是否值得被长期记住，并给出重要性评分（0 到 1 之间）：\n\n“${message}”\n\n返回如下 JSON 格式：\n{ "isImportant": true/false, "score": 0.xx, "key":"Name（sample）", "value":"Jules(sample)" }`;

  try {
    if (notSupportedModels.includes(model)) {
      // 不支持结构化输出，使用普通方式
      const chatCompletion = await openai.chat.completions.create({
        model: model,
        messages: [
          { role: "system", content: "你是一个逻辑判断机器人，用于提取对话中的重要信息（如用户的个人信息（姓名、职业、学校、公司等）），或者用户想让你（记住）的事情。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.1
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
          { role: "system", content: "你是一个逻辑判断机器人，用于提取对话中的重要信息（如用户的个人信息），或者用户想让你长期（记住）的事情，如果只是短期要求则不记住。只有陈述句并且有主语的句子值得记住" },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        response_format: zodResponseFormat(LongTermMemoryResponseSchema, "response"),
      });

      return chatCompletion.choices[0].message.parsed;
    }
  } catch (error) {
    console.error("OpenAI 请求出错：", error);
    return error;
  }
};

export const processMemory = async (configStr, provider, apiKey, model, baseURL) => {
  if (baseURL === "default") {
    baseURL = providerURLs[provider] || baseURL;
  } else {
    if(baseURL.slice(-1) == "/") {
      baseURL += 'v1';
    } else {
      baseURL += '/v1'
    }
  }
  
  const openai = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
    dangerouslyAllowBrowser: true,
  });
  
  // 解析配置
  let config;
  try {
    config = JSON.parse(configStr);
  } catch (e) {
    console.error("解析配置数据出错：", e);
    return { error: "配置数据格式错误" };
  }
  
  const notSupportedModels = ["gpt-3.5-turbo", "gpt-4-turbo", "grok-2-latest", "grok-vision-beta", "grok-2-1212"];
  const prompt = `分析这个用户配置并生成关于用户的记忆：\n\n${JSON.stringify(config, null, 2)}\n\n返回一段描述用户偏好和设置的文本。`;
  
  try {
    // 所有模型使用同一种方式调用
    const chatCompletion = await openai.chat.completions.create({
      model: model,
      messages: [
        { role: "system", content: "你是一个用户记忆生成助手，根据用户的配置信息生成对用户的理解和记忆。对于用户，你应当使用第三人称单数，（他｜她）是XXX，（他｜她）的爱好是XXX，（他｜她）和你之间的关系是XXX" },
        { role: "user", content: prompt },
      ],
      temperature: 0.1
    });
    
    return chatCompletion.choices[0].message.content;
  } catch (error) {
    console.error("OpenAI 请求出错：", error);
    return `处理记忆时出错: ${error.message}`;
  }
};

export const promptSuggestion = async (messages, provider, apiKey, model, baseURL) => {
  if (baseURL === "default") {
    baseURL = providerURLs[provider] || baseURL;
  } else {
    if(baseURL.slice(-1) == "/") {
      baseURL += 'v1';
    } else {
      baseURL += '/v1'
    }
  }

  const openai = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
    dangerouslyAllowBrowser: true,
  });

  const prompt = `User：\n“${messages.user}”\nAssistant：\n”${messages.assistant}“`;

  try {
      const chatCompletion = await openai.chat.completions.create({
        model: model,
        messages: [
          { role: "system", content: "你是一个prompt生成机器人，根据用户提供的内容生成1到3个不同的启发性提示，每个提示为一句话，并用“|”符号分隔。请直接返回提示文本，不要包含其他内容或任何解释说明也不要包含双引号。回复时请根据用户输入的语言自动选择回复语言，不要固定为中文或其他特定语言。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.7
      });

      try {
        return chatCompletion.choices[0].message.content
      } catch (e) {
        return e;
      }
  } catch (error) {
    console.error("OpenAI 请求出错：", error);
    return error;
  }
};

export const fetchModels = async (provider, apiKey, baseURL) => {
  if (provider === 'gemini') {
    return await fetchGeminiModels(apiKey);
  }

  let url = baseURL;
  if (url === "default") {
    url = providerURLs[provider] || "https://api.openai.com/v1";
  } else {
    // Simple check to avoid double v1 if possible, but sticking to existing logic for now to be safe
    // or better: check if it already ends in /v1
    if (!url.endsWith("/v1") && !url.endsWith("/v1/")) {
        if(url.slice(-1) == "/") {
            url += 'v1';
        } else {
            url += '/v1'
        }
    }
  }

  const openai = new OpenAI({
    apiKey: apiKey,
    baseURL: url,
    dangerouslyAllowBrowser: true,
  });

  try {
    const list = await openai.models.list();
    return list.data;
  } catch (error) {
    console.error("Error fetching models:", error);
    throw error;
  }
};