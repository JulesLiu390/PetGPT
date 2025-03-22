const API_BASE_URL = 'http://localhost:3001/api';

// AI Routes
export const generateText = async (prompt, options) => {
  const response = await fetch(`${API_BASE_URL}/ai/text`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt, options }),
  });
  return response.json();
};

export const generateChatResponse = async (history, options) => {
  const response = await fetch(`${API_BASE_URL}/ai/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ history, options }),
  });
  return response.json();
};

export const generateImage = async (prompt, model = 'dalle', options = {}) => {
  const response = await fetch(`${API_BASE_URL}/ai/image`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt, model, options }),
  });
  return response.json();
};

export const generateImageVariations = async (imageUrl, model = 'dalle', options = {}) => {
  const response = await fetch(`${API_BASE_URL}/ai/image/variations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ imageUrl, model, options }),
  });
  return response.json();
};

export const generatePetChatResponse = async (petId, message, options = {}) => {
  const response = await fetch(`${API_BASE_URL}/ai/pet/${petId}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, options }),
  });
  return response.json();
};

export const generatePetImage = async (petId, prompt, model = 'dalle', options = {}) => {
  const response = await fetch(`${API_BASE_URL}/ai/pet/${petId}/image`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt, model, options }),
  });
  return response.json();
};

// Conversation Routes
export const createConversation = async (conversationData) => {
  const response = await fetch(`${API_BASE_URL}/conversations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(conversationData),
  });
  return response.json();
};

export const getPetConversations = async (petId) => {
  const response = await fetch(`${API_BASE_URL}/conversations/pet/${petId}`);
  return response.json();
};

export const getRecentConversations = async (limit = 10, page = 1) => {
  const response = await fetch(`${API_BASE_URL}/conversations/recent?limit=${limit}&page=${page}`);
  return response.json();
};

export const getConversation = async (conversationId) => {
  const response = await fetch(`${API_BASE_URL}/conversations/${conversationId}`);
  return response.json();
};

export const addMessageToConversation = async (conversationId, messageData) => {
  const response = await fetch(`${API_BASE_URL}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(messageData),
  });
  return response.json();
};

export const deleteConversation = async (conversationId) => {
  const response = await fetch(`${API_BASE_URL}/conversations/${conversationId}`, {
    method: 'DELETE',
  });
  return response.json();
};

// Pet Routes
export const createPet = async (petData) => {
  const response = await fetch(`${API_BASE_URL}/pets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(petData),
  });
  return response.json();
};

export const getPets = async () => {
  const response = await fetch(`${API_BASE_URL}/pets`);
  return response.json();
};

export const getPet = async (petId) => {
  const response = await fetch(`${API_BASE_URL}/pets/${petId}`);
  return response.json();
};

export const updatePet = async (petId, petData) => {
  const response = await fetch(`${API_BASE_URL}/pets/${petId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(petData),
  });
  return response.json();
};

export const updatePetPersonality = async (petId, personalityData) => {
  const response = await fetch(`${API_BASE_URL}/pets/${petId}/personality`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(personalityData),
  });
  return response.json();
};

export const deletePet = async (petId) => {
  const response = await fetch(`${API_BASE_URL}/pets/${petId}`, {
    method: 'DELETE',
  });
  return response.json();
};
