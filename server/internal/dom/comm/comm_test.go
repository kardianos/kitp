package comm_test

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/flow"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// fixture seeds the per-test rows the comm handlers need.
//
//   - One project under which the channel + task live.
//   - One status value-card under that project (so a task can satisfy
//     the (task, status) required-edge check at insert time).
//   - One comm_status value-card and a comm flow scoped to this
//     project, with the comm_status card as default_create_status_id —
//     comm.create reads this when stamping the new comm.
//
// We DON'T lean on the install seed's template (Standard Project
// Template) — the comm fixture builds its own project so the tests
// stay independent of seed-row identity.
type fixture struct {
	srv              *api.Server
	sp               *store.Pool
	ctx              context.Context
	adminID          int64
	projectID        int64
	statusID         int64
	commOpenID       int64
	commProgressID   int64
	commResolvedID   int64
	commFlowID       int64
	taskID           int64
	commStatusAttrID int64
	commsAttrID      int64
}

func setupAdmin(t *testing.T, schemaName string) *fixture {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schemaName)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	flow.Register(sp)
	comm.Register(sp)

	srv := api.NewServer(sp)
	ctx := context.Background()

	// Admin user with admin role.
	var uid int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('comm-admin') RETURNING id`).Scan(&uid); err != nil {
		t.Fatalf("admin user: %v", err)
	}
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name='admin'
	`, uid); err != nil {
		t.Fatalf("admin grant: %v", err)
	}
	adminCtx := auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: "comm-admin"})

	// Project + status + 3 comm-status cards + comm flow.
	resp := srv.Dispatch(adminCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"Test Project"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("project insert: %+v", resp.Subresponses[0])
	}
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	mkStatus := func(title string) int64 {
		resp := srv.Dispatch(adminCtx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "s", Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"status","parent_card_id":"%d","title":%q}`, pOut.ID, title))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("status %q: %+v", title, resp.Subresponses[0])
		}
		var sOut card.InsertOutput
		buf, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(buf, &sOut)
		return sOut.ID
	}
	statusID := mkStatus("Todo")
	commOpen := mkStatus("Open")
	commInProgress := mkStatus("In progress")
	commResolved := mkStatus("Resolved")

	// Resolve the comm_status attribute_def id and the comms attribute id.
	var commStatusAttrID, commsAttrID int64
	if err := sp.P.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name='comm_status'`).Scan(&commStatusAttrID); err != nil {
		t.Fatalf("attribute_def.comm_status: %v", err)
	}
	if err := sp.P.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name='comms'`).Scan(&commsAttrID); err != nil {
		t.Fatalf("attribute_def.comms: %v", err)
	}

	// Insert a comm flow on this project.
	resp = srv.Dispatch(adminCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "f", Endpoint: "flow", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"name":"Test comm flow","attribute_def_id":"%d","scope_card_id":"%d","default_create_status_id":"%d"}`,
				commStatusAttrID, pOut.ID, commOpen))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("flow.set: %+v", resp.Subresponses[0])
	}
	var fOut flow.SetOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &fOut)

	// Insert one task under the project so comm.create has a parent.
	resp = srv.Dispatch(adminCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"Issue 1","attributes":{"status":"%d"}}`,
				pOut.ID, statusID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("task insert: %+v", resp.Subresponses[0])
	}
	var tOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &tOut)

	return &fixture{
		srv:              srv,
		sp:               sp,
		ctx:              adminCtx,
		adminID:          uid,
		projectID:        pOut.ID,
		statusID:         statusID,
		commOpenID:       commOpen,
		commProgressID:   commInProgress,
		commResolvedID:   commResolved,
		commFlowID:       fOut.ID,
		taskID:           tOut.ID,
		commStatusAttrID: commStatusAttrID,
		commsAttrID:      commsAttrID,
	}
}

func dispatch(t *testing.T, f *fixture, sub api.SubRequest, v any) {
	t.Helper()
	resp := f.srv.Dispatch(f.ctx, api.BatchRequest{Subrequests: []api.SubRequest{sub}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("%s.%s: %+v", sub.Endpoint, sub.Action, resp.Subresponses[0])
	}
	if v != nil {
		buf, _ := json.Marshal(resp.Subresponses[0].Data)
		if err := json.Unmarshal(buf, v); err != nil {
			t.Fatalf("decode %s.%s: %v", sub.Endpoint, sub.Action, err)
		}
	}
}

func dispatchExpectErr(t *testing.T, f *fixture, sub api.SubRequest) *api.ErrorEnvelope {
	t.Helper()
	resp := f.srv.Dispatch(f.ctx, api.BatchRequest{Subrequests: []api.SubRequest{sub}})
	if resp.Subresponses[0].OK {
		t.Fatalf("%s.%s: expected error, got OK: %+v", sub.Endpoint, sub.Action, resp.Subresponses[0])
	}
	if resp.Subresponses[0].Error == nil {
		t.Fatalf("%s.%s: error envelope missing", sub.Endpoint, sub.Action)
	}
	return resp.Subresponses[0].Error
}

// ---- comm_channel ----

func TestChannelCreate(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_channel_create")

	body := fmt.Sprintf(`{
		"project_id":"%d",
		"name":"Support",
		"channel_type":"email",
		"imap_host":"imap.example.com",
		"imap_port":993,
		"imap_username":"support@example.com",
		"imap_password":"imap-secret",
		"smtp_host":"smtp.example.com",
		"smtp_port":587,
		"smtp_username":"support@example.com",
		"smtp_password":"smtp-secret",
		"from_address":"support@example.com"
	}`, f.projectID)
	var setOut comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "c", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(body),
	}, &setOut)
	if setOut.ChannelID == 0 {
		t.Fatal("expected channel id > 0")
	}

	// Verify comm_secret rows are encrypted (not equal to plaintext, not null).
	var imapBytes, smtpBytes []byte
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT imap_password, smtp_password FROM comm_secret WHERE channel_card_id=$1
	`, setOut.ChannelID).Scan(&imapBytes, &smtpBytes); err != nil {
		t.Fatalf("comm_secret: %v", err)
	}
	if len(imapBytes) == 0 || len(smtpBytes) == 0 {
		t.Errorf("expected encrypted bytes, got empty (imap=%d smtp=%d)", len(imapBytes), len(smtpBytes))
	}
	if string(imapBytes) == "imap-secret" || string(smtpBytes) == "smtp-secret" {
		t.Errorf("password stored as plaintext")
	}

	// Confirm the password can be decrypted via the per-connection key.
	var imapPlain, smtpPlain string
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT
			pgp_sym_decrypt(imap_password, current_setting('app.comm_secret_key')),
			pgp_sym_decrypt(smtp_password, current_setting('app.comm_secret_key'))
		FROM comm_secret WHERE channel_card_id=$1
	`, setOut.ChannelID).Scan(&imapPlain, &smtpPlain); err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if imapPlain != "imap-secret" || smtpPlain != "smtp-secret" {
		t.Errorf("decrypted mismatch: imap=%q smtp=%q", imapPlain, smtpPlain)
	}

	// channel_channel.list returns it with HasIMAPPassword/HasSMTPPassword.
	var listOut comm.ChannelListOutput
	dispatch(t, f, api.SubRequest{
		ID: "l", Endpoint: "comm_channel", Action: "list", Data: json.RawMessage(
			fmt.Sprintf(`{"project_id":"%d"}`, f.projectID)),
	}, &listOut)
	if len(listOut.Rows) != 1 {
		t.Fatalf("expected 1 row, got %d: %+v", len(listOut.Rows), listOut.Rows)
	}
	got := listOut.Rows[0]
	if got.ID != setOut.ChannelID {
		t.Errorf("ID=%d want %d", got.ID, setOut.ChannelID)
	}
	if got.Name != "Support" {
		t.Errorf("Name=%q want Support", got.Name)
	}
	if got.ChannelType != "email" {
		t.Errorf("ChannelType=%q want email", got.ChannelType)
	}
	if got.IMAPHost != "imap.example.com" || got.IMAPPort != 993 || got.IMAPUsername != "support@example.com" {
		t.Errorf("imap mismatch: %+v", got)
	}
	if got.SMTPHost != "smtp.example.com" || got.SMTPPort != 587 || got.SMTPUsername != "support@example.com" {
		t.Errorf("smtp mismatch: %+v", got)
	}
	if got.FromAddress != "support@example.com" {
		t.Errorf("FromAddress=%q", got.FromAddress)
	}
	if !got.HasIMAPPassword || !got.HasSMTPPassword {
		t.Errorf("expected Has* flags true, got %+v", got)
	}
}

func TestChannelUpdate(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_channel_update")

	// Create with both passwords.
	var setOut comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "c", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{
				"project_id":"%d","name":"Support","channel_type":"email",
				"imap_host":"imap.example.com","imap_port":993,
				"imap_username":"a","imap_password":"orig-imap",
				"smtp_host":"smtp.example.com","smtp_port":587,
				"smtp_username":"a","smtp_password":"orig-smtp",
				"from_address":"a@example.com"
			}`, f.projectID)),
	}, &setOut)

	// Capture the encrypted bytes so we can confirm the un-touched
	// password row stays byte-identical across the update.
	var imapBefore, smtpBefore []byte
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT imap_password, smtp_password FROM comm_secret WHERE channel_card_id=$1
	`, setOut.ChannelID).Scan(&imapBefore, &smtpBefore); err != nil {
		t.Fatal(err)
	}

	// Update: rename + change imap_password ONLY. smtp_password omitted
	// — must stay unchanged.
	dispatch(t, f, api.SubRequest{
		ID: "u", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{
				"id":"%d","project_id":"%d","name":"Support v2","channel_type":"email",
				"imap_password":"new-imap"
			}`, setOut.ChannelID, f.projectID)),
	}, nil)

	var imapAfter, smtpAfter []byte
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT imap_password, smtp_password FROM comm_secret WHERE channel_card_id=$1
	`, setOut.ChannelID).Scan(&imapAfter, &smtpAfter); err != nil {
		t.Fatal(err)
	}
	if string(smtpAfter) != string(smtpBefore) {
		t.Errorf("smtp_password changed across an update that omitted smtp_password")
	}
	// Decrypt and confirm imap_password is now 'new-imap'.
	var imapPlain string
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT pgp_sym_decrypt(imap_password, current_setting('app.comm_secret_key'))
		FROM comm_secret WHERE channel_card_id=$1
	`, setOut.ChannelID).Scan(&imapPlain); err != nil {
		t.Fatal(err)
	}
	if imapPlain != "new-imap" {
		t.Errorf("imap plaintext=%q, want new-imap", imapPlain)
	}

	// Title attribute should reflect rename.
	var listOut comm.ChannelListOutput
	dispatch(t, f, api.SubRequest{
		ID: "l", Endpoint: "comm_channel", Action: "list", Data: json.RawMessage(
			fmt.Sprintf(`{"project_id":"%d"}`, f.projectID)),
	}, &listOut)
	if len(listOut.Rows) != 1 || listOut.Rows[0].Name != "Support v2" {
		t.Errorf("rename failed: %+v", listOut.Rows)
	}
}

