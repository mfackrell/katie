-- Task 4A: make the existing owner financial preview executable in production.
-- The already-deployed, read-only task4a_postpaid_proposal runs as service_role
-- through the authenticated owner API. When it receives p_limits, it calls the
-- private immutable developer_validate_limits(jsonb). The original Developer
-- migration revoked this helper's EXECUTE permission even from service_role.
-- As a result GET (NULL limits) worked but POST preview (exact limits) returned
-- PostgreSQL 42501 / PostgREST HTTP 403. No spending authority was created.
--
-- Restore EXECUTE to the trusted backend role ONLY. This pure validator cannot
-- create authorizations, grants, provider calls, claims, or any database changes.
-- Keep anonymous and signed-in client roles excluded: owner authentication,
-- actual authority approval and all spending boundaries remain unchanged.
revoke all on function public.developer_validate_limits(jsonb)
  from public, anon, authenticated;
grant execute on function public.developer_validate_limits(jsonb)
  to service_role;
