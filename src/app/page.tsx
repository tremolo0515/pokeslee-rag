"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
}

interface Source {
  url: string;
  title: string;
  snippet: string;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMessage: Message = { role: "user", content: text };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const history = newMessages
        .slice(-10)
        .map(({ role, content }) => ({ role, content }));

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: history.slice(0, -1) }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "エラーが発生しました");
        setMessages((prev) => prev.slice(0, -1));
        return;
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.answer,
          sources: data.sources,
        },
      ]);
    } catch {
      setError("通信エラーが発生しました。しばらくしてからお試しください。");
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
      {/* ヘッダー */}
      <header className="bg-blue-600 text-white py-4 px-4 shadow">
        <h1 className="text-xl font-bold text-center">
          ポケスリ攻略チャット
        </h1>
        <p className="text-blue-200 text-xs text-center mt-1">
          ポケモンスリープwikiの情報をもとに回答します
        </p>
      </header>

      {/* 会話エリア */}
      <main className="flex-1 overflow-y-auto px-4 py-6 max-w-2xl w-full mx-auto">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 mt-16">
            <p className="text-lg">ポケスリについて何でも聞いてね！</p>
            <p className="text-sm mt-2">例: ゼニガメってどんなポケモン？</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`mb-4 flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] ${msg.role === "user" ? "order-2" : "order-1"}`}>
              {/* 吹き出し */}
              <div
                className={`rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white rounded-tr-sm"
                    : "bg-white text-gray-800 shadow rounded-tl-sm"
                }`}
              >
                {msg.content}
              </div>

              {/* 参照元 */}
              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-gray-400 ml-1">参照元:</p>
                  {msg.sources
                    .filter((s, idx, arr) => arr.findIndex((x) => x.url === s.url) === idx)
                    .map((source, si) => (
                      <a
                        key={si}
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-xs text-blue-500 hover:underline bg-blue-50 rounded px-2 py-1"
                      >
                        📄 {source.title}
                      </a>
                    ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {/* ローディング */}
        {loading && (
          <div className="flex justify-start mb-4">
            <div className="bg-white shadow rounded-2xl rounded-tl-sm px-4 py-3">
              <div className="flex space-x-1">
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}

        {/* エラー */}
        {error && (
          <p className="text-center text-red-500 text-sm mb-4">{error}</p>
        )}

        <div ref={bottomRef} />
      </main>

      {/* 入力エリア */}
      <div className="border-t bg-white px-4 py-3 max-w-2xl w-full mx-auto">
        <div className="flex gap-2 items-end">
          <textarea
            className="flex-1 border border-gray-300 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-400"
            rows={2}
            placeholder="質問を入力（Enterで送信）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            className="bg-blue-600 text-white rounded-xl px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed h-[52px]"
          >
            送信
          </button>
        </div>
      </div>

      {/* フッター */}
      <footer className="text-center text-xs text-gray-400 py-3 bg-white border-t">
        <p>このツールは非公式のファンメイドツールです。</p>
        <p>©2023 Pokémon. ©1995-2023 Nintendo/Creatures Inc./GAME FREAK inc.</p>
      </footer>
    </div>
  );
}