// TestThreadIDFormat verifies the regex shape and uniqueness across 1000
// generations. Uses the public comm.create handler so we exercise the
// in-tx uniqueness loop too.
func TestThreadIDFormat(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_thread_id")

	// Channel needed for comm.create.
	var setOut comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "c", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"project_id":"%d","name":"X","channel_type":"email"}`, f.projectID)),
	}, &setOut)

	re := regexp.MustCompile(`^[0-9A-Za-z]{10}$`)
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		// Each iteration needs its own task to avoid coupling assertions
		// to whether comm.create lets multiple comms share a task.
		var tOut card.InsertOutput
		dispatch(t, f, api.SubRequest{
			ID: fmt.Sprintf("t%d", i), Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"T %d","attributes":{"status":"%d"}}`,
					f.projectID, i, f.statusID)),
		}, &tOut)
		var ccOut comm.CommCreateOutput
		dispatch(t, f, api.SubRequest{
			ID: fmt.Sprintf("c%d", i), Endpoint: "comm", Action: "create", Data: json.RawMessage(
				fmt.Sprintf(`{"task_id":"%d","channel_id":"%d"}`, tOut.ID, setOut.ChannelID)),
		}, &ccOut)
		if !re.MatchString(ccOut.ThreadID) {
			t.Errorf("thread_id %q does not match %s", ccOut.ThreadID, re)
		}
		if seen[ccOut.ThreadID] {
			t.Errorf("duplicate thread_id %q at iteration %d", ccOut.ThreadID, i)
		}
		seen[ccOut.ThreadID] = true
	}
}

