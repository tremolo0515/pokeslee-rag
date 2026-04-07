#!/usr/bin/env python3
"""
ポケスリwiki スクレイパー
wikiwiki.jp/poke_sleep/ のページを再帰的に収集し data/pages/ にMarkdownとして保存する
"""

import hashlib
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup

# ─── 定数 ───────────────────────────────────────────────────────────────────
BASE_URL = "https://wikiwiki.jp/poke_sleep/"
OUTPUT_DIR = Path(__file__).parent.parent / "data" / "pages"

# wikiwiki.jp のメインコンテンツセレクタ（代表ページ確認済み）
CONTENT_SELECTORS = [
    "#wikibody",         # wikiwiki.jp の標準コンテンツ領域
    "#content",
    ".wiki-content",
    "div#main",
]

# 除外パス（前方一致）
EXCLUDED_PATHS = ["/poke_sleep/edit/", "/poke_sleep/diff/", "/poke_sleep/attach/",
                  "/poke_sleep/search", "/poke_sleep/recent", "/poke_sleep/help",
                  "/poke_sleep/trackback/", "/poke_sleep/backup/",
                  "/poke_sleep/cmd/",
                  "/poke_sleep/コメント/",   # ユーザー投稿の掲示板（ノイズ）
                  "/poke_sleep/%E3%82%B3%E3%83%A1%E3%83%B3%E3%83%88/"]  # URLエンコード版

MAX_DEPTH = 3
REQUEST_INTERVAL = 1.5   # 秒
HTTP_TIMEOUT = 10        # 秒
MAX_RETRIES = 3
MIN_CONTENT_LENGTH = 300  # 文字数

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ─── robots.txt ─────────────────────────────────────────────────────────────
# Python 3.9 の urllib.robotparser は /*? などのワイルドカードを誤判定するため
# 独自パーサーを使用する

def load_robots(base_url: str) -> list:
    """robots.txt の Disallow パターンリストを返す"""
    robots_url = urljoin(base_url, "/robots.txt")
    disallow_patterns: list = []
    try:
        resp = requests.get(robots_url, timeout=HTTP_TIMEOUT)
        resp.raise_for_status()
        in_target_block = False
        for line in resp.text.splitlines():
            line = line.strip()
            if line.lower().startswith("user-agent:"):
                agent = line.split(":", 1)[1].strip()
                in_target_block = agent == "*"
            elif in_target_block and line.lower().startswith("disallow:"):
                pattern = line.split(":", 1)[1].strip()
                if pattern:
                    disallow_patterns.append(pattern)
        log.info(f"robots.txt 取得: {robots_url} ({len(disallow_patterns)}件のDisallow)")
    except Exception as e:
        log.warning(f"robots.txt 取得失敗（スキップして続行）: {e}")
    return disallow_patterns


def _robots_pattern_to_regex(pattern: str) -> re.Pattern:
    """robots.txt のパスパターンを正規表現に変換する"""
    escaped = re.escape(pattern).replace(r"\*", ".*").replace(r"\$", "$")
    if not escaped.endswith("$"):
        escaped += ".*"
    return re.compile(escaped)


def is_allowed(disallow_patterns: list, url: str) -> bool:
    path = urlparse(url).path
    for pattern in disallow_patterns:
        regex = _robots_pattern_to_regex(pattern)
        if regex.match(path):
            return False
    return True


# ─── HTTPリクエスト ───────────────────────────────────────────────────────────

