// review9_refusals_test.go: round-8 L12 — a refusal doesn't say what
// another card is, or in which project.
package api_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
)

// TestRefusalsDontSayWhatOrWhereACardIs (round 8 L12).
func TestRefusalsDontSayWhatOrWhereACardIs(t *testing.T) {
	srv, sp := r9wSetup(t, "kitp_test_r9w_messages")
	projA, taskA := makeProjectAndTask(t, srv, "A")
	projB, taskB := makeProjectAndTask(t, srv, "B")
	worker := grantRole(t, sp, "worker-A", "worker", &projA)
	tagA := r9wCard(t, sp, "tag", projA, "our-tag")
	tagB := r9wCard(t, sp, "tag", projB, "secret-tag")
	for _, c := range []struct {
		name  string
		sub   api.SubRequest
		leaks []string
	}{
		{"tag.apply with B's tag", r8Sub("t", "tag", "apply", fmt.Sprintf(`{"target_card_id":"%d","tag_card_id":"%d"}`, taskA, tagB)),
			[]string{"project"}},
		{"comm.create with B's task as the channel", r8Sub("c", "comm", "create", fmt.Sprintf(`{"task_id":"%d","channel_id":"%d","subject":"x"}`, taskA, taskB)),
			[]string{"'task'", "not comm_channel"}},
		{"comm.create on a tag as the task", r8Sub("c", "comm", "create", fmt.Sprintf(`{"task_id":"%d","channel_id":"%d","subject":"x"}`, tagA, taskB)),
			[]string{"'tag'", "not task"}},
		{"task.move into B's tag", r8Sub("m", "task", "move", fmt.Sprintf(`{"card_id":"%d","new_project_id":"%d"}`, taskA, tagB)),
			[]string{"'tag'", "not project"}},
	} {
		r := r8As(srv, worker, c.sub)
		if r.Subresponses[0].OK {
			t.Errorf("%s: ok", c.name)
			continue
		}
		msg := r9wMsg(r)
		for _, l := range c.leaks {
			if strings.Contains(msg, l) {
				t.Errorf("%s: %q says %q", c.name, msg, l)
			}
		}
	}
}
