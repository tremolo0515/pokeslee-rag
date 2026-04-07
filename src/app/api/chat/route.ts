import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

// ─── 定数 ─────────────────────────────────────────────────────────────────────
const EMBED_MODEL = "text-embedding-3-small";
const CHAT_MODEL = "gpt-4.1-nano";
const TOP_K = 8;
const SIMILARITY_THRESHOLD = 0.50;
const MAX_INPUT_LENGTH = 500;
const MAX_HISTORY_MESSAGES = 10;

const SYSTEM_PROMPT = `あなたはポケスリ（Pokémon Sleep）のアシスタントです。
以下のwiki情報をもとに正確に答えてください。

厳守ルール：
- 必ず【wiki情報】に書かれている内容だけを使って回答する
- 【wiki情報】に書かれていないことは、自分の知識で補わず「wikiには記載がありませんでした」と答える
- ポケモンの対戦・レベル・捕獲など、ポケスリと関係ない情報は絶対に回答しない

回答スタイル：
- ポケモンの性能・スペックを聞かれたら、きのみ・食材・メインスキル・適正フィールド・特徴を具体的に列挙する
- 数値や固有名詞（食材名・スキル名・フィールド名）はwiki情報から正確に転記する
- 簡単な質問は2〜3文、詳しい質問は箇条書きで答える
- 専門用語はそのまま使ってよい（初心者でも調べられる）

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

// ─── クエリ正規化 ─────────────────────────────────────────────────────────────
// ユーザーが漢字・別表記で入力した語を、wiki上の正式表記に統一する。
// 長いフレーズを先に配置することで部分マッチの誤変換を防ぐ。
const TERM_MAP: [string, string][] = [
  // ── ゲームリソース ──────────────────────────────────────────────
  ["夢のかけら",        "ゆめのかけら"],
  ["夢かけら",          "ゆめのかけら"],
  ["夢の欠片",          "ゆめのかけら"],
  ["ゆめかけら",        "ゆめのかけら"],
  ["夢のかたまり",      "ゆめのかたまり"],
  ["夢の塊",            "ゆめのかたまり"],
  ["ゆめかたまり",      "ゆめのかたまり"],
  ["万能アメ",          "ばんのうアメ"],
  ["万能あめ",          "ばんのうアメ"],
  ["ばんのうあめ",      "ばんのうアメ"],
  ["特性アメ",          "とくせいアメ"],
  ["特製アメ",          "とくせいアメ"],
  ["とくせいあめ",      "とくせいアメ"],
  ["経験値アメ",        "経験値アメ"],
  ["スリープポイント",  "スリープポイント"],
  ["睡眠ポイント",      "スリープポイント"],
  ["フレンドポイント",  "フレンドポイント"],
  ["友達ポイント",      "フレンドポイント"],

  // ── ゲームメカニクス ────────────────────────────────────────────
  ["お手伝いスピード",  "おてつだいスピード"],
  ["手伝いスピード",    "おてつだいスピード"],
  ["お手伝いボーナス",  "おてつだいボーナス"],
  ["お手伝い",          "おてつだい"],
  ["手伝い",            "おてつだい"],
  ["元気回復",          "げんき回復"],
  ["元気",              "げんき"],
  ["木の実得意",        "きのみとくい"],
  ["木実得意",          "きのみとくい"],
  ["木の実",            "きのみ"],
  ["木実",              "きのみ"],
  ["スキル得意",        "スキルとくい"],
  ["食材得意",          "食材とくい"],
  ["性格",              "せいかく"],
  ["研究ランク",        "リサーチランク"],
  ["研究フィールド",    "リサーチフィールド"],
  ["研究",              "リサーチ"],
  ["調査",              "リサーチ"],
  ["眠気パワー",        "ねむけパワー"],
  ["眠けパワー",        "ねむけパワー"],
  ["睡眠タイプ",        "睡眠タイプ"],
  ["睡眠",              "ねむり"],
  ["夢のかけらゲット",  "ゆめのかけらゲットS"],
  ["お手伝いサポート",  "おてつだいサポートS"],
  ["お手伝いブースト",  "おてつだいブースト"],
  ["最大所持数",        "最大所持数"],
  ["最大持ち物数",      "最大所持数"],
  ["料理パワー",        "料理パワーアップS"],

  // ── おこう ──────────────────────────────────────────────────────
  ["成長のお香",        "せいちょうのおこう"],
  ["成長のおこう",      "せいちょうのおこう"],
  ["仲良しのお香",      "なかよしのおこう"],
  ["仲良しのおこう",    "なかよしのおこう"],
  ["幸運のお香",        "こううんのおこう"],
  ["幸運のおこう",      "こううんのおこう"],
  ["回復のお香",        "かいふくのおこう"],
  ["回復のおこう",      "かいふくのおこう"],
  ["集中のお香",        "しゅうちゅうのおこう"],
  ["集中のおこう",      "しゅうちゅうのおこう"],
  ["お香",              "おこう"],

  // ── 食材 ────────────────────────────────────────────────────────
  ["味わいキノコ",      "あじわいキノコ"],
  ["温かジンジャー",    "あったかジンジャー"],
  ["甘いミツ",          "あまいミツ"],
  ["甘みつ",            "あまいミツ"],
  ["安眠トマト",        "あんみんトマト"],
  ["美味しいシッポ",    "おいしいシッポ"],
  ["激辛ハーブ",        "げきからハーブ"],
  ["激からハーブ",      "げきからハーブ"],
  ["ずっしりかぼちゃ",  "ずっしりカボチャ"],
  ["特選エッグ",        "とくせんエッグ"],
  ["特選たまご",        "とくせんエッグ"],
  ["特選リンゴ",        "とくせんリンゴ"],
  ["特選りんご",        "とくせんリンゴ"],
  ["太いながねぎ",      "ふといながねぎ"],
  ["太いネギ",          "ふといながねぎ"],
  ["太長ネギ",          "ふといながねぎ"],
  ["目覚ましコーヒー",  "めざましコーヒー"],
  ["ワカクサだいず",    "ワカクサ大豆"],

  // ── 性格 (せいかく) ─────────────────────────────────────────────
  ["勇敢",              "ゆうかん"],
  ["控えめ",            "ひかえめ"],
  ["控え目",            "ひかえめ"],
  ["寂しがり",          "さみしがり"],
  ["淋しがり",          "さみしがり"],
  ["生意気",            "なまいき"],
  ["慎重",              "しんちょう"],
  ["冷静",              "れいせい"],
  ["穏やか",            "おだやか"],
  ["大人しい",          "おとなしい"],
  ["無邪気",            "むじゃき"],
  ["真面目",            "まじめ"],
  ["暢気",              "のんき"],
  ["腕白",              "わんぱく"],
  ["うっかり屋",        "うっかりや"],

  // ── メインスキル ────────────────────────────────────────────────
  ["元気エールS",       "げんきエールS"],
  ["元気チャージS",     "げんきチャージS"],
  ["元気オールS",       "げんきオールS"],
  ["元気チャージ",      "げんきチャージS"],
  ["元気エール",        "げんきエールS"],

  // ── 睡眠タイプ ──────────────────────────────────────────────────
  ["スヤスヤ",          "すやすや"],
  ["ウトウト",          "うとうと"],
  ["グッスリ",          "ぐっすり"],

  // ── フィールド ──────────────────────────────────────────────────
  ["わかくさ本島",      "ワカクサ本島"],
  ["わかくさ",          "ワカクサ"],
  ["しあんの砂浜",      "シアンの砂浜"],
  ["しあん",            "シアン"],
  ["とーぷ洞窟",        "トープ洞窟"],
  ["とーぷ",            "トープ"],
  ["うのはな雪原",      "ウノハナ雪原"],
  ["うのはな",          "ウノハナ"],
  ["あんばー渓谷",      "アンバー渓谷"],
  ["らぴすらずり湖畔",  "ラピスラズリ湖畔"],
  ["ごーるど旧発電所",  "ゴールド旧発電所"],

  // ── その他ゲーム用語 ────────────────────────────────────────────
  ["リサーチランクアップ", "リサーチランクアップ"],
  ["レシピレベル",      "レシピレベル"],
  ["サブスキル",        "サブスキル"],
  ["メインスキル",      "メインスキル"],
  ["キャンプチケット",  "いいキャンプチケット"],
  ["キャンチケ",        "いいキャンプチケット"],
  ["絶対眠り",          "ぜったいねむり"],
  ["指をふる",          "ゆびをふる"],
  ["へんしん",          "へんしん"],
  ["厳選",              "厳選"],
];

function normalizeQuery(query: string): string {
  let result = query;
  for (const [from, to] of TERM_MAP) {
    result = result.replaceAll(from, to);
  }
  return result;
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
async function searchChunks(queryVector: number[], queryText: string): Promise<WikiChunk[]> {
  const { data, error } = await supabase.rpc("match_wiki_chunks", {
    query_embedding: queryVector,
    query_text: queryText,
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
    const normalizedMessage = normalizeQuery(message.trim());
    const queryVector = await embedQuery(normalizedMessage);

    // 2. 類似チャンク検索
    const chunks = await searchChunks(queryVector, normalizedMessage);

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