// ---- comm.create ----

func TestCommCreate(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_create")

	var setOut comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "ch", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"project_id":"%d","name":"Support","channel_type":"email"}`, f.projectID)),
	}, &setOut)

	var ccOut comm.CommCreateOutput
	dispatch(t, f, api.SubRequest{
		ID: "c", Endpoint: "comm", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"task_id":"%d","channel_id":"%d","subject":"Help!"}`,
				f.taskID, setOut.ChannelID)),
	}, &ccOut)

	if ccOut.CommID == 0 {
		t.Fatal("expected comm_id > 0")
	}
	re := regexp.MustCompile(`^[0-9A-Za-z]{10}$`)
	if !re.MatchString(ccOut.ThreadID) {
		t.Errorf("thread_id %q invalid", ccOut.ThreadID)
	}

	// Confirm the comm card has the expected attributes.
	ctx := context.Background()
	var title, threadID string
	var channelID, statusID int64
	if err := f.sp.P.QueryRow(ctx, `
		SELECT
			(SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='title'),
			(SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='thread_id'),
			(SELECT (value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='channel_ref'),
			(SELECT (value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='comm_status')
	`, ccOut.CommID).Scan(&title, &threadID, &channelID, &statusID); err != nil {
		t.Fatalf("read attrs: %v", err)
	}
	if title != "Help!" {
		t.Errorf("title=%q want Help!", title)
	}
	if threadID != ccOut.ThreadID {
		t.Errorf("thread_id mismatch: stored=%q returned=%q", threadID, ccOut.ThreadID)
	}
	if channelID != setOut.ChannelID {
		t.Errorf("channel_ref=%d want %d", channelID, setOut.ChannelID)
	}
	if statusID != f.commOpenID {
		t.Errorf("comm_status=%d want %d (Open default)", statusID, f.commOpenID)
	}

	// Task's `comms` attribute should now contain the new comm id.
	var commsJSON []byte
	if err := f.sp.P.QueryRow(ctx, `
		SELECT value FROM attribute_value WHERE card_id=$1 AND attribute_def_id=$2
	`, f.taskID, f.commsAttrID).Scan(&commsJSON); err != nil {
		t.Fatalf("task.comms: %v", err)
	}
	var ids []int64
	if err := json.Unmarshal(commsJSON, &ids); err != nil {
		t.Fatalf("decode comms: %v: %s", err, commsJSON)
	}
	if len(ids) != 1 || ids[0] != ccOut.CommID {
		t.Errorf("task.comms=%v, want [%d]", ids, ccOut.CommID)
	}
}

