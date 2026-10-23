// Package activitysink: predicate.go defines the small filter DSL stored
// in the `activity_filter` attribute on each activity_sink card.
//
// The pump evaluates the predicate in Go against a single activity row;
// it does NOT compile to SQL (the row set is already narrowed by the
// id-and-project scan). The DSL intentionally mirrors the operator/items
// shape used by the existing client toggle_groups specs so an admin
// editing JSON-by-hand recognises the structure.
//
// Empty / missing predicate accepts every row — operators turn on the
// pump first, then dial filtering in.
package activitysink

import (
	"encoding/json"
	"strconv"
)

// Predicate is one node in the activity filter tree.
//
//   - Op "and" / "or" — composite; Items lists the children.
//   - Op "kind_in"    — leaf; Values lists activity kinds (card_create,
//                       attr_update, comment, …) — match if row.Kind is in.
//   - Op "kind_not_in" — leaf; inverse.
//   - Op "attr_in"    — leaf; Values lists attribute_def names — match if
//                       row was kind=attr_update AND row.AttributeName ∈ Values.
//   - Op "attr_not_in" — leaf; inverse (still requires kind=attr_update;
//                       non-attr rows are accepted by this op so it only
//                       filters within the attr_update slice).
//   - Op "actor_in" / "actor_not_in" — leaf; Values are decimal user ids,
//                       "@me" (the subscriber) or "@my_agents" (the agents
//                       the subscriber owns), see WithSubscriber.
//   - Op "approval_asks_in" — leaf; Values are person card ids or "@me"
//                       (the subscriber's person): match a change that asks
//                       one of them to approve — an approval request's
//                       approvers gaining them, which includes being asked
//                       when the request is created.
//
// A predicate with Op == "" matches every row. Unknown ops fail closed
// (return false) so a typo doesn't silently flood the channel.
type Predicate struct {
	Op     string      `json:"op,omitempty"`
	Values []string    `json:"values,omitempty"`
	Items  []Predicate `json:"items,omitempty"`
}

// ActivityRow is the minimal row shape the predicate evaluator inspects.
// Mirrors the columns the pump's SELECT pulls in.
type ActivityRow struct {
	ID            int64
	CardID        int64
	Kind          string
	AttributeName string // empty when row is not an attr_update
	ActorID       int64
	// AddedApprovers are the person ids an `approvers` change added (new
	// minus old) — who the row asks to approve. Empty for any other row.
	AddedApprovers []int64
}

// Subscriber is who a personal subscription's tokens resolve to.
type Subscriber struct {
	UserID   int64   // "@me" in actor leaves
	AgentIDs []int64 // "@my_agents"
	PersonID int64   // "@me" in approval_asks_in leaves
}

// ParsePredicate decodes a predicate from its stored JSON form. An empty
// / whitespace input yields the zero Predicate (matches everything).
// Invalid JSON returns an error so the pump can MarkChannelFault and
// stop emitting noise until the admin fixes the filter.
func ParsePredicate(raw string) (Predicate, error) {
	if raw == "" {
		return Predicate{}, nil
	}
	// Tolerate whitespace-only payloads — the admin UI may write `"  "`
	// when clearing the field.
	trimmed := raw
	for len(trimmed) > 0 && (trimmed[0] == ' ' || trimmed[0] == '\t' || trimmed[0] == '\n' || trimmed[0] == '\r') {
		trimmed = trimmed[1:]
	}
	if trimmed == "" {
		return Predicate{}, nil
	}
	var p Predicate
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		return Predicate{}, err
	}
	return p, nil
}

// Eval returns true when the row should be pushed downstream. The empty
// predicate (Op=="") always matches. Unknown ops match nothing.
func (p Predicate) Eval(row ActivityRow) bool {
	switch p.Op {
	case "":
		return true
	case "and":
		for _, c := range p.Items {
			if !c.Eval(row) {
				return false
			}
		}
		return true
	case "or":
		if len(p.Items) == 0 {
			// An empty or-group has no positive case — treat as fail-closed.
			return false
		}
		for _, c := range p.Items {
			if c.Eval(row) {
				return true
			}
		}
		return false
	case "kind_in":
		return inStrings(row.Kind, p.Values)
	case "kind_not_in":
		return !inStrings(row.Kind, p.Values)
	case "attr_in":
		if row.Kind != "attr_update" || row.AttributeName == "" {
			return false
		}
		return inStrings(row.AttributeName, p.Values)
	case "attr_not_in":
		if row.Kind != "attr_update" {
			return true
		}
		return !inStrings(row.AttributeName, p.Values)
	case "actor_in":
		return inInt64String(row.ActorID, p.Values)
	case "actor_not_in":
		return !inInt64String(row.ActorID, p.Values)
	case "approval_asks_in":
		for _, id := range row.AddedApprovers {
			if inInt64String(id, p.Values) {
				return true
			}
		}
		return false
	}
	return false
}

// myAgentsToken stands for every agent the subscriber owns, so "not
// done by me" can also leave out what their agents did for them.
const myAgentsToken = "@my_agents"

// WithSubscriber returns a copy of the predicate with the subscriber
// tokens resolved: in actor_in / actor_not_in leaves "@me" becomes the
// subscriber's user id and "@my_agents" their agents' ids (none → the
// token just drops out) — so a personal subscription can say "not done by
// me or my agents"; in approval_asks_in leaves "@me" becomes their person
// id ("approvals asked of me"). Without a subscriber (UserID == 0, a
// broadcast sink) the tokens stay literal and match nothing.
func (p Predicate) WithSubscriber(s Subscriber) Predicate {
	if s.UserID == 0 {
		return p
	}
	out := Predicate{Op: p.Op}
	actorLeaf := p.Op == "actor_in" || p.Op == "actor_not_in"
	for _, v := range p.Values {
		switch {
		case actorLeaf && v == meToken:
			out.Values = append(out.Values, strconv.FormatInt(s.UserID, 10))
		case actorLeaf && v == myAgentsToken:
			for _, id := range s.AgentIDs {
				out.Values = append(out.Values, strconv.FormatInt(id, 10))
			}
		case p.Op == "approval_asks_in" && v == meToken && s.PersonID != 0:
			out.Values = append(out.Values, strconv.FormatInt(s.PersonID, 10))
		default:
			out.Values = append(out.Values, v)
		}
	}
	if len(p.Items) > 0 {
		out.Items = make([]Predicate, len(p.Items))
		for i, c := range p.Items {
			out.Items[i] = c.WithSubscriber(s)
		}
	}
	return out
}

func inStrings(needle string, hay []string) bool {
	for _, v := range hay {
		if v == needle {
			return true
		}
	}
	return false
}

func inInt64String(needle int64, hay []string) bool {
	for _, v := range hay {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			continue
		}
		if n == needle {
			return true
		}
	}
	return false
}
