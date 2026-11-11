import { and, asc, eq, sql } from "drizzle-orm";
import type { Executor, Transactor, Tx } from "../db/client";
import { approvalRequests, purchaseOrders, users } from "../db/schema";
import { approvalChain, canDecide, nextInChain } from "../domain/approval";
import { DomainError } from "../domain/errors";
import { formatINR } from "../domain/money";
import { assertPoTransition } from "../domain/purchasing";
import { recordAudit } from "./audit";
import { loadMembers } from "./members";
import { getPurchaseOrder, lockPurchaseOrder } from "./purchasing";

async function lockRequest(tx: Tx, companyId: string, requestId: string) {
  await tx.execute(sql`SELECT 1 FROM approval_requests WHERE company_id = ${companyId} AND id = ${requestId} FOR UPDATE`);
  const request = (
    await tx.select().from(approvalRequests).where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.id, requestId)))
  )[0];
  if (!request) throw new DomainError("UNKNOWN_APPROVAL", "That approval request does not exist");
  return request;
}

/**
 * Approve or reject a request that is waiting. The rule is enforced here, not in the screen:
 * the decider must belong to the company, must not be the person who asked, and must have an
 * approval limit that covers the amount (owners are unlimited, viewers can never approve).
 * Rejecting needs a reason. The decision is final.
 */
export async function decideApproval(
  db: Transactor,
  args: {
    companyId: string;
    requestId: string;
    actorUserId: string;
    decision: "approve" | "reject";
    comment?: string;
  },
) {
  return db.transaction(async (tx) => {
    const peek = (
      await tx.select().from(approvalRequests).where(and(eq(approvalRequests.companyId, args.companyId), eq(approvalRequests.id, args.requestId)))
    )[0];
    if (!peek) throw new DomainError("UNKNOWN_APPROVAL", "That approval request does not exist");
    // Lock the order first and the request second, the same order every purchase-order operation
    // uses, so a decision and a cancellation arriving together cannot deadlock.
    const order = await lockPurchaseOrder(tx, args.companyId, peek.docId);
    const request = await lockRequest(tx, args.companyId, args.requestId);
    if (request.state !== "pending") throw new DomainError("NOT_PENDING", `This request is already ${request.state}`);

    const actor = (await loadMembers(tx, args.companyId)).find((m) => m.userId === args.actorUserId);
    if (!actor) throw new DomainError("NOT_A_MEMBER", "That user does not belong to this company");
    if (actor.userId === request.requestedBy) {
      throw new DomainError("SELF_APPROVAL", "Nobody can approve their own request");
    }
    if (!canDecide({ actor, requesterId: request.requestedBy, amountPaise: request.amountPaise })) {
      throw new DomainError(
        "INSUFFICIENT_AUTHORITY",
        actor.role === "viewer"
          ? "A viewer cannot approve spending"
          : `This is for ${formatINR(request.amountPaise)}; your approval limit is ${formatINR(actor.limitPaise)}`,
      );
    }
    const comment = args.comment?.trim() || null;
    if (args.decision === "reject" && !comment) {
      throw new DomainError("COMMENT_REQUIRED", "Say why the request is being rejected");
    }

    if (order.state !== "pending_approval") {
      throw new DomainError("STALE_APPROVAL", `The order is ${order.state}, so this request can no longer be decided`);
    }
    const approved = args.decision === "approve";
    const now = new Date();
    assertPoTransition(order.state, approved ? "approved" : "rejected");

    await tx
      .update(approvalRequests)
      .set({ state: approved ? "approved" : "rejected", decidedBy: actor.userId, decidedAt: now, comment })
      .where(eq(approvalRequests.id, request.id));
    await tx
      .update(purchaseOrders)
      .set({ state: approved ? "approved" : "rejected", ...(approved ? { approvedAt: now } : {}) })
      .where(eq(purchaseOrders.id, order.id));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: actor.userId,
      action: approved ? "purchase_order.approved" : "purchase_order.rejected",
      entityType: "purchase_order",
      entityId: order.id,
      before: { state: "pending_approval" },
      after: { state: approved ? "approved" : "rejected", amountPaise: request.amountPaise, comment },
    });
    return getPurchaseOrder(tx, { companyId: args.companyId, orderId: order.id });
  });
}