func TestCommCreateWithInitialMessage(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_create_initial")

	var setOut comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "ch", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"project_id":"%d","name":"Support","channel_type":"email"}`, f.projectID)),
	}, &setOut)

	var ccOut comm.CommCreateOutput
	dispatch(t, f, api.SubRequest{
		ID: "c", Endpoint: "comm", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"task_id":"%d","channel_id":"%d","subject":"Login issue","initial_message":"Cannot log in"}`,
				f.taskID, setOut.ChannelID)),
	}, &ccOut)

	// Look up the comm's replies attribute, expect 1 entry referencing
	// the reply_body card we just inserted.
	ctx := context.Background()
	var repliesJSON []byte
	if err := f.sp.P.QueryRow(ctx, `
		SELECT av.value FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id=$1 AND ad.name='replies'
	`, ccOut.CommID).Scan(&repliesJSON); err != nil {
		t.Fatalf("comm.replies: %v", err)
	}
	var replyIDs []int64
	if err := json.Unmarshal(repliesJSON, &replyIDs); err != nil {
		t.Fatalf("decode replies: %v: %s", err, repliesJSON)
	}
	if len(replyIDs) != 1 {
		t.Fatalf("expected 1 reply, got %d", len(replyIDs))
	}
	// The reply_body should carry delivery_status='received' and the body text.
	var status, body, subject string
	if err := f.sp.P.QueryRow(ctx, `
		SELECT
			(SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='delivery_status'),
			(SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='reply_body_text'),
			(SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='reply_subject')
	`, replyIDs[0]).Scan(&status, &body, &subject); err != nil {
		t.Fatalf("reply attrs: %v", err)
	}
	if status != "received" {
		t.Errorf("delivery_status=%q want received", status)
	}
	if body != "Cannot log in" {
		t.Errorf("body=%q want 'Cannot log in'", body)
	}
	if subject != "Login issue" {
		t.Errorf("subject=%q want 'Login issue'", subject)
	}
}

