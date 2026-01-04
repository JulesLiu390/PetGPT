import bridge from './bridge.js';

// Helper to convert OpenAI messages to Gemini contents
const convertMessagesToGemini = async (messages) => {
  const contents = [];
  let systemInstruction = null;

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Gemini 1.5 supports systemInstruction, but for broader compatibility 
      // or if using older models, we might need to handle it differently.
      // Here we'll try to use the systemInstruction field if possible, 
      // but the REST API structure puts it at the top level, not in contents.
      systemInstruction = {
        role: "user", 
        parts: [{ text: msg.content }] 
      };
      // Note: Ideally system instruction is a separate field. 
      // For simplicity in this adapter, if we treat it as a separate field, we return it.
      // However, to keep the function signature simple, let's return it as a property.
    } else {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      let parts = [];
      
      if (Array.isArray(msg.content)) {
        // Handle multimodal (text + image/video/audio/documents)
        for (const part of msg.content) {
            if (part.type === 'text') {
                parts.push({ text: part.text });
            } else if (part.type === 'image_url') {
                // OpenAI: { url: "data:image/jpeg;base64,..." }
                // Gemini: { inline_data: { mime_type: "...", data: "..." } }
                const url = part.image_url.url;
                if (url.startsWith('data:')) {
                    const match = url.match(/^data:(.*?);base64,(.*)$/);
                    if (match) {
                        parts.push({
                            inline_data: {
                                mime_type: match[1],
                                data: match[2]
                            }
                        });
                    }
                } else if (bridge?.readUpload) {
                    // Load from file path
                    try {
                        const fileName = url.split('/').pop();
                        const base64Data = await bridge.readUpload(fileName);
                        const match = base64Data.match(/^data:(.*?);base64,(.*)$/);
                        if (match) {
                            parts.push({
                                inline_data: {
                                    mime_type: match[1],
                                    data: match[2]
                                }
                            });
                        }
                    } catch (err) {
                        console.error('Failed to load image for Gemini:', err);
                        parts.push({ text: `[Image: ${url}]` });
                    }
                }
            } else if (part.type === 'file_url') {
                const fileUrl = part.file_url?.url;
                const mimeType = part.file_url?.mime_type;
                
                // Try to load file data
                if (bridge?.readUpload && fileUrl) {
                    try {
                        const fileName = fileUrl.split('/').pop();
                        const base64Data = await bridge.readUpload(fileName);
                        const match = base64Data.match(/^data:(.*?);base64,(.*)$/);
                        if (match) {
                            // Gemini supports: images, audio, video, PDF
                            // For documents like .doc/.docx, we can only send as text reference
                            const fileMime = match[1];
                            const isSupported = fileMime.startsWith('image/') || 
                                               fileMime.startsWith('audio/') || 
                                               fileMime.startsWith('video/') ||
                                               fileMime === 'application/pdf';
                            
                            if (isSupported) {
                                parts.push({
                                    inline_data: {
                                        mime_type: match[1],
                                        data: match[2]
                                    }
                                });
                            } else {
                                // Unsupported file type - just add as text reference
                                parts.push({ text: `[Attachment: ${part.file_url?.name || fileName}]` });
                            }
                        }
                    } catch (err) {
                        console.error('Failed to load file for Gemini:', err);
                        parts.push({ text: `[Attachment: ${part.file_url?.name || fileUrl}]` });
                    }
                } else {
                    parts.push({ text: `[Attachment: ${part.file_url?.name || fileUrl}]` });
                }
            }
        }
      } else {
        parts = [{ text: msg.content }];
      }

      contents.push({
        role: role,
        parts: parts
      });
    }
  }

  return { contents, systemInstruction };
};

export const callGeminiLib = async (messages, apiKey, model = "gemini-1.5-flash") => {
  try {
    const { contents, systemInstruction } = await convertMessagesToGemini(messages);
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    
    const body = {
      contents: contents,
      generationConfig: {
        temperature: 0.7
      }
    };

    if (systemInstruction) {
        // For models that support system_instruction (Gemini 1.5+)
        // The field is system_instruction
        body.system_instruction = {
            parts: systemInstruction.parts
        };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || `Gemini API Error: ${response.statusText}`);
    }

    const data = await response.json();
    
    // Extract text from response
    // Response structure: candidates[0].content.parts[0].text
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    
    return {
      content: text,
      mood: "normal" // Gemini doesn't support our mood detection logic natively yet without extra calls
    };

  } catch (error) {
    console.error("Gemini API Call Error:", error);
    return {
      content: `Error: ${error.message}`,
      mood: "normal"
    };
  }
};

export const callGeminiLibStream = async (messages, apiKey, model = "gemini-1.5-flash", onChunk, abortSignal) => {
  try {
    const { contents, systemInstruction } = await convertMessagesToGemini(messages);
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    
    const body = {
      contents: contents,
      generationConfig: {
        temperature: 0.7
      }
    };

    if (systemInstruction) {
        body.system_instruction = {
            parts: systemInstruction.parts
        };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: abortSignal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Gemini API Error: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // SSE format parsing
      // Gemini SSE sends "data: <json>\n\n"
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          try {
            const data = JSON.parse(jsonStr);
            const textChunk = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (textChunk) {
              fullText += textChunk;
              // 传增量 textChunk，因为 reducer 是 append 模式
              if (onChunk) onChunk(textChunk);
            }
          } catch (e) {
            // Ignore parse errors for intermediate chunks
          }
        }
      }
    }

    return {
      content: fullText,
      mood: "normal"
    };

  } catch (error) {
    if (error.name === 'AbortError') {
        return { content: "Aborted", mood: "normal" };
    }
    console.error("Gemini Stream Error:", error);
    return {
      content: `Error: ${error.message}`,
      mood: "normal"
    };
  }
};

export const fetchGeminiModels = async (apiKey) => {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Gemini API Error: ${response.statusText}`);
    }
    const data = await response.json();
    // data.models is an array of objects like { name: "models/gemini-pro", ... }
    // We want to return a list of objects with 'id' property to match OpenAI format
    return (data.models || []).map(m => ({
      id: m.name.replace('models/', ''), // remove 'models/' prefix for cleaner ID
      ...m
    }));
  } catch (error) {
    console.error("Error fetching Gemini models:", error);
    throw error;
  }
};
