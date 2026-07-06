-- Test helpers cho script skeleton 4 (scripts/verify-rls.ts)
--
-- Auto-discovery bảng org-scoped + column metadata cho auto-seed row.
-- REVOKE PUBLIC + GRANT service_role: chỉ admin client gọi được, tenant/anon
-- không truy cập schema metadata qua RPC này.
--
-- Đây là 2 RPC helper CHO SCRIPT TEST, không phần production runtime.

-- ============================================================================
-- list_org_scoped_tables() — duyệt information_schema tìm bảng có organization_id
-- ============================================================================
CREATE OR REPLACE FUNCTION public.list_org_scoped_tables()
RETURNS TABLE(table_name text)
LANGUAGE sql STABLE
AS $$
  SELECT c.table_name::text
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.column_name = 'organization_id'
  ORDER BY c.table_name;
$$;

REVOKE EXECUTE ON FUNCTION public.list_org_scoped_tables() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_org_scoped_tables() TO service_role;

-- ============================================================================
-- get_table_columns(text) — column metadata cho auto-seed NOT NULL row
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_table_columns(p_table text)
RETURNS TABLE(
  column_name text,
  data_type text,
  is_nullable text,
  column_default text
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.column_name::text,
    c.data_type::text,
    c.is_nullable::text,
    c.column_default::text
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = p_table
  ORDER BY c.ordinal_position;
$$;

REVOKE EXECUTE ON FUNCTION public.get_table_columns(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_table_columns(text) TO service_role;