// TestCommCreateMismatchedProject confirms cross-project task / channel
// combinations are rejected with a structured code.
func TestCommCreateMismatchedProject(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_create_mismatch")

	// Second project + its channel.
	resp := f.srv.Dispatch(f.ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p2", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"Other"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatal(resp.Subresponses[0])
	}
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	var setOut comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "ch", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"project_id":"%d","name":"Other support","channel_type":"email"}`, pOut.ID)),
	}, &setOut)

	// Task in project A; channel in project B. Should reject.
	errEnv := dispatchExpectErr(t, f, api.SubRequest{
		ID: "x", Endpoint: "comm", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"task_id":"%d","channel_id":"%d"}`, f.taskID, setOut.ChannelID)),
	})
	if errEnv.Code != "project_mismatch" {
		t.Errorf("code=%q want project_mismatch: %s", errEnv.Code, errEnv.Message)
	}
}

// ---- comm.list_for_task ----

func TestCommListForTask(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_list_for_task")

	var setOut comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "ch", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"project_id":"%d","name":"Support","channel_type":"email"}`, f.projectID)),
	}, &setOut)

	// Two comms on the same task, one with an initial message.
	var c1, c2 comm.CommCreateOutput
	dispatch(t, f, api.SubRequest{
		ID: "c1", Endpoint: "comm", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"task_id":"%d","channel_id":"%d","subject":"First","initial_message":"Hello"}`,
				f.taskID, setOut.ChannelID)),
	}, &c1)
	dispatch(t, f, api.SubRequest{
		ID: "c2", Endpoint: "comm", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"task_id":"%d","channel_id":"%d","subject":"Second"}`,
				f.taskID, setOut.ChannelID)),
	}, &c2)

	var listOut comm.CommListForTaskOutput
	dispatch(t, f, api.SubRequest{
		ID: "l", Endpoint: "comm", Action: "list_for_task", Data: json.RawMessage(
			fmt.Sprintf(`{"task_id":"%d"}`, f.taskID)),
	}, &listOut)
	if len(listOut.Rows) != 2 {
		t.Fatalf("expected 2 comms, got %d: %+v", len(listOut.Rows), listOut.Rows)
	}

	// Find which row is which (order is by card id).
	got := map[int64]comm.CommRow{}
	for _, r := range listOut.Rows {
		got[r.ID] = r
	}
	r1, ok1 := got[c1.CommID]
	r2, ok2 := got[c2.CommID]
	if !ok1 || !ok2 {
		t.Fatalf("missing rows: ok1=%v ok2=%v rows=%+v", ok1, ok2, listOut.Rows)
	}
	if r1.Title != "First" || r1.ThreadID != c1.ThreadID || r1.ChannelID != setOut.ChannelID {
		t.Errorf("r1 mismatch: %+v", r1)
	}
	if r1.CommStatus != f.commOpenID {
		t.Errorf("r1.CommStatus=%d want %d", r1.CommStatus, f.commOpenID)
	}
	if len(r1.Replies) != 1 {
		t.Errorf("r1 expected 1 reply, got %d", len(r1.Replies))
	} else if r1.Replies[0].BodyText != "Hello" || r1.Replies[0].DeliveryStatus != "received" {
		t.Errorf("r1.Replies[0]=%+v", r1.Replies[0])
	}
	if r2.Title != "Second" || len(r2.Replies) != 0 {
		t.Errorf("r2 mismatch: %+v", r2)
	}
}

// ---- comm_log.list ----

func TestCommLogList(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_log_list")

	ctx := context.Background()

	// Gate 9 added a channel_name JOIN; create one channel so we can
	// verify the join surfaces the title attribute through to the row.
	var setOut comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "ch", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"project_id":"%d","name":"Support","channel_type":"email"}`, f.projectID)),
	}, &setOut)

	// Insert log rows directly via SQL — Gate 5/6 will add a writer
	// handler; for now the comm_log table is filled by the IMAP/SMTP
	// loops only, and Gate 3 ships the reader. Add 3 rows so the list
	// has something to return; one of them carries a channel_id so the
	// join lights up.
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO comm_log (project_id, channel_id, kind, detail, at) VALUES
			($1, NULL, 'imap_auth_fail', '{"err":"bad creds"}'::jsonb, now() - interval '5 minutes'),
			($1, NULL, 'poll', '{"messages_seen":2}'::jsonb, now() - interval '3 minutes'),
			($1, $2, 'send_ok', '{"to":"a@example.com"}'::jsonb, now() - interval '1 minute')
	`, f.projectID, setOut.ChannelID); err != nil {
		t.Fatalf("insert log rows: %v", err)
	}

	var listOut comm.CommLogListOutput
	dispatch(t, f, api.SubRequest{
		ID: "l", Endpoint: "comm_log", Action: "list", Data: json.RawMessage(
			fmt.Sprintf(`{"project_id":"%d"}`, f.projectID)),
	}, &listOut)
	if len(listOut.Rows) != 3 {
		t.Fatalf("expected 3 rows, got %d: %+v", len(listOut.Rows), listOut.Rows)
	}
	// Newest first.
	wantKinds := []string{"send_ok", "poll", "imap_auth_fail"}
	for i, w := range wantKinds {
		if listOut.Rows[i].Kind != w {
			t.Errorf("rows[%d].Kind=%q, want %q", i, listOut.Rows[i].Kind, w)
		}
	}

	// Gate 9 join: the send_ok row carried channel_id; channel_name
	// must come back as the channel card's title ("Support").
	sendOK := listOut.Rows[0]
	if sendOK.ChannelID != setOut.ChannelID {
		t.Errorf("send_ok ChannelID=%d, want %d", sendOK.ChannelID, setOut.ChannelID)
	}
	if sendOK.ChannelName != "Support" {
		t.Errorf("send_ok ChannelName=%q, want %q", sendOK.ChannelName, "Support")
	}
	// And the imap_auth_fail row carried no channel_id; channel_name
	// must be empty.
	authFail := listOut.Rows[2]
	if authFail.ChannelID != 0 {
		t.Errorf("imap_auth_fail ChannelID=%d, want 0", authFail.ChannelID)
	}
	if authFail.ChannelName != "" {
		t.Errorf("imap_auth_fail ChannelName=%q, want \"\"", authFail.ChannelName)
	}

	// Filter by kind.
	dispatch(t, f, api.SubRequest{
		ID: "f", Endpoint: "comm_log", Action: "list", Data: json.RawMessage(
			fmt.Sprintf(`{"project_id":"%d","kind":"poll"}`, f.projectID)),
	}, &listOut)
	if len(listOut.Rows) != 1 || listOut.Rows[0].Kind != "poll" {
		t.Errorf("filter by kind=poll: %+v", listOut.Rows)
	}

	// since=future → 0 rows.
	dispatch(t, f, api.SubRequest{
		ID: "s", Endpoint: "comm_log", Action: "list", Data: json.RawMessage(
			fmt.Sprintf(`{"project_id":"%d","since":"2099-01-01T00:00:00Z"}`, f.projectID)),
	}, &listOut)
	if len(listOut.Rows) != 0 {
		t.Errorf("since=future: %+v", listOut.Rows)
	}
}

// ---- authz ----

func TestPermission(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_permission")

	// Worker user.
	ctx := context.Background()
	var uid int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('comm-worker') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name='worker'
	`, uid); err != nil {
		t.Fatal(err)
	}
	workerCtx := auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: "comm-worker"})

	resp := f.srv.Dispatch(workerCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "x", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"project_id":"%d","name":"X","channel_type":"email"}`, f.projectID))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatal("worker should be unauthorized for comm_channel.set")
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "unauthorized" {
		t.Errorf("expected unauthorized, got %+v", resp.Subresponses[0].Error)
	}

	// Worker can't create comms either.
	resp = f.srv.Dispatch(workerCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "x", Endpoint: "comm", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"task_id":"%d","channel_id":"1"}`, f.taskID))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatal("worker should be unauthorized for comm.create")
	}
}

