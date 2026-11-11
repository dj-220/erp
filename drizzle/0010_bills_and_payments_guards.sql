-- Bills and payments are the company's money, so the rules are enforced here as well as in code.
--  * A supplier bill moves draft -> held / matched -> posted (or rejected / cancelled). Once recorded,
--    what it says is frozen; once posted, rejected or cancelled nothing about it can change.
--  * A payment is a fact: it can be reversed (with a reason) but never edited or deleted.
--  * Allocations of a payment to bills and invoices are append-only, and never exceed the payment.
-- A guardrail against application bugs and ordinary users; a database owner can drop the triggers.

CREATE FUNCTION purchase_bill_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'a % purchase bill cannot be deleted', OLD.state
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.state IN ('posted', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'a % purchase bill cannot be changed', OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'draft' AND NEW.state IN ('held', 'matched', 'cancelled'))
    OR (OLD.state = 'held' AND NEW.state IN ('matched', 'rejected'))
    OR (OLD.state = 'matched' AND NEW.state IN ('posted', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'a purchase bill cannot go from % to %', OLD.state, NEW.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.state <> 'draft' AND (
       NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
    OR NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id
    OR NEW.supplier_bill_no IS DISTINCT FROM OLD.supplier_bill_no
    OR NEW.supplier_bill_key IS DISTINCT FROM OLD.supplier_bill_key
    OR NEW.bill_date IS DISTINCT FROM OLD.bill_date
    OR NEW.due_date IS DISTINCT FROM OLD.due_date
    OR NEW.supplier_gstin_on_bill IS DISTINCT FROM OLD.supplier_gstin_on_bill
    OR NEW.stated_taxable_paise IS DISTINCT FROM OLD.stated_taxable_paise
    OR NEW.stated_cgst_paise IS DISTINCT FROM OLD.stated_cgst_paise
    OR NEW.stated_sgst_paise IS DISTINCT FROM OLD.stated_sgst_paise
    OR NEW.stated_utgst_paise IS DISTINCT FROM OLD.stated_utgst_paise
    OR NEW.stated_igst_paise IS DISTINCT FROM OLD.stated_igst_paise
    OR NEW.stated_cess_paise IS DISTINCT FROM OLD.stated_cess_paise
    OR NEW.stated_round_off_paise IS DISTINCT FROM OLD.stated_round_off_paise
    OR NEW.stated_total_paise IS DISTINCT FROM OLD.stated_total_paise
  ) THEN
    RAISE EXCEPTION 'what a recorded purchase bill says cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER purchase_bills_guard
  BEFORE UPDATE OR DELETE ON purchase_bills
  FOR EACH ROW EXECUTE FUNCTION purchase_bill_guard();
--> statement-breakpoint
CREATE FUNCTION purchase_bill_line_guard() RETURNS trigger AS $$
DECLARE
  parent_state bill_state;
  parent_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN parent_id := NEW.bill_id; ELSE parent_id := OLD.bill_id; END IF;
  SELECT state INTO parent_state FROM purchase_bills WHERE id = parent_id;
  IF parent_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'lines of a % purchase bill cannot be changed', parent_state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER purchase_bill_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_bill_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_bill_line_guard();
--> statement-breakpoint
CREATE FUNCTION payment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments cannot be deleted; reverse them instead'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state = 'reversed' THEN
    RAISE EXCEPTION 'a reversed payment cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.party_id IS DISTINCT FROM OLD.party_id
     OR NEW.payment_date IS DISTINCT FROM OLD.payment_date
     OR NEW.amount_paise IS DISTINCT FROM OLD.amount_paise
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a recorded payment cannot be edited; reverse it and record it again'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payments_guard
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payment_guard();
--> statement-breakpoint
CREATE FUNCTION payment_allocation_guard() RETURNS trigger AS $$
DECLARE
  pay_state payment_state;
  pay_amount bigint;
  already bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payment allocations cannot be changed or deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT state, amount_paise INTO pay_state, pay_amount FROM payments WHERE id = NEW.payment_id;
  IF pay_state IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'money cannot be allocated from a % payment', pay_state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT coalesce(sum(amount_paise), 0) INTO already FROM payment_allocations WHERE payment_id = NEW.payment_id;
  IF already + NEW.amount_paise > pay_amount THEN
    RAISE EXCEPTION 'allocations (%) would exceed the payment (%)', already + NEW.amount_paise, pay_amount
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_allocations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION payment_allocation_guard();
