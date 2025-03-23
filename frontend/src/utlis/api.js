const API_BASE_URL = 'http://localhost:3001/api';

// ------------------------------
// AI Routes
// ------------------------------

export const generateText = async (prompt, options) => {
  const response = await fetch(`${API_BASE_URL}/ai/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, options }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to generate text');
  }
  return response.json();
};

export const generateChatResponse = async (history, options) => {
  const response = await fetch(`${API_BASE_URL}/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ history, options }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to generate chat response');
  }
  return response.json();
};

export const generateImage = async (prompt, model = 'dalle', options = {}) => {
  const response = await fetch(`${API_BASE_URL}/ai/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, model, options }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to generate image');
  }
  return response.json();
};

export const generateImageVariations = async (imageUrl, model = 'dalle', options = {}) => {
  const response = await fetch(`${API_BASE_URL}/ai/image/variations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl, model, options }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to generate image variations');
  }
  return response.json();
};

export const generatePetChatResponse = async (petId, message, options = {}) => {
  const response = await fetch(`${API_BASE_URL}/ai/pet/${petId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, options }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to generate pet chat response');
  }
  return response.json();
};

export const generatePetImage = async (petId, prompt, model = 'dalle', options = {}) => {
  const response = await fetch(`${API_BASE_URL}/ai/pet/${petId}/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, model, options }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to generate pet image');
  }
  return response.json();
};

// ------------------------------
// Conversation Routes
// ------------------------------

export const createConversation = async (petId, title, history) => {
  // 确保 petId 是字符串
  const finalPetId = typeof petId === 'string' ? petId : '';
  // 确保 title 是字符串
  const finalTitle = typeof title === 'string' ? title : '';
  // 确保 history 是数组
  const finalHistory = Array.isArray(history) ? history : [];

  const conversationData = {
    petId: finalPetId,
    title: title,
    history: history
  };

  const response = await fetch(`${API_BASE_URL}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(conversationData),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to create conversation');
  }
  return response.json();
};

export const getPetConversations = async (petId) => {
  const response = await fetch(`${API_BASE_URL}/conversations/pet/${petId}`);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to get pet conversations');
  }
  return response.json();
};

export const getRecentConversations = async (limit = 10, page = 1) => {
  const response = await fetch(`${API_BASE_URL}/conversations/recent?limit=${limit}&page=${page}`);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to get recent conversations');
  }
  return response.json();
};

export const getConversation = async (conversationId) => {
  const response = await fetch(`${API_BASE_URL}/conversations/${conversationId}`);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to get conversation');
  }
  return response.json();
};

export const addMessageToConversation = async (conversationId, messageData) => {
  const response = await fetch(`${API_BASE_URL}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(messageData),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to add message to conversation');
  }
  return response.json();
};

export const deleteConversation = async (conversationId) => {
  const response = await fetch(`${API_BASE_URL}/conversations/${conversationId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to delete conversation');
  }
  return response.json();
};

// ------------------------------
// Pet Routes
// ------------------------------

export const createPet = async (petData) => {
  const response = await fetch(`${API_BASE_URL}/pets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(petData),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to create pet');
  }
  return response.json();
};

export const getPets = async () => {
  const response = await fetch(`${API_BASE_URL}/pets`);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to get pets');
  }
  return response.json();
};

export const getPet = async (petId) => {
  const response = await fetch(`${API_BASE_URL}/pets/${petId}`);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to get pet');
  }
  return response.json();
};

export const updatePet = async (petId, petData) => {
  const response = await fetch(`${API_BASE_URL}/pets/${petId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(petData),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to update pet');
  }
  return response.json();
};

export const updatePetPersonality = async (petId, personalityData) => {
  const response = await fetch(`${API_BASE_URL}/pets/${petId}/personality`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(personalityData),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to update pet personality');
  }
  return response.json();
};

export const deletePet = async (petId) => {
  const response = await fetch(`${API_BASE_URL}/pets/${petId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to delete pet');
  }
  return response.json();
};