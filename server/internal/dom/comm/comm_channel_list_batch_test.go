// Direct PL/pgSQL test for comm_channel_list_batch — Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md.
package comm_test

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

func callCommChannelListBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []listForTaskResultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM comm_channel_list_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []listForTaskResultRow
	for rows.Next() {
		var r listForTaskResultRow
		var resJSON []byte
		if err := rows.Scan(&r.Idx, &r.OK, &r.Code, &r.Message, &resJSON); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if len(resJSON) > 0 {
			r.Result = json.RawMessage(append([]byte(nil), resJSON...))
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err: %v", err)
	}
	return out
}

type channelListOut struct {
	Rows []struct {
		ID              string `json:"id"`
		Name            string `json:"name"`
		ChannelType     string `json:"channel_type"`
		IMAPHost        string `json:"imap_host"`
		IMAPPort        int    `json:"imap_port"`
		IMAPUsername    string `json:"imap_username"`
		SMTPHost        string `json:"smtp_host"`
		SMTPPort        int    `json:"smtp_port"`
		HasIMAPPassword bool   `json:"has_imap_password"`
		HasSMTPPassword bool   `json:"has_smtp_password"`
		Status          string `json:"channel_status"`
	} `json:"rows"`
}

// TestCommChannelListBatch_Happy — one channel with attributes set.
func TestCommChannelListBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_channel_list_batch_happy")
	project := seedCardWithParent(t, pool, "project", nil)
	ch := seedCardWithParent(t, pool, "comm_channel", &project)
	writeAttrJSON(t, pool, ch, "title", "ops")
	writeAttrJSON(t, pool, ch, "channel_type", "email")
	writeAttrJSON(t, pool, ch, "imap_host", "imap.example.com")
	writeAttrJSON(t, pool, ch, "imap_port", 993)
	writeAttrJSON(t, pool, ch, "smtp_host", "smtp.example.com")
	writeAttrJSON(t, pool, ch, "smtp_port", 587)
	writeAttrJSON(t, pool, ch, "channel_status", "enabled")

	res := callCommChannelListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"project_id": strconv.FormatInt(project, 10)},
	})
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("want one ok row, got %+v", res)
	}
	var out channelListOut
	if err := json.Unmarshal(res[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v: %s", err, res[0].Result)
	}
	if len(out.Rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(out.Rows))
	}
	r := out.Rows[0]
	if r.Name != "ops" || r.ChannelType != "email" || r.IMAPHost != "imap.example.com" || r.IMAPPort != 993 {
		t.Errorf("channel: %+v", r)
	}
	if r.HasIMAPPassword || r.HasSMTPPassword {
		t.Errorf("no comm_secret yet, want both false; got %+v", r)
	}
}

// TestCommChannelListBatch_Empty — project with no channels returns
// rows=[].
func TestCommChannelListBatch_Empty(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_channel_list_batch_empty")
	project := seedCardWithParent(t, pool, "project", nil)
	res := callCommChannelListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"project_id": strconv.FormatInt(project, 10)},
	})
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("want one ok row, got %+v", res)
	}
	var out channelListOut
	_ = json.Unmarshal(res[0].Result, &out)
	if len(out.Rows) != 0 {
		t.Errorf("rows: got %d, want 0", len(out.Rows))
	}
}

// TestCommChannelListBatch_MultiInput — two projects with channels.
func TestCommChannelListBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_channel_list_batch_multi")
	pa := seedCardWithParent(t, pool, "project", nil)
	pb := seedCardWithParent(t, pool, "project", nil)
	cha := seedCardWithParent(t, pool, "comm_channel", &pa)
	writeAttrJSON(t, pool, cha, "title", "A1")
	chb1 := seedCardWithParent(t, pool, "comm_channel", &pb)
	writeAttrJSON(t, pool, chb1, "title", "B1")
	chb2 := seedCardWithParent(t, pool, "comm_channel", &pb)
	writeAttrJSON(t, pool, chb2, "title", "B2")

	res := callCommChannelListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"project_id": strconv.FormatInt(pa, 10)},
		{"project_id": strconv.FormatInt(pb, 10)},
	})
	if len(res) != 2 {
		t.Fatalf("res: got %d, want 2", len(res))
	}
	parse := func(rj json.RawMessage) int {
		var o channelListOut
		_ = json.Unmarshal(rj, &o)
		return len(o.Rows)
	}
	if got := parse(res[0].Result); got != 1 {
		t.Errorf("pa: got %d, want 1", got)
	}
	if got := parse(res[1].Result); got != 2 {
		t.Errorf("pb: got %d, want 2", got)
	}
}

// TestCommChannelListBatch_Validation — missing project_id fails.
func TestCommChannelListBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_channel_list_batch_validation")
	res := callCommChannelListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{},
	})
	if len(res) != 1 || res[0].OK || res[0].Code != "validation" {
		t.Errorf("want validation failure, got %+v", res)
	}
}
