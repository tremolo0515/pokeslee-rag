#!/usr/bin/env python3
"""
チャンク分割スクリプト
data/pages/ の Markdown を 500トークン/50オーバーラップで分割し
data/chunks.jsonl に保存する
"""

import json
import re
from pathlib import Path

import tiktoken

# ─── 定数 ────────────────────────────────────────────────────────────────────
PAGES_DIR = Path(__file__).parent.parent / "data" / "pages"
OUTPUT_FILE = Path(__file__).parent.parent / "data" / "chunks.jsonl"
CHUNK_SIZE = 500      # トークン
OVERLAP = 50          # トークン
ENCODING_NAME = "cl100k_base"

enc = tiktoken.get_encoding(ENCODING_NAME)


# ─── トークン計測 ──────────────────────────────────────────────────────────────

def count_tokens(text: str) -> int:
    return len(enc.encode(text))


# ─── Markdown フロントマター解析 ───────────────────────────────────────────────

def parse_frontmatter(text: str) -> tuple[dict, str]:
    """フロントマターを解析してメタデータと本文を返す"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    fm_text = text[3:end].strip()
    body = text[end + 4:].strip()
    meta = {}
    for line in fm_text.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip()
    return meta, body


# ─── テキスト分割 ──────────────────────────────────────────────────────────────

def split_by_headings(text: str) -> list[str]:
    """見出し（#）を区切りにセクション分割"""
    sections = re.split(r"(?m)^(?=#)", text)
    return [s.strip() for s in sections if s.strip()]


def split_by_paragraphs(text: str) -> list[str]:
    """空行区切りで段落分割"""
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def split_by_sentences(text: str) -> list[str]:
    """。！？を終端として文分割"""
    sentences = re.split(r"(?<=[。！？])", text)
    return [s.strip() for s in sentences if s.strip()]


def merge_into_chunks(units: list[str], chunk_size: int, overlap: int) -> list[str]:
    """
    テキストユニットをトークン数を見ながら結合してチャンクを作る。
    オーバーラップは前チャンク末尾のユニットを再利用することで実現。
    """
    chunks: list[str] = []
    current_units: list[str] = []
    current_tokens = 0

    i = 0
    while i < len(units):
        unit = units[i]
        unit_tokens = count_tokens(unit)

        # 1ユニット単体でchunk_sizeを超える場合は強制分割
        if unit_tokens > chunk_size:
            # 現在のバッファを先にフラッシュ
            if current_units:
                chunks.append("\n".join(current_units))
                current_units = []
                current_tokens = 0
            # 超大ユニットをそのままチャンクに
            chunks.append(unit)
            i += 1
            continue

        if current_tokens + unit_tokens > chunk_size and current_units:
            chunks.append("\n".join(current_units))
            # オーバーラップ: 末尾からoverlapトークン分のユニットを引き継ぐ
            overlap_units: list[str] = []
            overlap_tokens = 0
            for u in reversed(current_units):
                t = count_tokens(u)
                if overlap_tokens + t <= overlap:
                    overlap_units.insert(0, u)
                    overlap_tokens += t
                else:
                    break
            current_units = overlap_units
            current_tokens = overlap_tokens

        current_units.append(unit)
        current_tokens += unit_tokens
        i += 1

    if current_units:
        chunks.append("\n".join(current_units))

    return chunks


def build_chunks_for_page(body: str) -> list[str]:
    """
    優先順位: 見出し > 段落 > 文
    各見出しセクションをさらに段落・文で細分化してからmerge_into_chunksに渡す
    """
    units: list[str] = []
    sections = split_by_headings(body)
    for section in sections:
        if count_tokens(section) <= CHUNK_SIZE:
            units.append(section)
        else:
            paragraphs = split_by_paragraphs(section)
            for para in paragraphs:
                if count_tokens(para) <= CHUNK_SIZE:
                    units.append(para)
                else:
                    sentences = split_by_sentences(para)
                    units.extend(sentences)
    return merge_into_chunks(units, CHUNK_SIZE, OVERLAP)


# ─── スラッグ生成 ──────────────────────────────────────────────────────────────

def filename_to_slug(filename: str) -> str:
    """ファイル名（拡張子なし）をID用スラッグに変換"""
    return Path(filename).stem


# ─── メイン ───────────────────────────────────────────────────────────────────

def main() -> None:
    md_files = sorted(PAGES_DIR.glob("*.md"))
    if not md_files:
        print(f"Markdownファイルが見つかりません: {PAGES_DIR}")
        return

    all_chunks: list[dict] = []
    total_files = 0
    total_chunks = 0

    for md_path in md_files:
        text = md_path.read_text(encoding="utf-8")
        meta, body = parse_frontmatter(text)

        url = meta.get("url", "")
        title = meta.get("title", md_path.stem)
        content_hash = meta.get("content_hash", "")
        slug = filename_to_slug(md_path.name)

        if not body.strip():
            print(f"[WARN] 本文なし: {md_path.name}")
            continue

        chunks = build_chunks_for_page(body)
        for idx, chunk_text in enumerate(chunks, start=1):
            chunk_id = f"{slug}_{idx:03d}"
            # タイトルを先頭に付与してページの文脈を保持
            text_with_title = f"【{title}】\n{chunk_text}"
            all_chunks.append({
                "id": chunk_id,
                "url": url,
                "title": title,
                "content_hash": content_hash,
                "text": text_with_title,
            })

        total_files += 1
        total_chunks += len(chunks)
        print(f"  {md_path.name}: {len(chunks)} チャンク")

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_FILE.open("w", encoding="utf-8") as f:
        for chunk in all_chunks:
            f.write(json.dumps(chunk, ensure_ascii=False) + "\n")

    print(f"\n完了: {total_files} ファイル -> {total_chunks} チャンク -> {OUTPUT_FILE}")

    # 統計サマリ
    token_counts = [count_tokens(c["text"]) for c in all_chunks]
    if token_counts:
        avg = sum(token_counts) / len(token_counts)
        too_short = sum(1 for t in token_counts if t < 50)
        too_long = sum(1 for t in token_counts if t > CHUNK_SIZE)
        print(f"  平均トークン数: {avg:.1f}")
        print(f"  短すぎる(<50token): {too_short}件")
        print(f"  長すぎる(>{CHUNK_SIZE}token): {too_long}件")


if __name__ == "__main__":
    main()
