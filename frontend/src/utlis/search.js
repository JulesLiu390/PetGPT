export async function searchDuckDuckGo(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    let result = '';

    if (data.Heading) {
      result += ` ${data.Heading}\n`;
    }

    if (data.Abstract) {
      result += `Abstract: ${data.Abstract}\n`;
    }

    if (data.Answer) {
      result += `Answer: ${data.Answer}\n`;
    }

    if (data.Definition) {
      result += `Definition: ${data.Definition}\n`;
    }

    if (Array.isArray(data.RelatedTopics) && data.RelatedTopics.length) {
      const topRelated = data.RelatedTopics
        .flatMap(t => {
          if (t.Text) return [t];
          if (t.Topics) return t.Topics.filter(sub => sub.Text);
          return [];
        })
        .slice(0, 3)
        .map(t => `• ${t.Text}${t.FirstURL ? `\n   ${t.FirstURL}` : ''}`)
        .join('\n');
      result += ` Related Topics:\n${topRelated}\n`;
    }

    if (!result) {
      result = "No useful result found.";
    }

    return result.trim();
  } catch (error) {
    console.error("DuckDuckGo API Error:", error);
    return "Error fetching result.";
  }
}