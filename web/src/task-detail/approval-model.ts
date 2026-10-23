/**
 * The task page's Approvals section as data: approval.list's requests and
 * votes grouped by EDGE (the task moving from one status to another), the
 * shape the section renders. Pure — no DOM, no signals — so the rules are
 * tested directly.
 *
 * Rules (mirroring the server, see db/schema/functions/approval_*.sql):
 *   - A vote belongs to its edge; a request asks people to vote on one.
 *   - An edge's votes run in rounds: a vote is `settled` once the task
 *     reached the edge's target after it. Current-round votes are the live
 *     ones; a person's latest current-round vote is their answer.
 *   - A request is open until the task reaches its target (`reachedAt`).
 *     An open request's asked people show their current-round vote; a
 *     settled request shows each one's last vote before it settled.
 *   - Votes from people nobody asked — and agents, whose votes never answer
 *     for a person — show as "others", latest per voter, current round only.
 */

import type { ApprovalAction, ApprovalListOutput, ApprovalRequest, ApprovalVote, StatusRef } from './approval-specs.js';

export interface AskedView {
  personId: bigint;
  name: string;
  /** Their answer: latest current-round vote (open) or last vote before it settled. */
  vote: ApprovalVote | null;
}

export interface RequestView {
  request: ApprovalRequest;
  /** Still open: the task hasn't reached the target since it was asked. */
  open: boolean;
  asked: AskedView[];
  approved: number;
  rejected: number;
}

export interface EdgeView {
  /** `${fromId}>${toId}`. */
  key: string;
  from: StatusRef;
  to: StatusRef;
  /** The action's name ("Approve"), from the flow or the latest request / vote. */
  action: string;
  /** Requests on this edge, open ones first, then newest first. */
  requests: RequestView[];
  /** Current-round votes by voters no open request asks (incl. agents). */
  others: ApprovalVote[];
  /** The viewer's own current-round vote on the edge. */
  mine: ApprovalVote | null;
  /** Whether an open request asks the viewer and they haven't voted this round. */
  waitingOnMe: boolean;
  /** Every vote on the edge, newest first. */
  history: ApprovalVote[];
}

export interface Viewer {
  userId: bigint | null;
  personId: bigint | null;
}

export function edgeKey(fromId: bigint, toId: bigint): string {
  return `${fromId.toString()}>${toId.toString()}`;
}

