// Internal-package tests for parseRecipients — exercises both the
// RFC 5322 ParseAddressList path and the comma-split fallback the
// helper uses when the parser refuses a loosely-formatted value.

package comm

import (
	"reflect"
	"testing"
)

func TestParseRecipients(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{name: "empty", in: "", want: nil},
		{name: "whitespace only", in: "   ", want: nil},
		{name: "single bare email", in: "alice@example.com", want: []string{"alice@example.com"}},
		{
			name: "two bare emails comma-joined",
			in:   "alice@example.com, bob@example.com",
			want: []string{"alice@example.com", "bob@example.com"},
		},
		{
			name: "two emails with display names",
			in:   "Alice <alice@example.com>, \"Bob B.\" <bob@example.com>",
			want: []string{"alice@example.com", "bob@example.com"},
		},
		{
			name: "three with mixed whitespace",
			in:   "  a@x.com,b@x.com ,  c@x.com",
			want: []string{"a@x.com", "b@x.com", "c@x.com"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseRecipients(tc.in)
			if err != nil {
				t.Fatalf("error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("parseRecipients(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
