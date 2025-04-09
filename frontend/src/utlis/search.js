import https from 'https';

export async function searchDuckDuckGo(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&format=json`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.Abstract) {
      return data.Abstract;
    }

    if (data.RelatedTopics?.length) {
      // 返回第一个相关话题的简要描述
      const topic = data.RelatedTopics.find(t => t.Text);
      if (topic) return topic.Text;
    }

    return "No useful result found.";
  } catch (error) {
    console.error("DuckDuckGo API Error:", error);
    return "Error fetching result.";
  }
}