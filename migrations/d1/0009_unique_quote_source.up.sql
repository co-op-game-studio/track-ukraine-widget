-- Defense-in-depth uniqueness for quotes.
--
-- `createQuote` does a SELECT-then-INSERT to detect "this URL already has a
-- quote for this rep" and surface a friendly 409. Two concurrent admin clicks
-- on the same source can race past the SELECT and double-INSERT.
-- A DB-level UNIQUE turns the race into an INSERT failure that the
-- existing duplicate_source error path handles cleanly.
--
-- Existing rows: this is a no-op for the current dataset (single-author
-- workflow, no observed dupes), but if the apply ever fails it means there
-- ARE existing duplicates and they must be reconciled before the index
-- can be created.

CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_unique_source_per_rep
  ON quotes (source_url, bioguide_id);