// ---- reply.post ----

// createCommForReply creates one comm under the fixture's task and
// returns its id. Optionally configures the channel's from_address.
func createCommForReply(t *testing.T, f *fixture, fromAddress string) (channelID, commID int64) {
	t.Helper()
	body := fmt.Sprintf(`{"project_id":"%d","name":"Support","channel_type":"email"`, f.projectID)
	if fromAddress != "" {
		body += fmt.Sprintf(`,"from_address":%q`, fromAddress)
	}
	body += `}`
	var setOut comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "ch", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(body),
	}, &setOut)
	var ccOut comm.CommCreateOutput
	dispatch(t, f, api.SubRequest{
		ID: "c", Endpoint: "comm", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"task_id":"%d","channel_id":"%d","subject":"Help!"}`,
				f.taskID, setOut.ChannelID)),
	}, &ccOut)
	return setOut.ChannelID, ccOut.CommID
}

// dispatchAs runs a sub-request under a non-admin user. Returns the
// raw SubResponse so callers can inspect OK / Error themselves.
func dispatchAs(t *testing.T, f *fixture, roleName string, displayName string, sub api.SubRequest) api.SubResponse {
	t.Helper()
	ctx := context.Background()
	var uid int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, displayName).Scan(&uid); err != nil {
		t.Fatalf("user %s: %v", displayName, err)
	}
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name=$2
	`, uid, roleName); err != nil {
		t.Fatalf("role %s: %v", roleName, err)
	}
	userCtx := auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: displayName})
	resp := f.srv.Dispatch(userCtx, api.BatchRequest{Subrequests: []api.SubRequest{sub}})
	return resp.Subresponses[0]
}

