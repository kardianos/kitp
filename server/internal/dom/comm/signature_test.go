package comm

import "testing"

func TestResolveSignature(t *testing.T) {
	cases := []struct {
		name    string
		mode    string
		channel string
		author  string
		want    string
	}{
		{"none signs nothing", "none", "Support", "Alice", ""},
		{"comm_name signs channel", "comm_name", "Support", "Alice", "Support"},
		{"user_name signs author", "user_name", "Support", "Alice", "Alice"},
		{"unset falls back to channel", "", "Support", "Alice", "Support"},
		{"unknown falls back to channel", "bogus", "Support", "Alice", "Support"},
		{"user_name with no author signs nothing", "user_name", "Support", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveSignature(c.mode, c.channel, c.author); got != c.want {
				t.Errorf("resolveSignature(%q,%q,%q)=%q want %q",
					c.mode, c.channel, c.author, got, c.want)
			}
		})
	}
}
