/**
 * MCP Tool Converter
 * 
 * 将 MCP 工具格式转换为 LLM 提供商的函数调用格式
 * MCP 工具使用 JSON Schema，需要转换为各 LLM 的工具格式
 */

/**
 * 将 MCP 工具转换为 OpenAI 函数调用格式
 * 
 * MCP Tool 格式:
 * {
 *   name: string,
 *   description?: string,
 *   inputSchema: JSONSchema
 * }
 * 
 * OpenAI Tool 格式:
 * {
 *   type: "function",
 *   function: {
 *     name: string,
 *     description: string,
 *     parameters: JSONSchema
 *   }
 * }
 * 
 * @param {Array} mcpTools - MCP 工具数组
 * @returns {Array} OpenAI 格式的工具数组
 */
export const convertToOpenAITools = (mcpTools) => {
  if (!mcpTools || mcpTools.length === 0) {
    return [];
  }
  
  return mcpTools.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || `Tool: ${tool.name}`,
      parameters: tool.inputSchema || { type: "object", properties: {} }
    }
  }));
};

/**
 * 将 MCP 工具转换为 Gemini 函数声明格式
 * 
 * Gemini FunctionDeclaration 格式:
 * {
 *   name: string,
 *   description: string,
 *   parameters: {
 *     type: "OBJECT",
 *     properties: {...},
 *     required: [...]
 *   }
 * }
 * 
 * @param {Array} mcpTools - MCP 工具数组
 * @returns {Array} Gemini 格式的函数声明数组
 */
export const convertToGeminiTools = (mcpTools) => {
  if (!mcpTools || mcpTools.length === 0) {
    return [];
  }
  
  return mcpTools.map(tool => {
    const schema = tool.inputSchema || { type: "object", properties: {} };
    
    // Gemini 需要大写的类型名
    const convertType = (jsonSchemaType) => {
      const typeMap = {
        'object': 'OBJECT',
        'array': 'ARRAY',
        'string': 'STRING',
        'number': 'NUMBER',
        'integer': 'INTEGER',
        'boolean': 'BOOLEAN'
      };
      return typeMap[jsonSchemaType?.toLowerCase()] || 'STRING';
    };
    
    // 递归转换属性类型
    const convertProperties = (properties) => {
      if (!properties) return {};
      
      const result = {};
      for (const [key, value] of Object.entries(properties)) {
        result[key] = {
          type: convertType(value.type),
          description: value.description || ''
        };
        
        // 处理嵌套对象
        if (value.type === 'object' && value.properties) {
          result[key].properties = convertProperties(value.properties);
        }
        
        // 处理数组
        if (value.type === 'array' && value.items) {
          result[key].items = {
            type: convertType(value.items.type)
          };
        }
        
        // 处理枚举
        if (value.enum) {
          result[key].enum = value.enum;
        }
      }
      return result;
    };
    
    return {
      name: tool.name,
      description: tool.description || `Tool: ${tool.name}`,
      parameters: {
        type: 'OBJECT',
        properties: convertProperties(schema.properties),
        required: schema.required || []
      }
    };
  });
};

/**
 * 从 OpenAI 响应中解析工具调用
 * 
 * @param {Object} response - OpenAI API 响应
 * @returns {Array|null} 工具调用数组或 null
 */
export const parseOpenAIToolCalls = (response) => {
  const message = response.choices?.[0]?.message;
  
  if (!message?.tool_calls || message.tool_calls.length === 0) {
    return null;
  }
  
  return message.tool_calls.map(tc => ({
    id: tc.id,
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments || '{}')
  }));
};

/**
 * 从 Gemini 响应中解析函数调用
 * 
 * @param {Object} response - Gemini API 响应
 * @returns {Array|null} 函数调用数组或 null
 */
export const parseGeminiFunctionCalls = (response) => {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts;
  
  if (!parts) return null;
  
  const functionCalls = parts.filter(part => part.functionCall);
  
  if (functionCalls.length === 0) return null;
  
  return functionCalls.map((part, index) => ({
    id: `call_${index}`,
    name: part.functionCall.name,
    arguments: part.functionCall.args || {}
  }));
};

/**
 * 将工具执行结果格式化为 OpenAI 消息格式
 * 
 * @param {string} toolCallId - 工具调用 ID
 * @param {string} result - 工具执行结果
 * @returns {Object} OpenAI tool message
 */
export const formatOpenAIToolResult = (toolCallId, result) => ({
  role: "tool",
  tool_call_id: toolCallId,
  content: typeof result === 'string' ? result : JSON.stringify(result)
});

/**
 * 将工具执行结果格式化为 Gemini 消息格式
 * 
 * @param {string} name - 函数名
 * @param {*} result - 函数执行结果
 * @returns {Object} Gemini function response part
 */
export const formatGeminiFunctionResponse = (name, result) => ({
  functionResponse: {
    name: name,
    response: {
      result: typeof result === 'string' ? result : JSON.stringify(result)
    }
  }
});

/**
 * 创建包含工具调用的 assistant 消息（OpenAI 格式）
 * 
 * @param {Array} toolCalls - 工具调用数组
 * @returns {Object} Assistant message with tool_calls
 */
export const createOpenAIAssistantToolCallMessage = (toolCalls) => ({
  role: "assistant",
  content: null,
  tool_calls: toolCalls.map(tc => ({
    id: tc.id,
    type: "function",
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments)
    }
  }))
});

/**
 * 根据 apiFormat 选择合适的转换函数
 * 
 * @param {string} apiFormat - 'openai_compatible' | 'gemini_official'
 * @returns {Object} 转换函数集合
 */
export const getConverterForFormat = (apiFormat) => {
  if (apiFormat === 'gemini_official') {
    return {
      convertTools: convertToGeminiTools,
      parseToolCalls: parseGeminiFunctionCalls,
      formatToolResult: formatGeminiFunctionResponse
    };
  }
  
  return {
    convertTools: convertToOpenAITools,
    parseToolCalls: parseOpenAIToolCalls,
    formatToolResult: formatOpenAIToolResult,
    createAssistantToolCallMessage: createOpenAIAssistantToolCallMessage
  };
};

export default {
  convertToOpenAITools,
  convertToGeminiTools,
  parseOpenAIToolCalls,
  parseGeminiFunctionCalls,
  formatOpenAIToolResult,
  formatGeminiFunctionResponse,
  createOpenAIAssistantToolCallMessage,
  getConverterForFormat
};