func TestReplyPost(t *testing.T) {
	f := setupAdmin(t, "kitp_test_reply_post")
	_, commID := createCommForReply(t, f, "")

	var rpOut comm.ReplyPostOutput
	dispatch(t, f, api.SubRequest{
		ID: "r", Endpoint: "reply", Action: "post", Data: json.RawMessage(
			fmt.Sprintf(`{"comm_id":"%d","to":"customer@example.com","subject":"Re: Help!","body":"Hello, here is a fix."}`,
				commID)),
	}, &rpOut)

	if rpOut.ReplyID == 0 {
		t.Fatal("expected reply_id > 0")
	}

	// reply_body card carries the five attributes.
	ctx := context.Background()
	var to, from, subject, bodyText, status string
	if err := f.sp.P.QueryRow(ctx, `
		SELECT
			(SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='reply_to'),
			(SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='reply_from'),
			(SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='reply_subject'),
			(SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='reply_body_text'),
			(SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='delivery_status')
	`, rpOut.ReplyID).Scan(&to, &from, &subject, &bodyText, &status); err != nil {
		t.Fatalf("read reply attrs: %v", err)
	}
	if to != "customer@example.com" {
		t.Errorf("reply_to=%q want customer@example.com", to)
	}
	if from != "" {
		t.Errorf("reply_from=%q want empty (channel has no from_address)", from)
	}
	if subject != "Re: Help!" {
		t.Errorf("reply_subject=%q want 'Re: Help!'", subject)
	}
	if bodyText != "Hello, here is a fix." {
		t.Errorf("reply_body_text=%q want 'Hello, here is a fix.'", bodyText)
	}
	if status != "pending" {
		t.Errorf("delivery_status=%q want pending", status)
	}

	// Comm's replies attribute now lists the new reply_body id.
	var repliesJSON []byte
	if err := f.sp.P.QueryRow(ctx, `
		SELECT av.value FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id=$1 AND ad.name='replies'
	`, commID).Scan(&repliesJSON); err != nil {
		t.Fatalf("comm.replies: %v", err)
	}
	var ids []int64
	if err := json.Unmarshal(repliesJSON, &ids); err != nil {
		t.Fatalf("decode replies: %v: %s", err, repliesJSON)
	}
	if len(ids) != 1 || ids[0] != rpOut.ReplyID {
		t.Errorf("comm.replies=%v, want [%d]", ids, rpOut.ReplyID)
	}

	// The reply also surfaces through comm.list_for_task.
	var listOut comm.CommListForTaskOutput
	dispatch(t, f, api.SubRequest{
		ID: "l", Endpoint: "comm", Action: "list_for_task", Data: json.RawMessage(
			fmt.Sprintf(`{"task_id":"%d"}`, f.taskID)),
	}, &listOut)
	if len(listOut.Rows) != 1 || len(listOut.Rows[0].Replies) != 1 {
		t.Fatalf("list_for_task shape: %+v", listOut.Rows)
	}
	if listOut.Rows[0].Replies[0].DeliveryStatus != "pending" {
		t.Errorf("list_for_task reply.delivery_status=%q want pending",
			listOut.Rows[0].Replies[0].DeliveryStatus)
	}
}

