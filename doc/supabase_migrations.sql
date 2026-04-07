-- ============================================================
-- Supabase SQL 実行履歴
-- このファイルは上から順に実行すると環境を再現できる
-- ============================================================

-- ── 1. pgvector 拡張の有効化 ────────────────────────────────
create extension if not exists vector;

-- ── 2. wiki_chunks テーブル作成 ─────────────────────────────
-- ※ text-embedding-3-large (3072次元) を予定していたが
--    Supabase の HNSW インデックス上限 (2000次元) のため
--    text-embedding-3-small (1536次元) に変更。詳細: doc/DECISIONS.md
create table wiki_chunks (
  id text primary key,
  url text not null,
  title text not null,
  content_hash text not null,
  text text not null,
  embedding vector(1536),
  updated_at timestamp with time zone default now()
);

-- ── 3. HNSWインデックス作成 ──────────────────────────────────
create index on wiki_chunks
using hnsw (embedding vector_cosine_ops);

-- ── 4. 類似検索 RPC関数（初期版） ───────────────────────────
create or replace function match_wiki_chunks(
  query_embedding vector(1536),
  match_count int,
  similarity_threshold float
)
returns table (
  id text,
  url text,
  title text,
  text text,
  similarity float
)
language sql stable
as $$
  select id, url, title, text,
    1 - (embedding <=> query_embedding) as similarity
  from wiki_chunks
  where 1 - (embedding <=> query_embedding) >= similarity_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- ── 5. コメントページ除外フィルタ追加 ───────────────────────
-- ユーザー投稿の掲示板ページがRAGのノイズになるため除外
create or replace function match_wiki_chunks(
  query_embedding vector(1536),
  match_count int,
  similarity_threshold float
)
returns table (
  id text,
  url text,
  title text,
  text text,
  similarity float
)
language sql stable
as $$
  select id, url, title, text,
    1 - (embedding <=> query_embedding) as similarity
  from wiki_chunks
  where 1 - (embedding <=> query_embedding) >= similarity_threshold
    and url not like '%/コメント/%'
    and url not like '%E3%82%B3%E3%83%A1%E3%83%B3%E3%83%88%'
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- ── 6. pg_trgm 拡張の有効化（ハイブリッド検索用） ───────────
create extension if not exists pg_trgm;

-- ── 7. trigram GINインデックス追加 ──────────────────────────
create index if not exists wiki_chunks_text_trgm_idx
on wiki_chunks
using gin (text gin_trgm_ops);

-- ── 8. ハイブリッド検索 RPC関数（Vector + trigram + RRF） ───
-- word_similarity を使用（短いクエリ vs 長いチャンクの比較に適切）
create or replace function match_wiki_chunks(
  query_embedding vector(1536),
  query_text text,
  match_count int,
  similarity_threshold float
)
returns table (
  id text,
  url text,
  title text,
  text text,
  similarity float
)
language sql stable
as $$
  with vector_results as (
    select
      id, url, title, text,
      row_number() over (order by embedding <=> query_embedding) as rank
    from wiki_chunks
    where 1 - (embedding <=> query_embedding) >= similarity_threshold
      and url not like '%/コメント/%'
      and url not like '%E3%82%B3%E3%83%A1%E3%83%B3%E3%83%88%'
    limit 20
  ),
  trgm_results as (
    select
      id, url, title, text,
      row_number() over (order by word_similarity(query_text, text) desc) as rank
    from wiki_chunks
    where query_text <% text
      and url not like '%/コメント/%'
      and url not like '%E3%82%B3%E3%83%A1%E3%83%B3%E3%83%88%'
    limit 20
  ),
  rrf as (
    select
      coalesce(v.id, t.id) as id,
      coalesce(v.url, t.url) as url,
      coalesce(v.title, t.title) as title,
      coalesce(v.text, t.text) as text,
      coalesce(1.0 / (60 + v.rank), 0) + coalesce(1.0 / (60 + t.rank), 0) as rrf_score
    from vector_results v
    full outer join trgm_results t using (id)
  )
  select id, url, title, text, rrf_score as similarity
  from rrf
  order by rrf_score desc
  limit match_count;
$$;