/**
 * Pass a waiting request up to the next person whose limit covers it. The person it is waiting
 * on, the person who asked, or an owner can do this. It stops at the top of the chain.
 */
export async function escalateApproval(
  db: Transactor,
  args: { companyId: string; requestId: string; actorUserId: string },
) {
  return db.transaction(async (tx) => {
    const request = await lockRequest(tx, args.companyId, args.requestId);
    if (request.state !== "pending") throw new DomainError("NOT_PENDING", `This request is already ${request.state}`);

    const members = await loadMembers(tx, args.companyId);
    const actor = members.find((m) => m.userId === args.actorUserId);
    if (!actor) throw new DomainError("NOT_A_MEMBER", "That user does not belong to this company");
    const allowed = actor.userId === request.assignedTo || actor.userId === request.requestedBy || actor.role === "owner";
    if (!allowed) throw new DomainError("NOT_ALLOWED", "Only the person it is waiting on, the requester or an owner can escalate");

    const chain = approvalChain(request.amountPaise, request.requestedBy, members);
    const next = nextInChain(chain, request.assignedTo);
    if (!next) throw new DomainError("NO_HIGHER_APPROVER", "It is already with the highest authority available");

    await tx
      .update(approvalRequests)
      .set({ assignedTo: next.userId, escalationCount: request.escalationCount + 1 })
      .where(eq(approvalRequests.id, request.id));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: actor.userId,
      action: "approval.escalated",
      entityType: "approval_request",
      entityId: request.id,
      before: { assignedTo: request.assignedTo },
      after: { assignedTo: next.userId },
    });
    return (await tx.select().from(approvalRequests).where(eq(approvalRequests.id, request.id)))[0];
  });
}

export interface PendingApproval {
  requestId: string;
  docType: string;
  docId: string;
  docNumber: string | null;
  supplierName: string;
  amountPaise: number;
  requestedBy: string;
  requestedByName: string;
  assignedTo: string | null;
  assignedToName: string | null;
  escalationCount: number;
  createdAt: Date;
  /** Whether `forUserId` may approve or reject it. Only set when `forUserId` is given. */
  canDecide?: boolean;
}

/** Everything waiting for an OK, oldest first: the "Decide" list. */
export async function listPendingApprovals(
  db: Executor,
  args: { companyId: string; forUserId?: string },
): Promise<PendingApproval[]> {
  const requests = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.companyId, args.companyId), eq(approvalRequests.state, "pending")))
    .orderBy(asc(approvalRequests.createdAt), asc(approvalRequests.id));
  if (requests.length === 0) return [];
  const names = new Map((await db.select({ id: users.id, name: users.name }).from(users)).map((u) => [u.id, u.name]));
  const orders = new Map(
    (await db.select().from(purchaseOrders).where(eq(purchaseOrders.companyId, args.companyId))).map((o) => [o.id, o]),
  );
  const actor = args.forUserId ? (await loadMembers(db, args.companyId)).find((m) => m.userId === args.forUserId) : undefined;
  return requests.map((r): PendingApproval => {
    const order = orders.get(r.docId);
    return {
      requestId: r.id,
      docType: r.docType,
      docId: r.docId,
      docNumber: order?.number ?? null,
      supplierName: order?.supplierName ?? "",
      amountPaise: r.amountPaise,
      requestedBy: r.requestedBy,
      requestedByName: names.get(r.requestedBy) ?? "",
      assignedTo: r.assignedTo,
      assignedToName: r.assignedTo ? (names.get(r.assignedTo) ?? null) : null,
      escalationCount: r.escalationCount,
      createdAt: r.createdAt,
      ...(args.forUserId
        ? { canDecide: actor ? canDecide({ actor, requesterId: r.requestedBy, amountPaise: r.amountPaise }) : false }
        : {}),
    };
  });
}
