-- What has been handed to the accountant is a record of fact: export batches and the list of
-- documents in them may be added to, never changed or removed.
CREATE FUNCTION export_records_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% records are append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER export_batches_append_only
  BEFORE UPDATE OR DELETE ON export_batches
  FOR EACH ROW EXECUTE FUNCTION export_records_append_only();
--> statement-breakpoint
CREATE TRIGGER exported_documents_append_only
  BEFORE UPDATE OR DELETE ON exported_documents
  FOR EACH ROW EXECUTE FUNCTION export_records_append_only();
