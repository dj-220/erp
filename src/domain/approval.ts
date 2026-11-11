import { DomainError } from "./errors";
import type { Paise } from "./money";

export type Role = "owner" | "admin" | "accountant" | "purchase" | "sales" | "stores" | "viewer";

export interface Member {
  userId: string;
  role: Role;
  /** Largest single amount this person may approve, in paise. */
  limitPaise: Paise;
}

/**
 * Whether a person may commit the company to spend this amount. Owners are unlimited, viewers
 * can never approve anything, everyone else is held to their personal limit. This is the single
 * place the rule lives; the database stores the limits, this decides.
 */
export function canCommit(member: Member, amountPaise: Paise): boolean {
  if (member.role === "viewer") return false;
  return member.role === "owner" || member.limitPaise >= amountPaise;
}

/**
 * The people who could approve an amount for this requester, in the order it should climb:
 * lowest sufficient limit first, owners last, ties broken by id so the order is always the same.
 * Nobody approves their own request.
 */
export function approvalChain(amountPaise: Paise, requesterId: string, members: readonly Member[]): Member[] {
  const weight = (m: Member) => (m.role === "owner" ? Number.POSITIVE_INFINITY : m.limitPaise);
  return members
    .filter((m) => m.userId !== requesterId && canCommit(m, amountPaise))
    .sort((a, b) => {
      const wa = weight(a);
      const wb = weight(b);
      return wa === wb ? a.userId.localeCompare(b.userId) : wa < wb ? -1 : 1;
    });
}

export type ApprovalPlan = { auto: true } | { auto: false; assignee: Member; chain: Member[] };

/**
 * What happens when a requester submits a document for approval. Within their own limit it goes
 * through at once (and is recorded as such). Otherwise it goes to the next person up the chain.
 */
export function planApproval(args: { amountPaise: Paise; requester: Member; members: readonly Member[] }): ApprovalPlan {
  if (canCommit(args.requester, args.amountPaise)) return { auto: true };
  const chain = approvalChain(args.amountPaise, args.requester.userId, args.members);
  const assignee = chain[0];
  if (!assignee) {
    throw new DomainError(
      "NO_APPROVER",
      "Nobody else in the company has an approval limit high enough for this amount; raise someone's limit or ask an owner",
    );
  }
  return { auto: false, assignee, chain };
}

/** Whether `actor` may approve or reject a request raised by `requesterId` for this amount. */
export function canDecide(args: { actor: Member; requesterId: string; amountPaise: Paise }): boolean {
  return args.actor.userId !== args.requesterId && canCommit(args.actor, args.amountPaise);
}

/** The next person up the chain after `currentUserId`, or undefined at the top. */
export function nextInChain(chain: readonly Member[], currentUserId: string | null): Member | undefined {
  const at = chain.findIndex((m) => m.userId === currentUserId);
  return chain[at + 1]; // at = -1 (not in chain) gives the first
}