function time(s: string): number {
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

/** Latest vote per voter (person, or the account for an agent) — votes come newest first. */
function latestPerVoter(votes: readonly ApprovalVote[]): ApprovalVote[] {
  const seen = new Set<string>();
  const out: ApprovalVote[] = [];
  for (const v of votes) {
    const k = v.personId !== 0n ? `p${v.personId.toString()}` : `u${v.byId.toString()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/**
 * Group approval.list into edges. Edges with an open request come first
 * (oldest request first), then the rest by their latest vote / request.
 */
export function buildApprovalEdges(list: ApprovalListOutput, viewer: Viewer): EdgeView[] {
  const statusById = new Map<string, StatusRef>();
  const labelByEdge = new Map<string, string>();
  for (const a of list.actions) {
    statusById.set(a.from.id.toString(), a.from);
    statusById.set(a.to.id.toString(), a.to);
    labelByEdge.set(edgeKey(a.from.id, a.to.id), a.label);
  }
  for (const r of list.requests) {
    statusById.set(r.from.id.toString(), r.from);
    statusById.set(r.to.id.toString(), r.to);
  }
  const status = (id: bigint): StatusRef =>
    statusById.get(id.toString()) ?? { id, label: `#${id.toString()}`, phase: '' };

  const keys: string[] = [];
  const edges = new Map<string, EdgeView>();
  const edgeFor = (from: StatusRef, to: StatusRef, action: string): EdgeView => {
    const key = edgeKey(from.id, to.id);
    let e = edges.get(key);
    if (e === undefined) {
      e = {
        key,
        from,
        to,
        action: labelByEdge.get(key) ?? action,
        requests: [],
        others: [],
        mine: null,
        waitingOnMe: false,
        history: [],
      };
      edges.set(key, e);
      keys.push(key);
    }
    return e;
  };

  for (const r of list.requests) edgeFor(r.from, r.to, r.action);
  for (const v of list.decisions) edgeFor(status(v.fromId), status(v.toId), v.action).history.push(v);

  for (const e of edges.values()) {
    const current = e.history.filter((v) => !v.settled);
    const currentLatest = latestPerVoter(current);
    const asked = new Set<string>();
    for (const r of list.requests) {
      if (edgeKey(r.from.id, r.to.id) !== e.key) continue;
      const open = r.reachedAt === '';
      const cutoff = open ? Infinity : time(r.reachedAt);
      const answers = latestPerVoter(open ? current : e.history.filter((v) => time(v.at) <= cutoff));
      const askedViews = r.approvers.map((p) => ({
        personId: p.personId,
        name: p.name,
        vote: answers.find((v) => v.personId === p.personId) ?? null,
      }));
      if (open) for (const p of r.approvers) asked.add(p.personId.toString());
      e.requests.push({
        request: r,
        open,
        asked: askedViews,
        approved: askedViews.filter((a) => a.vote?.decision === 'approve').length,
        rejected: askedViews.filter((a) => a.vote?.decision === 'reject').length,
      });
    }
    e.requests.sort((a, b) =>
      a.open !== b.open ? (a.open ? -1 : 1) : time(b.request.requestedAt) - time(a.request.requestedAt),
    );
    e.others = currentLatest.filter((v) => v.personId === 0n || !asked.has(v.personId.toString()));
    e.mine = viewer.userId === null ? null : (current.find((v) => v.byId === viewer.userId) ?? null);
    e.waitingOnMe =
      viewer.personId !== null &&
      e.mine === null &&
      e.requests.some((r) => r.open && r.request.approvers.some((p) => p.personId === viewer.personId));
  }

  const lastTouch = (e: EdgeView): number =>
    Math.max(
      0,
      ...e.history.map((v) => time(v.at)),
      ...e.requests.map((r) => time(r.request.requestedAt)),
    );
  const firstOpen = (e: EdgeView): number => {
    const open = e.requests.filter((r) => r.open).map((r) => time(r.request.requestedAt));
    return open.length === 0 ? Infinity : Math.min(...open);
  };
  return keys
    .map((k) => edges.get(k))
    .filter((e): e is EdgeView => e !== undefined)
    .sort((a, b) => {
      const ao = firstOpen(a);
      const bo = firstOpen(b);
      if (ao !== bo) return ao - bo;
      return lastTouch(b) - lastTouch(a);
    });
}

/** The edges a vote or request can name: the flow's steps, those leaving the
 *  task's current status first. */
export function actionChoices(list: ApprovalListOutput): ApprovalAction[] {
  const cur = list.status?.id ?? null;
  const here = list.actions.filter((a) => a.from.id === cur);
  const rest = list.actions.filter((a) => a.from.id !== cur);
  return [...here, ...rest];
}

/** "Review → Done (Approve)" (see {@link stepText}). */
export function edgeLabel(action: string, from: StatusRef, to: StatusRef): string {
  return stepText(action, from.label, to.label);
}

/** A status step as people read it, "Review → Done (Approve)": the step
 *  first and the flow's action name after it, so a vote on the step never
 *  reads as the status change itself. */
export function stepText(action: string, from: string, to: string): string {
  return action === '' ? `${from} → ${to}` : `${from} → ${to} (${action})`;
}

/** How a vote reads: "Voted approve" / "Voted reject" — a vote, not the
 *  workflow's own Approve step. */
export function voteWords(decision: 'approve' | 'reject'): string {
  return decision === 'approve' ? 'Voted approve' : 'Voted reject';
}