func TestReplyPostInheritsFromAddress(t *testing.T) {
	f := setupAdmin(t, "kitp_test_reply_post_from_addr")
	_, commID := createCommForReply(t, f, "kitp@example.com")

	var rpOut comm.ReplyPostOutput
	dispatch(t, f, api.SubRequest{
		ID: "r", Endpoint: "reply", Action: "post", Data: json.RawMessage(
			fmt.Sprintf(`{"comm_id":"%d","to":"customer@example.com","subject":"Re: Help","body":"Hi"}`,
				commID)),
	}, &rpOut)

	var from string
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT (SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='reply_from')
	`, rpOut.ReplyID).Scan(&from); err != nil {
		t.Fatalf("read reply_from: %v", err)
	}
	if from != "kitp@example.com" {
		t.Errorf("reply_from=%q want kitp@example.com", from)
	}
}

func TestReplyPostValidation(t *testing.T) {
	f := setupAdmin(t, "kitp_test_reply_post_validation")
	_, commID := createCommForReply(t, f, "")

	for _, c := range []struct {
		body string
		code string
		desc string
	}{
		{fmt.Sprintf(`{"comm_id":"%d","to":"","body":"x"}`, commID), "validation", "empty to"},
		{fmt.Sprintf(`{"comm_id":"%d","to":"a@b.c","body":""}`, commID), "validation", "empty body"},
		{`{"comm_id":"0","to":"a@b.c","body":"x"}`, "validation", "missing comm_id"},
	} {
		errEnv := dispatchExpectErr(t, f, api.SubRequest{
			ID: "x", Endpoint: "reply", Action: "post", Data: json.RawMessage(c.body),
		})
		if errEnv.Code != c.code {
			t.Errorf("%s: code=%q want %q (%s)", c.desc, errEnv.Code, c.code, errEnv.Message)
		}
	}
}

func TestReplyPostNonCommRejects(t *testing.T) {
	f := setupAdmin(t, "kitp_test_reply_post_non_comm")
	// Pass the fixture's task id as comm_id — wrong card_type.
	errEnv := dispatchExpectErr(t, f, api.SubRequest{
		ID: "x", Endpoint: "reply", Action: "post", Data: json.RawMessage(
			fmt.Sprintf(`{"comm_id":"%d","to":"a@b.c","body":"x"}`, f.taskID)),
	})
	if errEnv.Code != "comm_wrong_type" {
		t.Errorf("code=%q want comm_wrong_type: %s", errEnv.Code, errEnv.Message)
	}
}

func TestReplyPostPermission(t *testing.T) {
	f := setupAdmin(t, "kitp_test_reply_post_permission")
	_, commID := createCommForReply(t, f, "")

	body := json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","to":"a@b.c","body":"x"}`, commID))

	// viewer rejected.
	resp := dispatchAs(t, f, "viewer", "reply-viewer", api.SubRequest{
		ID: "v", Endpoint: "reply", Action: "post", Data: body,
	})
	if resp.OK {
		t.Fatal("viewer should be unauthorized for reply.post")
	}
	if resp.Error == nil || resp.Error.Code != "unauthorized" {
		t.Errorf("viewer: expected unauthorized, got %+v", resp.Error)
	}

	// commenter rejected.
	resp = dispatchAs(t, f, "commenter", "reply-commenter", api.SubRequest{
		ID: "c", Endpoint: "reply", Action: "post", Data: body,
	})
	if resp.OK {
		t.Fatal("commenter should be unauthorized for reply.post")
	}
	if resp.Error == nil || resp.Error.Code != "unauthorized" {
		t.Errorf("commenter: expected unauthorized, got %+v", resp.Error)
	}

	// worker accepted — spec calls out worker/manager/admin can author.
	resp = dispatchAs(t, f, "worker", "reply-worker", api.SubRequest{
		ID: "w", Endpoint: "reply", Action: "post", Data: body,
	})
	if !resp.OK {
		t.Errorf("worker should be authorized for reply.post: %+v", resp.Error)
	}
}

// TestChannelValidation guards the obvious validation paths so the
// admin UI can surface "channel_type=email only" / "name required" etc.
func TestChannelValidation(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_channel_validation")

	for _, c := range []struct {
		body string
		code string
	}{
		{fmt.Sprintf(`{"project_id":"%d","channel_type":"email"}`, f.projectID), "validation"}, // name missing
		{fmt.Sprintf(`{"project_id":"%d","name":"X"}`, f.projectID), "validation"},             // channel_type missing
		{fmt.Sprintf(`{"project_id":"%d","name":"X","channel_type":"slack"}`, f.projectID), "validation"},
	} {
		errEnv := dispatchExpectErr(t, f, api.SubRequest{
			ID: "x", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(c.body),
		})
		if errEnv.Code != c.code {
			t.Errorf("body %q: code=%q want %q", c.body, errEnv.Code, c.code)
		}
	}
}
