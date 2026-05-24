// Package named provides a tiny SQL-named-parameter translator that
// sits between handler code and pgx's positional-parameter wire
// format.
//
// Motivation: pgx uses `$N` positional placeholders. Anything past
// ~3 slots makes the SQL hard to read and trivial to miscount —
// especially when a handler composes SQL from a static skeleton AND
// dynamically-compiled fragments (filter trees, optional WHERE
// clauses). Reordering args silently corrupts results; new slots
// require renumbering downstream.
//
// This package lets handlers write SQL with `:name` placeholders
// and bind values by name. At the end, [Builder.Compile] scans the
// SQL once and rewrites every `:name` into the matching `$N` (in
// first-appearance order, reusing a single slot per distinct name)
// and returns the args slice ready to feed to pgx.
//
// Two binding methods:
//
//   - [Builder.Set] for named slots the caller writes by hand
//     (e.g. `:user_id`, `:card_type_name`). Repeated `:name`
//     references resolve to the same `$N`, so a slot used in
//     three places is bound and shipped once.
//
//   - [Builder.Bind] for anonymous slots in tree-compiled
//     fragments — equivalent to the legacy `addArg` closure but
//     returning `:_bN` instead of `$N`. Callers that already
//     accept an `addArg func(any) string` keep working unchanged;
//     pass [Builder.Bind] as the callback.
//
// Scope: the scanner understands single-quoted string literals,
// double-quoted identifiers, line comments (`--…`), block comments
// (`/* … */`), and the Postgres cast operator (`::`). It does NOT
// understand dollar-quoted strings (`$tag$ … $tag$`) — those don't
// appear in any handler SQL today; revisit if/when a stored-procedure
// definition gets hand-rolled in Go.
package named

import (
	"fmt"
	"strings"
)

// Builder accumulates named and anonymous slot bindings for a query
// composed via interpolated `:name` placeholders.
type Builder struct {
	counter int
	vals    map[string]any
}

// New returns an empty Builder.
func New() *Builder {
	return &Builder{vals: map[string]any{}}
}

// Set binds [name] to [value] and returns the slot string (`:name`)
// for direct interpolation into the SQL. A later [Builder.Set] with
// the same name overwrites; a SQL referencing `:name` multiple times
// resolves to one shared `$N` at compile time.
//
// Panics on an invalid identifier — names must match
// `[A-Za-z_][A-Za-z0-9_]*`.
func (b *Builder) Set(name string, value any) string {
	if !isIdent(name) {
		panic(fmt.Sprintf("named.Builder.Set: invalid name %q", name))
	}
	b.vals[name] = value
	return ":" + name
}

// Bind binds [value] under an auto-generated name and returns the
// matching slot string. The structural equivalent of the legacy
// `addArg` closure — pass [Builder.Bind] anywhere an
// `addArg func(any) string` is expected.
func (b *Builder) Bind(value any) string {
	b.counter++
	name := fmt.Sprintf("_b%d", b.counter)
	b.vals[name] = value
	return ":" + name
}

// Compile rewrites [sql] into positional-parameter form. Each
// distinct `:name` occurrence maps to a single `$N` (first-
// appearance order); repeated names reuse their slot. Returns the
// rewritten SQL and the args slice ready to feed to pgx.
//
// Errors when [sql] references a name that wasn't bound; that's
// almost always a typo and worth surfacing at call time rather than
// shipping a malformed query to Postgres.
func (b *Builder) Compile(sql string) (string, []any, error) {
	var out strings.Builder
	var order []string         // first-appearance order of names
	seen := map[string]int{}   // name → 1-based $N

	i := 0
	n := len(sql)
	for i < n {
		c := sql[i]

		// Single-quoted string literal. Postgres standard_conforming_
		// strings is the default since 9.1; the only intra-string
		// escape we honour is the doubled quote (`''`).
		if c == '\'' {
			out.WriteByte(c)
			i++
			for i < n {
				if sql[i] == '\'' {
					out.WriteByte(sql[i])
					i++
					if i < n && sql[i] == '\'' {
						out.WriteByte(sql[i])
						i++
						continue
					}
					break
				}
				out.WriteByte(sql[i])
				i++
			}
			continue
		}

		// Double-quoted identifier — copy verbatim, no embedded
		// escape handling (identifiers can't contain `"`).
		if c == '"' {
			out.WriteByte(c)
			i++
			for i < n && sql[i] != '"' {
				out.WriteByte(sql[i])
				i++
			}
			if i < n {
				out.WriteByte(sql[i])
				i++
			}
			continue
		}

		// Line comment.
		if c == '-' && i+1 < n && sql[i+1] == '-' {
			for i < n && sql[i] != '\n' {
				out.WriteByte(sql[i])
				i++
			}
			continue
		}

		// Block comment (non-nested — Postgres allows nesting, but
		// it doesn't appear in any handler SQL today and the simple
		// scanner is much easier to reason about).
		if c == '/' && i+1 < n && sql[i+1] == '*' {
			out.WriteByte(sql[i])
			i++
			out.WriteByte(sql[i])
			i++
			for i < n {
				if sql[i] == '*' && i+1 < n && sql[i+1] == '/' {
					out.WriteByte(sql[i])
					i++
					out.WriteByte(sql[i])
					i++
					break
				}
				out.WriteByte(sql[i])
				i++
			}
			continue
		}

		// Postgres cast `::type` — NOT a named slot. Pass both
		// colons through unchanged.
		if c == ':' && i+1 < n && sql[i+1] == ':' {
			out.WriteByte(sql[i])
			i++
			out.WriteByte(sql[i])
			i++
			continue
		}

		// Named slot.
		if c == ':' && i+1 < n && isIdentStart(sql[i+1]) {
			j := i + 1
			for j < n && isIdentCont(sql[j]) {
				j++
			}
			name := sql[i+1 : j]
			idx, ok := seen[name]
			if !ok {
				if _, bound := b.vals[name]; !bound {
					return "", nil, fmt.Errorf("named.Builder.Compile: :%s referenced but not bound", name)
				}
				order = append(order, name)
				idx = len(order)
				seen[name] = idx
			}
			fmt.Fprintf(&out, "$%d", idx)
			i = j
			continue
		}

		out.WriteByte(c)
		i++
	}

	args := make([]any, len(order))
	for k, name := range order {
		args[k] = b.vals[name]
	}
	return out.String(), args, nil
}

// isIdent reports whether [s] is a valid bind-name.
func isIdent(s string) bool {
	if s == "" {
		return false
	}
	if !isIdentStart(s[0]) {
		return false
	}
	for i := 1; i < len(s); i++ {
		if !isIdentCont(s[i]) {
			return false
		}
	}
	return true
}

func isIdentStart(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isIdentCont(c byte) bool {
	return isIdentStart(c) || (c >= '0' && c <= '9')
}
