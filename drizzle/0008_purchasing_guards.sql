-- Purchasing records commit the company's money, so the rules are enforced here as well as in code.
--  * A purchase order can only move along draft -> pending approval -> approved -> sent -> closed
--    (or rejected / cancelled); once submitted its terms and amounts are frozen.
--  * A purchase request is editable only as a draft.
--  * A decided approval can never change, and no approval can be deleted.
-- A guardrail against application bugs and ordinary users; a database owner can drop the triggers.

CREATE FUNCTION purchase_order_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'a % purchase order cannot be deleted', OLD.state
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.state IN ('rejected', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'a % purchase order cannot be changed', OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'draft' AND NEW.state IN ('pending_approval', 'approved', 'cancelled'))
    OR (OLD.state = 'pending_approval' AND NEW.state IN ('approved', 'rejected', 'cancelled'))
    OR (OLD.state = 'approved' AND NEW.state IN ('sent', 'closed', 'cancelled'))
    OR (OLD.state = 'sent' AND NEW.state IN ('closed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'a purchase order cannot go from % to %', OLD.state, NEW.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.state <> 'draft' AND (
       NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
    OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
    OR NEW.order_date IS DISTINCT FROM OLD.order_date
    OR NEW.expected_date IS DISTINCT FROM OLD.expected_date
    OR NEW.place_of_supply_state_code IS DISTINCT FROM OLD.place_of_supply_state_code
    OR NEW.taxable_value_paise IS DISTINCT FROM OLD.taxable_value_paise
    OR NEW.total_paise IS DISTINCT FROM OLD.total_paise
    OR NEW.number IS DISTINCT FROM OLD.number
  ) THEN
    RAISE EXCEPTION 'the terms of a submitted purchase order cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER purchase_orders_guard
  BEFORE UPDATE OR DELETE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_order_guard();
--> statement-breakpoint
CREATE FUNCTION purchase_order_line_guard() RETURNS trigger AS $$
DECLARE
  parent_state purchase_order_state;
  parent_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN parent_id := NEW.order_id; ELSE parent_id := OLD.order_id; END IF;
  SELECT state INTO parent_state FROM purchase_orders WHERE id = parent_id;
  IF parent_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'lines of a % purchase order cannot be changed', parent_state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER purchase_order_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_order_line_guard();
--> statement-breakpoint
CREATE FUNCTION purchase_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'a % purchase request cannot be deleted', OLD.state
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.state IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'a % purchase request cannot be changed', OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'draft' AND NEW.state IN ('submitted', 'cancelled'))
    OR (OLD.state = 'submitted' AND NEW.state IN ('closed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'a purchase request cannot go from % to %', OLD.state, NEW.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.state = 'submitted' AND (
       NEW.request_date IS DISTINCT FROM OLD.request_date
    OR NEW.needed_by IS DISTINCT FROM OLD.needed_by
    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
    OR NEW.number IS DISTINCT FROM OLD.number
  ) THEN
    RAISE EXCEPTION 'a submitted purchase request can only be closed or cancelled'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER purchase_requests_guard
  BEFORE UPDATE OR DELETE ON purchase_requests
  FOR EACH ROW EXECUTE FUNCTION purchase_request_guard();
--> statement-breakpoint
CREATE FUNCTION purchase_request_line_guard() RETURNS trigger AS $$
DECLARE
  parent_state purchase_request_state;
  parent_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN parent_id := NEW.request_id; ELSE parent_id := OLD.request_id; END IF;
  SELECT state INTO parent_state FROM purchase_requests WHERE id = parent_id;
  IF parent_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'lines of a % purchase request cannot be changed', parent_state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER purchase_request_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_request_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_request_line_guard();
--> statement-breakpoint
CREATE FUNCTION approval_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval requests cannot be deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'a % approval request cannot be changed', OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.doc_type IS DISTINCT FROM OLD.doc_type
     OR NEW.doc_id IS DISTINCT FROM OLD.doc_id
     OR NEW.amount_paise IS DISTINCT FROM OLD.amount_paise
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'what an approval request asks for cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER approval_requests_guard
  BEFORE UPDATE OR DELETE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION approval_request_guard();
