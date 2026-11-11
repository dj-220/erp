-- The stock ledger is evidence, like the audit log: once a stock document is posted (done) or
-- cancelled, neither it nor its moves may change. Corrections are made with new documents.
-- A guardrail against application bugs and ordinary users; a database owner can drop the triggers.

CREATE FUNCTION stock_move_guard() RETURNS trigger AS $$
DECLARE
  doc_state stock_state;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT state INTO doc_state FROM stock_documents WHERE id = NEW.document_id;
    IF doc_state IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'cannot add a stock move to a % document', doc_state
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state <> 'draft' THEN
    RAISE EXCEPTION 'a % stock move cannot be changed or deleted', OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER stock_moves_guard
  BEFORE INSERT OR UPDATE OR DELETE ON stock_moves
  FOR EACH ROW EXECUTE FUNCTION stock_move_guard();
--> statement-breakpoint
CREATE FUNCTION stock_document_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'draft' THEN
    RAISE EXCEPTION 'a % stock document cannot be changed or deleted', OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER stock_documents_guard
  BEFORE UPDATE OR DELETE ON stock_documents
  FOR EACH ROW EXECUTE FUNCTION stock_document_guard();
