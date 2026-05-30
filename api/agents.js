export const config = { runtime: "edge" };

const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";

const AGENTS = {
  prompt_engineer: {
    model: "meta/llama-3.1-405b-instruct",
    name: "Prometheus",
    role: "You are Prometheus, an elite Prompt Engineer AI. Your ONLY job is to analyze the user's request and rewrite it as a crystal-clear, detailed technical specification for a coder AI. Output format: Start with '## ANALYSIS' (2-3 lines of what user wants), then '## ENHANCED PROMPT' (detailed spec with edge cases, requirements, tech stack suggestions). Be concise but thorough. No code, only specifications."
  },
  coder: {
    model: "qwen/qwen2.5-coder-32b-instruct",
    name: "Forge",
    role: "You are Forge, an elite software engineer AI. You receive a detailed technical specification and write clean, production-ready code. Always include comments. Output ONLY the code with brief inline comments. No long explanations outside code blocks."
  },
  reviewer: {
    model: "nvidia/llama-3.1-nemotron-70b-instruct",
    name: "Aegis",
    role: "You are Aegis, a senior code reviewer AI. You receive original user request + enhanced spec + written code. Your job: find bugs, security issues, performance problems, and suggest improvements. Format: '## ✅ GOOD' (what works well), '## ⚠️ ISSUES' (bugs/problems with line refs), '## 🔧 IMPROVEMENTS' (optimized snippets if needed). Be direct and technical."
  }
};

async function callNvidia(model, systemPrompt, userMessage, signal) {
  const response = await fetch(`${NVIDIA_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      stream: true,
      max_tokens: 2048,
      temperature: 0.6
    }),
    signal
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Nvidia API error: ${err}`);
  }
  return response;
}

function encodeEvent(type, agentName, agentModel, chunk) {
  return `data: ${JSON.stringify({ type, agent: agentName, model: agentModel, chunk })}\n\n`;
}

async function streamAgent(agentKey, userMessage, writer, encoder) {
  const agent = AGENTS[agentKey];
  
  // Send agent start event
  writer.write(encoder.encode(
    `data: ${JSON.stringify({ type: "agent_start", agent: agent.name, model: agent.model, agentKey })}\n\n`
  ));

  const response = await callNvidia(agent.model, agent.role, userMessage);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n").filter(l => l.startsWith("data: "));

    for (const line of lines) {
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        const text = parsed.choices?.[0]?.delta?.content || "";
        if (text) {
          fullText += text;
          writer.write(encoder.encode(
            encodeEvent("token", agent.name, agent.model, text)
          ));
        }
      } catch (_) {}
    }
  }

  writer.write(encoder.encode(
    `data: ${JSON.stringify({ type: "agent_done", agent: agent.name, agentKey })}\n\n`
  ));

  return fullText;
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { prompt } = await req.json();
  if (!prompt) return new Response("No prompt", { status: 400 });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      // Step 1: Prometheus analyzes and enhances prompt
      const enhancedPrompt = await streamAgent(
        "prompt_engineer",
        `User request: "${prompt}"`,
        writer,
        encoder
      );

      // Step 2: Forge writes code based on enhanced prompt
      const code = await streamAgent(
        "coder",
        `${enhancedPrompt}\n\nOriginal user request: "${prompt}"`,
        writer,
        encoder
      );

      // Step 3: Aegis reviews everything
      await streamAgent(
        "reviewer",
        `Original request: "${prompt}"\n\nSpec:\n${enhancedPrompt}\n\nCode written:\n${code}`,
        writer,
        encoder
      );

      writer.write(encoder.encode(`data: ${JSON.stringify({ type: "pipeline_done" })}\n\n`));
    } catch (err) {
      writer.write(encoder.encode(
        `data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`
      ));
    } finally {
      writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
