-- A production order is the plan the floor works to. Once it is released, what it makes, how
-- many and for which customer order may not change, and it may not be deleted: progress is worked
-- out from stock moves carrying its id, so changing the plan underneath them would rewrite history.
-- Only its state (released -> closed) and notes may change after release.

CREATE FUNCTION production_order_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'a % production order cannot be deleted', OLD.state
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.state IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'a % production order cannot be changed', OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state = 'released' THEN
    IF NEW.state NOT IN ('released', 'closed') THEN
      RAISE EXCEPTION 'a released production order can only be closed'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.bom_id IS DISTINCT FROM OLD.bom_id OR NEW.qty IS DISTINCT FROM OLD.qty
       OR NEW.sales_order_id IS DISTINCT FROM OLD.sales_order_id OR NEW.sales_order_line_id IS DISTINCT FROM OLD.sales_order_line_id
       OR NEW.number IS DISTINCT FROM OLD.number OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.order_date IS DISTINCT FROM OLD.order_date THEN
      RAISE EXCEPTION 'what a released production order makes cannot be changed'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER production_orders_guard
  BEFORE UPDATE OR DELETE ON production_orders
  FOR EACH ROW EXECUTE FUNCTION production_order_guard();
