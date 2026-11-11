-- Sales documents are legal and commercial records.
--  * A confirmed sales order can only be closed or cancelled; its terms and lines are frozen.
--  * A posted (or cancelled) invoice, credit note or debit note, and its lines, can never change.
-- A guardrail against application bugs and ordinary users; a database owner can drop the triggers.

CREATE FUNCTION sales_order_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'a % sales order cannot be deleted', OLD.state
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.state IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'a % sales order cannot be changed', OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.state = 'confirmed' THEN
    IF NEW.state NOT IN ('confirmed', 'closed', 'cancelled')
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.order_date IS DISTINCT FROM OLD.order_date
       OR NEW.promised_date IS DISTINCT FROM OLD.promised_date
       OR NEW.ship_to_state_code IS DISTINCT FROM OLD.ship_to_state_code
       OR NEW.customer_po_ref IS DISTINCT FROM OLD.customer_po_ref
       OR NEW.number IS DISTINCT FROM OLD.number THEN
      RAISE EXCEPTION 'a confirmed sales order can only be closed or cancelled'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.state NOT IN ('draft', 'confirmed', 'cancelled') THEN
    RAISE EXCEPTION 'a draft sales order cannot become %', NEW.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER sales_orders_guard
  BEFORE UPDATE OR DELETE ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION sales_order_guard();
--> statement-breakpoint
CREATE FUNCTION sales_order_line_guard() RETURNS trigger AS $$
DECLARE
  parent_state sales_order_state;
  parent_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN parent_id := NEW.order_id; ELSE parent_id := OLD.order_id; END IF;
  SELECT state INTO parent_state FROM sales_orders WHERE id = parent_id;
  IF parent_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'lines of a % sales order cannot be changed', parent_state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER sales_order_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION sales_order_line_guard();
--> statement-breakpoint
CREATE FUNCTION sales_invoice_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'draft' THEN
    RAISE EXCEPTION 'a % sales invoice cannot be changed or deleted', OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER sales_invoices_guard
  BEFORE UPDATE OR DELETE ON sales_invoices
  FOR EACH ROW EXECUTE FUNCTION sales_invoice_guard();
--> statement-breakpoint
CREATE FUNCTION sales_invoice_line_guard() RETURNS trigger AS $$
DECLARE
  parent_state sales_invoice_state;
  parent_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN parent_id := NEW.invoice_id; ELSE parent_id := OLD.invoice_id; END IF;
  SELECT state INTO parent_state FROM sales_invoices WHERE id = parent_id;
  IF parent_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'lines of a % sales invoice cannot be changed', parent_state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER sales_invoice_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION sales_invoice_line_guard();
