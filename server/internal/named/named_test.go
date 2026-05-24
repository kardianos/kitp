package named_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/named"
)

// Each case is a self-contained Builder build + Compile. Asserts on
// the rewritten SQL and the args slice. Empty wantErr means success.
type compileCase struct {
	name    string
	build   func(*named.Builder) string
	wantSQL string
	wantArg []any
	wantErr string
}

func TestCompile(t *testing.T) {
	cases := []compileCase{
		{
			name: "named: first reference becomes $1",
			build: func(b *named.Builder) string {
				b.Set("user_id", int64(42))
				return "SELECT 1 FROM x WHERE id = :user_id"
			},
			wantSQL: "SELECT 1 FROM x WHERE id = $1",
			wantArg: []any{int64(42)},
		},
		{
			name: "named: repeated reference reuses same $N",
			build: func(b *named.Builder) string {
				b.Set("uid", int64(7))
				return "SELECT 1 WHERE a = :uid OR b = :uid OR c = :uid"
			},
			wantSQL: "SELECT 1 WHERE a = $1 OR b = $1 OR c = $1",
			wantArg: []any{int64(7)},
		},
		{
			name: "named: multiple distinct slots in first-seen order",
			build: func(b *named.Builder) string {
				b.Set("a", 1)
				b.Set("b", 2)
				b.Set("c", 3)
				return "WHERE x=:a AND y=:b AND z=:c AND w=:a"
			},
			wantSQL: "WHERE x=$1 AND y=$2 AND z=$3 AND w=$1",
			wantArg: []any{1, 2, 3},
		},
		{
			name: "anonymous: Bind returns distinct slots",
			build: func(b *named.Builder) string {
				a := b.Bind("foo")
				bb := b.Bind("bar")
				return "WHERE x=" + a + " AND y=" + bb
			},
			wantSQL: "WHERE x=$1 AND y=$2",
			wantArg: []any{"foo", "bar"},
		},
		{
			name: "mixed: named + anonymous interleave correctly",
			build: func(b *named.Builder) string {
				b.Set("user_id", int64(99))
				anon := b.Bind("query string")
				return "WHERE u=:user_id AND q=" + anon + " AND u2=:user_id"
			},
			wantSQL: "WHERE u=$1 AND q=$2 AND u2=$1",
			wantArg: []any{int64(99), "query string"},
		},
		{
			name: "cast operator :: not parsed as slot",
			build: func(b *named.Builder) string {
				b.Set("ids", []int64{1, 2, 3})
				return "WHERE id = ANY(:ids::bigint[])"
			},
			wantSQL: "WHERE id = ANY($1::bigint[])",
			wantArg: []any{[]int64{1, 2, 3}},
		},
		{
			name: "cast operator inside expression",
			build: func(b *named.Builder) string {
				b.Set("limit_n", 50)
				return "LIMIT :limit_n::int"
			},
			wantSQL: "LIMIT $1::int",
			wantArg: []any{50},
		},
		{
			name: "string literal: :name inside ' is NOT a slot",
			build: func(b *named.Builder) string {
				b.Set("title", "real")
				return "SELECT ':title' AS lit, :title AS bound"
			},
			wantSQL: "SELECT ':title' AS lit, $1 AS bound",
			wantArg: []any{"real"},
		},
		{
			name: "string literal: doubled '' is escaped quote, not end of string",
			build: func(b *named.Builder) string {
				b.Set("n", 1)
				return "SELECT 'O''Brien :ignored' AS x, :n AS y"
			},
			wantSQL: "SELECT 'O''Brien :ignored' AS x, $1 AS y",
			wantArg: []any{1},
		},
		{
			name: "double-quoted identifier: :name inside is NOT a slot",
			build: func(b *named.Builder) string {
				b.Set("n", 1)
				return `SELECT "col :weird" FROM t WHERE x = :n`
			},
			wantSQL: `SELECT "col :weird" FROM t WHERE x = $1`,
			wantArg: []any{1},
		},
		{
			name: "line comment: :name in -- … is NOT a slot",
			build: func(b *named.Builder) string {
				b.Set("real", 1)
				return "SELECT 1 -- :ignored placeholder\nWHERE x = :real"
			},
			wantSQL: "SELECT 1 -- :ignored placeholder\nWHERE x = $1",
			wantArg: []any{1},
		},
		{
			name: "block comment: :name in /* … */ is NOT a slot",
			build: func(b *named.Builder) string {
				b.Set("real", 1)
				return "SELECT 1 /* :ignored stuff */ WHERE x = :real"
			},
			wantSQL: "SELECT 1 /* :ignored stuff */ WHERE x = $1",
			wantArg: []any{1},
		},
		{
			name: "ILIKE percent literals pass through unchanged",
			build: func(b *named.Builder) string {
				b.Set("q", "foo")
				return "WHERE x ILIKE '%' || :q || '%'"
			},
			wantSQL: "WHERE x ILIKE '%' || $1 || '%'",
			wantArg: []any{"foo"},
		},
		{
			name: "unbound name returns error",
			build: func(b *named.Builder) string {
				b.Set("a", 1)
				return "WHERE x = :a AND y = :missing"
			},
			wantErr: ":missing referenced but not bound",
		},
		{
			name: "empty SQL returns empty",
			build: func(b *named.Builder) string {
				return ""
			},
			wantSQL: "",
			wantArg: []any{},
		},
		{
			name: "colon-then-non-ident is passed through (e.g. JSON in literal)",
			build: func(b *named.Builder) string {
				b.Set("v", "ok")
				return "SELECT '{\"a\":1}' AS j, :v"
			},
			wantSQL: "SELECT '{\"a\":1}' AS j, $1",
			wantArg: []any{"ok"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := named.New()
			sql := tc.build(b)
			got, args, err := b.Compile(sql)
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("want error containing %q, got nil; sql=%q", tc.wantErr, got)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("want error containing %q, got %v", tc.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.wantSQL {
				t.Errorf("sql:\n got: %q\nwant: %q", got, tc.wantSQL)
			}
			// Normalise [] vs nil so a zero-args case compares equal.
			if len(args) == 0 && len(tc.wantArg) == 0 {
				return
			}
			if !reflect.DeepEqual(args, tc.wantArg) {
				t.Errorf("args:\n got: %#v\nwant: %#v", args, tc.wantArg)
			}
		})
	}
}

// TestSet_PanicsOnInvalidName guards the public surface: a typo in
// the name (whitespace, leading digit, dot) is a programmer error,
// not a runtime error.
func TestSet_PanicsOnInvalidName(t *testing.T) {
	for _, bad := range []string{"", "1user", "a b", "a.b", "user-id", "user@org"} {
		t.Run(bad, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Fatalf("expected panic for name %q", bad)
				}
			}()
			b := named.New()
			b.Set(bad, 1)
		})
	}
}

// TestBind_AddArgCompatible verifies that Bind can stand in for the
// legacy `addArg func(any) string` closure used by tree-compilers.
func TestBind_AddArgCompatible(t *testing.T) {
	b := named.New()
	var addArg func(any) string = b.Bind

	frag := "(" + addArg("a") + ", " + addArg(int64(7)) + ", " + addArg("a") + ")"
	sql, args, err := b.Compile(frag)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	// Three Bind calls → three distinct slots even though two have
	// the same value. That matches addArg's behaviour: each call
	// allocates its own positional slot.
	if sql != "($1, $2, $3)" {
		t.Errorf("sql: got %q want %q", sql, "($1, $2, $3)")
	}
	want := []any{"a", int64(7), "a"}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("args: got %#v want %#v", args, want)
	}
}
