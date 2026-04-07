import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

// ─── 定数 ─────────────────────────────────────────────────────────────────────
const EMBED_MODEL = "text-embedding-3-small";
const CHAT_MODEL = "gpt-4.1-nano";
const TOP_K = 5;
const SIMILARITY_THRESHOLD = 0.50;
const MAX_INPUT_LENGTH = 500;
const MAX_HISTORY_MESSAGES = 10;

const SYSTEM_PROMPT = `あなたはポケスリ（Pokémon Sleep）の初心者向けアシスタントです。
以下のwiki情報をもとに、やさしく丁寧に答えてください。

厳守ルール：
- 必ず【wiki情報】に書かれている内容だけを使って回答する
- 【wiki情報】に書かれていないことは、自分の知識で補わず「wikiには記載がありませんでした」と答える
- ポケモンの対戦・レベル・捕獲など、ポケスリと関係ない情報は絶対に回答しない
- 初心者にわかりやすい言葉を使う
- 回答は簡潔に、200字以内を目安にする

【wiki情報】
{context}`;

// ─── クライアント ──────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─── 型定義 ───────────────────────────────────────────────────────────────────
interface Message {
  role: "user" | "assistant";
  content: string;
}

interface WikiChunk {
  id: string;
  url: string;
  title: string;
  text: string;
  similarity: number;
}

// ─── 埋め込み生成 ──────────────────────────────────────────────────────────────
async function embedQuery(text: string): Promise<number[]> {
  const resp = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: text,
  });
  return resp.data[0].embedding;
}

// ─── 類似チャンク検索 ─────────────────────────────────────────────────────────
async function searchChunks(queryVector: number[]): Promise<WikiChunk[]> {
  const { data, error } = await supabase.rpc("match_wiki_chunks", {
    query_embedding: queryVector,
    match_count: TOP_K,
    similarity_threshold: SIMILARITY_THRESHOLD,
  });

  if (error) throw new Error(`Supabase検索エラー: ${error.message}`);
  return (data as WikiChunk[]) ?? [];
}

// ─── LLM呼び出し ──────────────────────────────────────────────────────────────
async function callLLM(
  systemPrompt: string,
  history: Message[],
  userMessage: string
): Promise<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages,
    max_tokens: 512,
  });

  return resp.choices[0]?.message?.content ?? "回答を生成できませんでした。";
}

// ─── ハンドラー ───────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { message, history = [] } = body as {
      message: string;
      history: Message[];
    };

    // 入力バリデーション
    if (!message || typeof message !== "string" || message.trim() === "") {
      return NextResponse.json(
        { error: "メッセージが空です" },
        { status: 400 }
      );
    }
    if (message.length > MAX_INPUT_LENGTH) {
      return NextResponse.json(
        { error: `メッセージは${MAX_INPUT_LENGTH}文字以内にしてください` },
        { status: 400 }
      );
    }

    // 直近10件の履歴のみ使用
    const recentHistory = history.slice(-MAX_HISTORY_MESSAGES);

    // 1. クエリを埋め込みベクター化
    const queryVector = await embedQuery(message.trim());

    // 2. 類似チャンク検索
    const chunks = await searchChunks(queryVector);

    // 0件の場合
    if (chunks.length === 0) {
      return NextResponse.json({
        answer: "wikiには記載がありませんでした。",
        sources: [],
      });
    }

    // 3. プロンプト構築
    const context = chunks
      .map((c, i) => `[${i + 1}] ${c.title}\n${c.text}`)
      .join("\n\n");
    const systemPrompt = SYSTEM_PROMPT.replace("{context}", context);

    // 4. LLM呼び出し
    const answer = await callLLM(systemPrompt, recentHistory, message.trim());

    // 5. レスポンス
    const sources = chunks.map((c) => ({
      url: c.url,
      title: c.title,
      snippet: c.text.slice(0, 100),
    }));

    return NextResponse.json({ answer, sources });
  } catch (err) {
    console.error("[/api/chat] エラー:", err);
    return NextResponse.json(
      { error: "申し訳ありません。一時的なエラーが発生しました。" },
      { status: 500 }
    );
  }
}
