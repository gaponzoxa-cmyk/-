#!/usr/bin/env bash
# Прогон миграций и проверок базы на локальном Postgres (нужен psql).
# Использование: PGURL=postgres://postgres@localhost:5432/postgres scripts/test-db.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PGURL="${PGURL:-postgres://postgres@localhost:5432/postgres}"
DB="kassa_test_$$"
psql "$PGURL" -qc "create database $DB"
trap 'psql "$PGURL" -qc "drop database if exists $DB" >/dev/null' EXIT
TURL="${PGURL%/*}/$DB"
psql "$TURL" -q -v ON_ERROR_STOP=1 -f supabase/tests/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do psql "$TURL" -q -v ON_ERROR_STOP=1 -f "$f"; done
psql "$TURL" -q -v ON_ERROR_STOP=1 -f supabase/tests/10_rls_and_totals.sql
