import { useEffect, useRef, useState } from "react";
import Markdown from "./Markdown.jsx";

const API = (import.meta.env.VITE_API_URL || "http://localhost:8000").replace(/\/$/, "");

const newSessionId = () =>
  "s-" + (crypto.randomUUID ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 14));

const SUGGESTIONS = [
  "What is the capital of France?",
  "Explain how API key failover works",
  "Write a haiku about caching",
  "Summarize the pros and cons of SQLite",
];

const Icon = {
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  chip: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>,
  db: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  send: <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></>,
};
const Svg = ({ name, size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {Icon[name]}
  </svg>
);

function Metadata({ meta }) {
  const cached = meta.resolution_source === "LLM_CACHE";
  return (
    <div className="meta">
      <span className={`chip source ${cached ? "cache" : "live"}`} data-testid="meta-source">
        {meta.resolution_source}
      </span>
      <span className="chip" title="Model">
        <Svg name="chip" /> <span data-testid="meta-model">{meta.model}</span>
      </span>
      <span className="chip" title="Latency">
        <Svg name="clock" /> <span data-testid="meta-latency">{meta.latency_ms} ms</span>
      </span>
      <span className="chip" title="Input tokens (this request)">
        in <b data-testid="meta-input-tokens">{meta.input_tokens}</b>
      </span>
      <span className="chip" title="Output tokens (this request)">
        out <b data-testid="meta-output-tokens">{meta.output_tokens}</b>
      </span>
      {meta.key_id && (
        <span className="chip subtle" title="API key that answered">
          {meta.key_id}
          {meta.fallback_attempts > 0 && ` · ${meta.fallback_attempts} failover${meta.fallback_attempts > 1 ? "s" : ""}`}
        </span>
      )}
    </div>
  );
}

export default function App() {
  const [sessionId, setSessionId] = useState(newSessionId); // new session on every page load
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  async function send(textOverride) {
    const text = (textOverride ?? input).trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    setMessages((m) => [...m, { role: "user", content: text }]);
    try {
      const body = { session_id: sessionId, message: text };
      if (systemPrompt.trim()) body.system_prompt = systemPrompt.trim();
      const res = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = typeof data.detail === "string" ? data.detail : "Request failed";
        setMessages((m) => [...m, { role: "error", content: `${detail} (HTTP ${res.status}). Your message was not saved — please try again.` }]);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: data.reply, meta: data.metadata }]);
      }
    } catch {
      setMessages((m) => [...m, { role: "error", content: "Could not reach the server. Check your connection and try again." }]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function newChat() {
    setMessages([]);
    setSessionId(newSessionId());
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="logo"><Svg name="bolt" size={18} /></div>
          <div>
            <h1>Lyftr Chat</h1>
            <p className="tagline">Resilient LLM gateway · key failover · response caching</p>
          </div>
        </div>
        <div className="actions">
          <span className="session" title="Current session id">
            <Svg name="db" /> {sessionId}
          </span>
          <button className="ghost" onClick={newChat}>
            <Svg name="plus" /> New chat
          </button>
        </div>
      </header>

      <section className="settings">
        <label htmlFor="sp"><Svg name="gear" size={12} /> System prompt</label>
        <input
          id="sp"
          data-testid="system-prompt-input"
          placeholder="Optional — e.g. You are a concise assistant that answers in one sentence."
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
      </section>

      <main className="thread" aria-live="polite">
        <div className="thread-inner">
          {messages.length === 0 && (
            <div className="hero">
              <div className="hero-logo"><Svg name="bolt" size={26} /></div>
              <h2>How can I help you today?</h2>
              <p>Every reply shows where it came from, which model answered, how long it took, and its token usage.</p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="suggestion" onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => {
            if (m.role === "user")
              return (
                <div key={i} className="row user">
                  <div className="bubble user">{m.content}</div>
                </div>
              );
            if (m.role === "error")
              return (
                <div key={i} className="row">
                  <div className="notice" role="alert">
                    <Svg name="alert" size={16} /> <span>{m.content}</span>
                  </div>
                </div>
              );
            return (
              <div key={i} className="row">
                <div className="avatar"><Svg name="bolt" size={14} /></div>
                <div className="bubble assistant" data-testid="assistant-message">
                  <div className="text"><Markdown text={m.content} /></div>
                  <Metadata meta={m.meta} />
                </div>
              </div>
            );
          })}

          {sending && (
            <div className="row">
              <div className="avatar"><Svg name="bolt" size={14} /></div>
              <div className="bubble assistant"><span className="dots"><i /><i /><i /></span></div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </main>

      <footer className="composer-wrap">
        <div className="composer">
          <textarea
            ref={inputRef}
            data-testid="chat-input"
            rows={1}
            autoFocus
            placeholder="Message Lyftr Chat…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="send" data-testid="send-button" onClick={() => send()} disabled={sending || !input.trim()} aria-label="Send">
            <Svg name="send" size={18} />
            <span>Send</span>
          </button>
        </div>
        <p className="hint">Enter to send · Shift+Enter for a new line</p>
      </footer>
    </div>
  );
}
