// ── Tab switching ──────────────────────────────────────────
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "editor" && !editorInit) initEditor();
  });
});

// ── CodeMirror Editor ──────────────────────────────────────
let editor = null;
let editorInit = false;

function initEditor() {
  if (editorInit) return;
  editor = CodeMirror.fromTextArea(document.getElementById("code-editor"), {
    theme: "dracula",
    lineNumbers: true,
    mode: "javascript",
    tabSize: 2,
    lineWrapping: true,
    autofocus: false
  });
  editor.setSize("100%", "calc(100dvh - 130px)");
  editorInit = true;
}

function changeLanguage() {
  if (!editor) return;
  editor.setOption("mode", document.getElementById("lang-select").value);
}

function copyCode() {
  const text = editor ? editor.getValue() : "";
  navigator.clipboard.writeText(text).then(() => showToast("Copied!"));
}

function clearEditor() {
  if (editor) editor.setValue("");
}

// ── Output tab helpers ─────────────────────────────────────
let outputFull = "";

function copyOutput() {
  navigator.clipboard.writeText(outputFull).then(() => showToast("Copied!"));
}

function clearOutput() {
  outputFull = "";
  document.getElementById("output-content").textContent = "";
}

// ── Toast ──────────────────────────────────────────────────
function showToast(msg) {
  const t = document.createElement("div");
  t.textContent = msg;
  Object.assign(t.style, {
    position: "fixed", bottom: "80px", left: "50%", transform: "translateX(-50%)",
    background: "#22c55e", color: "#000", padding: "6px 16px",
    borderRadius: "20px", fontSize: "13px", fontWeight: "700",
    zIndex: "999", pointerEvents: "none"
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

// ── Agent state ────────────────────────────────────────────
const AGENT_COLORS = {
  prompt_engineer: "prometheus",
  coder: "forge",
  reviewer: "aegis"
};

const AGENT_ICONS = {
  Prometheus: "🎯",
  Forge: "⚙️",
  Aegis: "🔍"
};

function setAgentStatus(agentKey, status) {
  const card = document.getElementById("card-" + agentKey);
  if (!card) return;
  const ring = card.querySelector(".agent-status-ring");
  ring.className = "agent-status-ring " + status;
  if (status === "working") card.classList.add("active");
  if (status === "done") { card.classList.remove("active"); card.classList.add("done-state"); }
}

function resetAllAgents() {
  ["prompt_engineer", "coder", "reviewer"].forEach(k => {
    const card = document.getElementById("card-" + k);
    if (card) {
      card.classList.remove("active", "done-state");
      card.querySelector(".agent-status-ring").className = "agent-status-ring idle";
    }
  });
}

function setStatus(state, text) {
  document.getElementById("status-dot").className = "dot " + state;
  document.getElementById("status-text").textContent = text;
}

// ── Main send ──────────────────────────────────────────────
let isWorking = false;

async function sendPrompt() {
  const input = document.getElementById("prompt-input");
  const prompt = input.value.trim();
  if (!prompt || isWorking) return;

  isWorking = true;
  input.value = "";
  const sendBtn = document.getElementById("send-btn");
  sendBtn.disabled = true;
  sendBtn.innerHTML = "⏳";

  resetAllAgents();
  outputFull = "";
  document.getElementById("output-content").textContent = "";

  const messages = document.getElementById("messages");

  // User message
  const userDiv = document.createElement("div");
  userDiv.className = "user-msg";
  userDiv.textContent = "💬 " + prompt;
  messages.appendChild(userDiv);
  messages.scrollTop = messages.scrollHeight;

  setStatus("working", "Working...");

  let currentBlock = null;
  let currentBody = null;
  let currentAgentKey = null;

  try {
    const response = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt })
    });

    if (!response.ok) throw new Error("Server error: " + response.status);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      const lines = text.split("\n").filter(l => l.startsWith("data: "));

      for (const line of lines) {
        const raw = line.slice(6);
        try {
          const ev = JSON.parse(raw);
          handleEvent(ev, messages);
        } catch (_) {}
      }
    }

  } catch (err) {
    const errDiv = document.createElement("div");
    errDiv.className = "msg-block";
    errDiv.innerHTML = `<div class="msg-body" style="color:#ef4444">❌ Error: ${err.message}</div>`;
    messages.appendChild(errDiv);
    setStatus("error", "Error");
  }

  isWorking = false;
  sendBtn.disabled = false;
  sendBtn.innerHTML = "▶";
  messages.scrollTop = messages.scrollHeight;
}

// ── Event handler ──────────────────────────────────────────
const blocks = {};

function handleEvent(ev, messages) {
  if (ev.type === "agent_start") {
    setAgentStatus(ev.agentKey, "working");
    setStatus("working", ev.agent + " working...");

    const colorClass = AGENT_COLORS[ev.agentKey] + "-block";
    const block = document.createElement("div");
    block.className = "msg-block " + colorClass;
    block.innerHTML = `
      <div class="msg-header">
        <span>${AGENT_ICONS[ev.agent] || "🤖"} ${ev.agent}</span>
        <span class="badge">${ev.model}</span>
      </div>
      <div class="msg-body cursor-blink" id="body-${ev.agentKey}"></div>
    `;
    messages.appendChild(block);
    blocks[ev.agentKey] = block;
    messages.scrollTop = messages.scrollHeight;
  }

  if (ev.type === "token") {
    const body = document.getElementById("body-" + getAgentKey(ev.agent));
    if (body) {
      body.textContent += ev.chunk;
      outputFull += ev.chunk;
      // Auto-scroll
      messages.scrollTop = messages.scrollHeight;

      // If forge (coder), push to editor
      if (ev.agent === "Forge") {
        if (editorInit && editor) {
          const cur = editor.getValue();
          editor.setValue(cur + ev.chunk);
        } else {
          // Buffer for when editor opens
          window._editorBuffer = (window._editorBuffer || "") + ev.chunk;
        }
      }
    }
  }

  if (ev.type === "agent_done") {
    const key = getAgentKey(ev.agent);
    setAgentStatus(key, "done");
    const body = document.getElementById("body-" + key);
    if (body) body.classList.remove("cursor-blink");
  }

  if (ev.type === "pipeline_done") {
    setStatus("done", "Done ✓");
    const doneDiv = document.createElement("div");
    doneDiv.className = "pipeline-done-msg";
    doneDiv.textContent = "✅ All agents done — check Editor & Output tabs";
    messages.appendChild(doneDiv);

    // Push buffered editor content
    if (window._editorBuffer) {
      if (!editorInit) initEditor();
      editor.setValue(window._editorBuffer);
      window._editorBuffer = "";
    }

    // Push to output tab
    document.getElementById("output-content").textContent = outputFull;
    messages.scrollTop = messages.scrollHeight;
  }

  if (ev.type === "error") {
    setStatus("error", "Error");
    const errDiv = document.createElement("div");
    errDiv.className = "msg-block";
    errDiv.innerHTML = `<div class="msg-body" style="color:#ef4444">❌ ${ev.message}</div>`;
    messages.appendChild(errDiv);
  }
}

function getAgentKey(agentName) {
  const map = { Prometheus: "prompt_engineer", Forge: "coder", Aegis: "reviewer" };
  return map[agentName] || agentName;
}

// ── Enter to send ──────────────────────────────────────────
document.getElementById("prompt-input").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
