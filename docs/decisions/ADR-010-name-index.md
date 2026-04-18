# ADR-010: Congress Member Name Index for Name-Based Lookup

**Status**: Superseded by ADR-011
**Date**: 2026-04-17

Name-search functionality is retained (see FR-31), but the design has been folded into [ADR-011: KV as Sole First-Class Datastore](./ADR-011-kv-sole-datastore.md), which treats `name-index:v1:*` as one of four prefixes in a unified KV store rather than as a separate pipeline with its own trust boundary.

See ADR-011 §"Derived name-search index" for the current design.
