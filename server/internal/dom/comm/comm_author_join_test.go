// comm_author_join — the author of a message sent from kitp joins the
// thread's recipients, so a later reply by anyone else reaches them.
package comm_test

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// commRecipients reads comm.comm_recipients as person ids.
func commRecipients(t *testing.T, pool *pgxpool.Pool, commID int64) []int64 {
	t.Helper()
	var raw []byte
	if err := pool.QueryRow(context.Background(), `
		SELECT av.value FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'comm_recipients'
	`, commID).Scan(&raw); err != nil {
		t.Fatalf("read comm_recipients: %v", err)
	}
	var ids []int64
	if err := json.Unmarshal(raw, &ids); err != nil {
		t.Fatalf("decode comm_recipients: %v: %s", err, raw)
	}
	return ids
}

// replyTo reads a reply_body's To: snapshot.
func replyTo(t *testing.T, pool *pgxpool.Pool, replyID string) string {
	t.Helper()
	var to string
	if err := pool.QueryRow(context.Background(), `
		SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1::bigint AND ad.name = 'reply_to'
	`, replyID).Scan(&to); err != nil {
		t.Fatalf("read reply_to: %v", err)
	}
	return to
}

func TestCommAuthorJoin(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_author_join")
	ctx := context.Background()

	type user struct {
		ID     int64
		Person int64
	}
	// mkUser makes a login linked to a person card with this email; an
	// empty email makes the login only. owner > 0 makes an agent of owner.
	mkUser := func(name, email string, owner int64) user {
		t.Helper()
		var u user
		if err := pool.QueryRow(ctx, `
			INSERT INTO user_account (display_name, is_agent, parent_user_id)
			VALUES ($1, $2, NULLIF($3::bigint, 0)) RETURNING id
		`, name, owner > 0, owner).Scan(&u.ID); err != nil {
			t.Fatalf("user %s: %v", name, err)
		}
		if email == "" {
			return u
		}
		if err := pool.QueryRow(ctx, `
			INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id
		`).Scan(&u.Person); err != nil {
			t.Fatalf("person %s: %v", name, err)
		}
		insertAttr(t, pool, u.Person, "title", name)
		insertAttr(t, pool, u.Person, "email", email)
		if _, err := pool.Exec(ctx, `
			INSERT INTO user_account_person (user_account_id, person_card_id) VALUES ($1, $2)
		`, u.ID, u.Person); err != nil {
			t.Fatalf("link %s: %v", name, err)
		}
		return u
	}
	lucie := mkUser("lucie", "lucie@example.com", 0)
	russ := mkUser("russ", "russ@example.com", 0)
	dan := mkUser("dan", "dan@example.com", 0)
	agent := mkUser("claude", "", dan.ID)

	type post struct {
		Author int64
		WantTo string
	}
	list := []struct {
		Name  string
		Posts []post
		// WantJoined is who follows the fixture's one recipient, in order.
		WantJoined []int64
	}{
		{
			Name: "a reply by someone else reaches the earlier author",
			Posts: []post{
				{Author: lucie.ID, WantTo: "cust@example.com"},
				{Author: russ.ID, WantTo: "cust@example.com, lucie@example.com"},
			},
			WantJoined: []int64{lucie.Person, russ.Person},
		},
		{
			Name: "an author already on the thread is not added twice",
			Posts: []post{
				{Author: lucie.ID, WantTo: "cust@example.com"},
				{Author: lucie.ID, WantTo: "cust@example.com, lucie@example.com"},
			},
			WantJoined: []int64{lucie.Person},
		},
		{
			Name:       "an agent writes for its owner",
			Posts:      []post{{Author: agent.ID, WantTo: "cust@example.com"}},
			WantJoined: []int64{dan.Person},
		},
		{
			Name:  "an author with no email is left off",
			Posts: []post{{Author: auth.SystemUserID, WantTo: "cust@example.com"}},
		},
	}
	for _, tc := range list {
		t.Run(tc.Name, func(t *testing.T) {
			f := seedReplyFixture(t, pool, "", "cust@example.com")
			for i, p := range tc.Posts {
				rows := callReplyPostBatch(t, pool, p.Author, []map[string]any{
					{"comm_id": strconv.FormatInt(f.commID, 10), "body": "reply " + strconv.Itoa(i)},
				})
				if len(rows) != 1 || !rows[0].OK {
					t.Fatalf("post %d: %+v", i, rows)
				}
				var got struct {
					ReplyID string `json:"reply_id"`
				}
				if err := json.Unmarshal(rows[0].Result, &got); err != nil {
					t.Fatalf("post %d: %v", i, err)
				}
				if to := replyTo(t, pool, got.ReplyID); to != p.WantTo {
					t.Errorf("post %d: reply_to=%q want %q", i, to, p.WantTo)
				}
			}
			want := append([]int64{f.personID}, tc.WantJoined...)
			if got := commRecipients(t, pool, f.commID); !slices.Equal(got, want) {
				t.Errorf("comm_recipients=%v want %v", got, want)
			}
		})
	}

	t.Run("the sender of a new thread's first message joins it", func(t *testing.T) {
		f := seedCommCreateFixture(t, pool)
		rows := callCommCreateBatch(t, pool, lucie.ID, []map[string]any{
			{
				"task_id":              intToStr(f.taskID),
				"channel_id":           intToStr(f.channelID),
				"initial_message":      "Please review this in QA.",
				"recipient_person_ids": []string{intToStr(russ.Person)},
			},
		})
		if !rows[0].OK {
			t.Fatalf("comm.create: %+v", rows[0])
		}
		var got struct {
			CommID string `json:"comm_id"`
		}
		if err := json.Unmarshal(rows[0].Result, &got); err != nil {
			t.Fatal(err)
		}
		commID, err := strconv.ParseInt(got.CommID, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		if got, want := commRecipients(t, pool, commID), []int64{russ.Person, lucie.Person}; !slices.Equal(got, want) {
			t.Errorf("comm_recipients=%v want %v", got, want)
		}
	})
}
