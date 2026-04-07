#!/usr/bin/env python3
"""
埋め込み生成・Supabase格納スクリプト
data/chunks.jsonl を読み込み、OpenAI text-embedding-3-small で埋め込みを生成し
Supabase の wiki_chunks テーブルにupsertする
"""

import json
import os
import time
from pathlib import Path

import tiktoken
from dotenv import load_dotenv
from openai import OpenAI
from supabase import create_client

# ─── 設定 ─────────────────────────────────────────────────────────────────────
load_dotenv(Path(__file__).parent.parent / ".env.local")

CHUNKS_FILE = Path(__file__).parent.parent / "data" / "chunks.jsonl"
EMBED_MODEL = "text-embedding-3-small"   # 1536次元
BATCH_SIZE = 20
MAX_RETRIES = 3
MAX_TOKENS = 8000

enc = tiktoken.get_encoding("cl100k_base")


def truncate_text(text: str) -> str:
    """8192トークンを超えるテキストを切り詰める"""
    tokens = enc.encode(text)
    if len(tokens) <= MAX_TOKENS:
        return text
    return enc.decode(tokens[:MAX_TOKENS])

openai_client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
supabase = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_ROLE_KEY"],
)


# ─── 既存のcontent_hashを取得 ──────────────────────────────────────────────────

def fetch_existing_hashes() -> dict[str, str]:
    """DBにある {id: content_hash} を返す"""
    result = supabase.table("wiki_chunks").select("id, content_hash").execute()
    return {row["id"]: row["content_hash"] for row in result.data}


# ─── 埋め込み生成 ──────────────────────────────────────────────────────────────

def embed_texts(texts: list[str]) -> list[list[float]]:
    """指数バックオフ付きリトライで埋め込みを生成"""
    for attempt in range(MAX_RETRIES):
        try:
            resp = openai_client.embeddings.create(
                model=EMBED_MODEL,
                input=texts,
            )
            return [item.embedding for item in resp.data]
        except Exception as e:
            wait = 2 ** attempt * 2
            print(f"  [WARN] 埋め込み失敗 (試行{attempt+1}/{MAX_RETRIES}): {e}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(wait)
    raise RuntimeError("埋め込み生成が最大リトライ回数に達しました")


# ─── upsert ───────────────────────────────────────────────────────────────────

def upsert_chunks(rows: list[dict]) -> None:
    """指数バックオフ付きリトライでupsert"""
    for attempt in range(MAX_RETRIES):
        try:
            supabase.table("wiki_chunks").upsert(rows).execute()
            return
        except Exception as e:
            wait = 2 ** attempt * 2
            print(f"  [WARN] upsert失敗 (試行{attempt+1}/{MAX_RETRIES}): {e}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(wait)
    raise RuntimeError("upsertが最大リトライ回数に達しました")


# ─── メイン ───────────────────────────────────────────────────────────────────

def main() -> None:
    if not CHUNKS_FILE.exists():
        print(f"chunks.jsonlが見つかりません: {CHUNKS_FILE}")
        return

    # chunks.jsonl 読み込み
    chunks = []
    with CHUNKS_FILE.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                chunks.append(json.loads(line))
    print(f"チャンク数: {len(chunks)}")

    # 既存ハッシュ取得（差分スキップ用）
    existing = fetch_existing_hashes()
    print(f"DB既存レコード数: {len(existing)}")

    # 処理対象を絞り込み（content_hashが変わったもののみ）
    targets = [
        c for c in chunks
        if existing.get(c["id"]) != c["content_hash"]
    ]
    skipped = len(chunks) - len(targets)
    print(f"スキップ（ハッシュ一致）: {skipped}件")
    print(f"処理対象: {len(targets)}件")

    if not targets:
        print("更新対象なし。終了します。")
    else:
        # バッチ処理
        processed = 0
        for i in range(0, len(targets), BATCH_SIZE):
            batch = targets[i:i + BATCH_SIZE]
            texts = [truncate_text(c["text"]) for c in batch]
            embeddings = embed_texts(texts)

            rows = [
                {
                    "id": c["id"],
                    "url": c["url"],
                    "title": c["title"],
                    "content_hash": c["content_hash"],
                    "text": c["text"],
                    "embedding": emb,
                }
                for c, emb in zip(batch, embeddings)
            ]
            upsert_chunks(rows)
            processed += len(batch)
            print(f"  upsert: {processed}/{len(targets)}")

        print(f"\n埋め込み完了: {processed}件をupsert")

    # ─── 削除処理: 今回取得できなかったURLのレコードを削除 ─────────────────────
    current_ids = {c["id"] for c in chunks}
    orphan_ids = [rid for rid in existing if rid not in current_ids]
    if orphan_ids:
        print(f"\n削除対象（今回未取得）: {len(orphan_ids)}件")
        for i in range(0, len(orphan_ids), 100):
            batch_ids = orphan_ids[i:i + 100]
            supabase.table("wiki_chunks").delete().in_("id", batch_ids).execute()
        print("削除完了")
    else:
        print("削除対象なし")


if __name__ == "__main__":
    main()