def fetch(session: requests.Session, url: str) -> Optional[requests.Response]:
    """指数バックオフ付きリトライでHTTPリクエスト"""
    for attempt in range(MAX_RETRIES):
        try:
            resp = session.get(url, timeout=HTTP_TIMEOUT)
            if resp.status_code in (429, 503):
                wait = 2 ** attempt * 2
                log.warning(f"レート制限 {resp.status_code}、{wait}秒待機: {url}")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp
        except requests.RequestException as e:
            wait = 2 ** attempt
            log.warning(f"リクエスト失敗 (試行{attempt+1}/{MAX_RETRIES}) {url}: {e}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(wait)
    log.error(f"最大リトライ到達、スキップ: {url}")
    return None


# ─── URL フィルタリング ────────────────────────────────────────────────────────

def normalize_url(url: str) -> str:
    """クエリ・フラグメントを除去して正規化"""
    p = urlparse(url)
    return urlunparse((p.scheme, p.netloc, p.path, "", "", ""))


def is_target_url(url: str) -> bool:
    """収集対象かどうか判定"""
    p = urlparse(url)
    if p.query:
        return False
    if p.netloc != "wikiwiki.jp":
        return False
    if not p.path.startswith("/poke_sleep/"):
        return False
    for excl in EXCLUDED_PATHS:
        if p.path.startswith(excl):
            return False
    return True


def extract_links(soup: BeautifulSoup, current_url: str) -> list[str]:
    links = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        abs_url = urljoin(current_url, href)
        norm = normalize_url(abs_url)
        if is_target_url(norm):
            links.append(norm)
    return links


# ─── コンテンツ抽出 ───────────────────────────────────────────────────────────

def extract_content(soup: BeautifulSoup) -> Optional[str]:
    """メインコンテンツ領域のテキストを抽出"""
    for selector in CONTENT_SELECTORS:
        node = soup.select_one(selector)
        if node:
            # ナビゲーション・サイドバー要素を除去
            for tag in node.select("script, style, .navi, #navi, nav, .sidebar"):
                tag.decompose()
            return node.get_text(separator="\n", strip=True)
    # フォールバック: <body> 全体
    body = soup.find("body")
    if body:
        for tag in body.select("script, style, header, footer, nav"):
            tag.decompose()
        return body.get_text(separator="\n", strip=True)
    return None


def extract_title(soup: BeautifulSoup, url: str) -> str:
    tag = soup.find("title")
    if tag:
        text = tag.get_text(strip=True)
        # "ページ名 - wikiwiki.jp" のような形式から取り出す
        text = re.sub(r"\s*[-–|].*$", "", text).strip()
        if text:
            return text
    return urlparse(url).path.rstrip("/").split("/")[-1] or "index"


# ─── ファイル名生成 ────────────────────────────────────────────────────────────

def url_to_filename(url: str, used: set[str]) -> str:
    path = urlparse(url).path.rstrip("/")
    # URLデコードして日本語に戻す
    path = unquote(path)
    slug = path.split("/poke_sleep/", 1)[-1] if "/poke_sleep/" in path else path
    if not slug:
        slug = "index"
    # OS非対応文字を _ に置換
    safe = re.sub(r'[/:\\?#*"<>|]', "_", slug)
    safe = safe.strip("_") or "index"
    # macOS のファイル名上限は255バイト。拡張子(.md=3bytes)分を引いた220文字で切る
    if len(safe.encode("utf-8")) > 220:
        short_hash = hashlib.md5(url.encode()).hexdigest()[:8]
        # 先頭100文字 + ハッシュ
        safe = safe[:100].rstrip("_") + f"__{short_hash}"

    candidate = f"{safe}.md"
    if candidate not in used:
        return candidate
    # 衝突回避: 短いハッシュを末尾に付与
    short_hash = hashlib.md5(url.encode()).hexdigest()[:6]
    return f"{safe}__{short_hash}.md"


# ─── ページ保存 ───────────────────────────────────────────────────────────────

def save_page(filepath: Path, url: str, title: str, content: str) -> None:
    norm_content = re.sub(r"\s+", " ", content).strip()
    content_hash = hashlib.sha256(norm_content.encode()).hexdigest()
    scraped_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

    frontmatter = (
        f"---\n"
        f"url: {url}\n"
        f"title: {title}\n"
        f"content_hash: {content_hash}\n"
        f"scraped_at: {scraped_at}\n"
        f"---\n\n"
        f"# {title}\n\n"
        f"{content}\n"
    )
    filepath.write_text(frontmatter, encoding="utf-8")


# ─── メインスクレイプ ─────────────────────────────────────────────────────────

def scrape() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers.update({"User-Agent": "pokeslee-rag-bot/1.0 (educational fan tool)"})

    disallow_patterns = load_robots(BASE_URL)

    visited: set[str] = set()
    used_filenames: set[str] = set()
    # (url, depth)
    queue: list[tuple[str, int]] = [(normalize_url(BASE_URL), 0)]
    saved = 0
    skipped = 0

    while queue:
        url, depth = queue.pop(0)
        if url in visited:
            continue
        visited.add(url)

        if not is_allowed(disallow_patterns, url):
            log.info(f"robots.txt によりスキップ: {url}")
            skipped += 1
            continue

        log.info(f"[depth={depth}] 取得: {url}")
        resp = fetch(session, url)
        if resp is None:
            skipped += 1
            time.sleep(REQUEST_INTERVAL)
            continue

        # エンコーディング修正
        resp.encoding = resp.apparent_encoding or "utf-8"
        soup = BeautifulSoup(resp.text, "html.parser")

        content = extract_content(soup)
        if not content:
            log.warning(f"コンテンツ抽出失敗: {url}")
            skipped += 1
        else:
            if len(content) < MIN_CONTENT_LENGTH:
                log.warning(f"コンテンツが短すぎます({len(content)}文字): {url}")

            title = extract_title(soup, url)
            filename = url_to_filename(url, used_filenames)
            used_filenames.add(filename)
            filepath = OUTPUT_DIR / filename
            save_page(filepath, url, title, content)
            log.info(f"  -> 保存: {filename} ({len(content)}文字)")
            saved += 1

        # リンク収集（深さ制限）
        if depth < MAX_DEPTH:
            for link in extract_links(soup, url):
                if link not in visited:
                    queue.append((link, depth + 1))

        time.sleep(REQUEST_INTERVAL)

    log.info(f"完了: 保存={saved}, スキップ={skipped}, 訪問={len(visited)}")


if __name__ == "__main__":
    scrape()
