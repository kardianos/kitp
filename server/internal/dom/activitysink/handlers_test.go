package activitysink_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activitysink"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// sinkFixture seeds the per-test rows the activity_sink handlers and
// pumper need: an admin user with the admin role, a project the sink
// will live under, and one task whose activity rows we can sample.
//
// Mirrors comm_test.setupAdmin but minimal — activity_sink has no
// dependency on the comm flow / status value-cards beyond the basics.
type sinkFixture struct {
	srv       *api.Server
	sp        *store.Pool
	ctx       context.Context
	adminID   int64
	projectID int64
	statusID  int64
	taskID    int64
}

func setupSink(t *testing.T, schemaName string) *sinkFixture {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schemaName)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activitysink.Register(sp)

	srv := api.NewServer(sp)
	ctx := context.Background()

	var uid int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('sink-admin') RETURNING id`).Scan(&uid); err != nil {
		t.Fatalf("admin user: %v", err)
	}
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name='admin'
	`, uid); err != nil {
		t.Fatalf("admin grant: %v", err)
	}
	adminCtx := auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: "sink-admin"})

	dispatch := func(sub api.SubRequest, out any) {
		resp := srv.Dispatch(adminCtx, api.BatchRequest{Subrequests: []api.SubRequest{sub}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("%s.%s: %+v", sub.Endpoint, sub.Action, resp.Subresponses[0])
		}
		if out != nil {
			buf, _ := json.Marshal(resp.Subresponses[0].Data)
			if err := json.Unmarshal(buf, out); err != nil {
				t.Fatalf("decode %s.%s: %v", sub.Endpoint, sub.Action, err)
			}
		}
	}

	var pOut card.InsertOutput
	dispatch(api.SubRequest{ID: "p", Endpoint: "card", Action: "insert",
		Data: json.RawMessage(`{"card_type_name":"project","title":"Sink Test"}`)}, &pOut)

	var sOut card.InsertOutput
	dispatch(api.SubRequest{ID: "s", Endpoint: "card", Action: "insert",
		Data: json.RawMessage(fmt.Sprintf(
			`{"card_type_name":"status","parent_card_id":"%d","title":"Todo"}`, pOut.ID))}, &sOut)

	var tOut card.InsertOutput
	dispatch(api.SubRequest{ID: "t", Endpoint: "card", Action: "insert",
		Data: json.RawMessage(fmt.Sprintf(
			`{"card_type_name":"task","parent_card_id":"%d","title":"Issue 1","attributes":{"status":"%d"}}`,
			pOut.ID, sOut.ID))}, &tOut)

	return &sinkFixture{
		srv:       srv,
		sp:        sp,
		ctx:       adminCtx,
		adminID:   uid,
		projectID: pOut.ID,
		statusID:  sOut.ID,
		taskID:    tOut.ID,
	}
}

func dispatch(t *testing.T, f *sinkFixture, sub api.SubRequest, v any) {
	t.Helper()
	resp := f.srv.Dispatch(f.ctx, api.BatchRequest{Subrequests: []api.SubRequest{sub}})
	if !resp.Subresponses[0].OK {
		errStr := "<nil>"
		if e := resp.Subresponses[0].Error; e != nil {
			errStr = fmt.Sprintf("code=%s msg=%s", e.Code, e.Message)
		}
		t.Fatalf("%s.%s failed: %s", sub.Endpoint, sub.Action, errStr)
	}
	if v != nil {
		buf, _ := json.Marshal(resp.Subresponses[0].Data)
		if err := json.Unmarshal(buf, v); err != nil {
			t.Fatalf("decode %s.%s: %v", sub.Endpoint, sub.Action, err)
		}
	}
}

// seedSink creates an activity_sink card with stock MS Graph fields and
// returns its id. Tests then drive RunOnce against the returned id.
func seedSink(t *testing.T, f *sinkFixture, filterJSON string) int64 {
	t.Helper()
	body := fmt.Sprintf(`{
		"project_id":"%d",
		"name":"Teams sink",
		"sink_kind":"msgraph_teams",
		"msgraph_tenant_id":"tenant-uuid",
		"msgraph_client_id":"client-uuid",
		"msgraph_client_secret":"super-secret",
		"msgraph_team_id":"team-id",
		"msgraph_channel_id":"channel-id",
		"activity_filter":%q
	}`, f.projectID, filterJSON)
	var out activitysink.SinkSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "sink", Endpoint: "activity_sink", Action: "set", Data: json.RawMessage(body),
	}, &out)
	return out.SinkID
}

// pointerOf returns the last_activity_id stored for the sink, or 0 when
// no state row exists yet.
func pointerOf(t *testing.T, f *sinkFixture, sinkID int64) int64 {
	t.Helper()
	var pointer int64
	err := f.sp.P.QueryRow(context.Background(),
		`SELECT COALESCE(last_activity_id, 0) FROM activity_sink_state WHERE sink_card_id = $1`,
		sinkID).Scan(&pointer)
	if err != nil && !strings.Contains(err.Error(), "no rows") {
		t.Fatalf("pointer read: %v", err)
	}
	return pointer
}

// markSinkStatusViaSet flips a sink's channel_status by going through
// the public activity_sink.set handler — same path the admin UI uses.
func markSinkStatusViaSet(t *testing.T, f *sinkFixture, sinkID int64, status string) {
	t.Helper()
	body := fmt.Sprintf(`{
		"id":"%d","project_id":"%d","name":"Teams sink","sink_kind":"msgraph_teams",
		"channel_status":%q
	}`, sinkID, f.projectID, status)
	var out activitysink.SinkSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "sink", Endpoint: "activity_sink", Action: "set", Data: json.RawMessage(body),
	}, &out)
}

// ---- handler tests ----

func TestSinkSetCreateAndList(t *testing.T) {
	f := setupSink(t, "kitp_test_sink_set_list")
	sinkID := seedSink(t, f, "")

	var list activitysink.SinkListOutput
	dispatch(t, f, api.SubRequest{
		ID: "ls", Endpoint: "activity_sink", Action: "list",
		Data: json.RawMessage(fmt.Sprintf(`{"project_id":"%d"}`, f.projectID)),
	}, &list)

	if len(list.Rows) != 1 {
		t.Fatalf("want 1 sink, got %d", len(list.Rows))
	}
	r := list.Rows[0]
	if r.ID != sinkID {
		t.Errorf("id=%d want %d", r.ID, sinkID)
	}
	if r.Name != "Teams sink" || r.SinkKind != "msgraph_teams" {
		t.Errorf("name/kind mismatch: %+v", r)
	}
	if r.MSGraphTeamID != "team-id" || r.MSGraphChannelID != "channel-id" {
		t.Errorf("team/channel mismatch: %+v", r)
	}
	if !r.HasClientSecret {
		t.Error("has_client_secret should be true after seeding with a secret")
	}
	// Default status is enabled when not explicitly set.
	if r.Status != comm.ChannelStatusEnabled {
		t.Errorf("default status=%q want %q", r.Status, comm.ChannelStatusEnabled)
	}
}

func TestSinkSetRejectsBadFilter(t *testing.T) {
	f := setupSink(t, "kitp_test_sink_bad_filter")
	body := fmt.Sprintf(`{
		"project_id":"%d","name":"x","sink_kind":"msgraph_teams",
		"activity_filter":"{not json"
	}`, f.projectID)
	resp := f.srv.Dispatch(f.ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "activity_sink", Action: "set", Data: json.RawMessage(body)},
	}})
	if resp.Subresponses[0].OK {
		t.Fatal("activity_sink.set should reject invalid filter JSON")
	}
}

// ---- pumper tests ----

// stubPoster records every call and lets the test drive the return
// value to simulate transient / permanent failures.
type stubPoster struct {
	calls []string
	err   error
}

func (s *stubPoster) post(_ context.Context, _ activitysink.MSGraphConfig, message string) error {
	s.calls = append(s.calls, message)
	return s.err
}

func TestPumperSkipsWhenDisabledAdmin(t *testing.T) {
	f := setupSink(t, "kitp_test_sink_disabled_admin")
	sinkID := seedSink(t, f, "")
	markSinkStatusViaSet(t, f, sinkID, comm.ChannelStatusDisabledAdmin)

	stub := &stubPoster{}
	p := activitysink.NewMSGraphPumperForTest(f.sp, sinkID, f.projectID, time.Second)
	p.SetPoster(stub.post)
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(stub.calls) != 0 {
		t.Errorf("poster called %d times while disabled-admin (want 0)", len(stub.calls))
	}
}

func TestPumperPushesAndAdvancesPointer(t *testing.T) {
	f := setupSink(t, "kitp_test_sink_push_advance")
	sinkID := seedSink(t, f, "")

	stub := &stubPoster{}
	p := activitysink.NewMSGraphPumperForTest(f.sp, sinkID, f.projectID, time.Second)
	p.SetPoster(stub.post)
	p.SetBatchLimit(10_000) // drain the fixture in one tick

	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(stub.calls) == 0 {
		t.Fatal("expected at least one push for the project/task seeded by the fixture")
	}
	firstPointer := pointerOf(t, f, sinkID)
	if firstPointer == 0 {
		t.Fatal("pointer should advance past 0 after a successful push")
	}

	// A second RunOnce with no new activity should be a no-op for both
	// the pointer (already at the high-water mark) and the poster.
	priorCalls := len(stub.calls)
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce idle: %v", err)
	}
	if len(stub.calls) != priorCalls {
		t.Errorf("poster called %d new times on idle tick (want 0)", len(stub.calls)-priorCalls)
	}
	if pointerOf(t, f, sinkID) != firstPointer {
		t.Errorf("pointer drifted on idle tick: %d vs %d", pointerOf(t, f, sinkID), firstPointer)
	}
}

func TestPumperAppliesFilter(t *testing.T) {
	// Drop every kind except comment, then make sure no rows ship —
	// the fixture only seeds card_create + attr_update rows.
	f := setupSink(t, "kitp_test_sink_filter")
	sinkID := seedSink(t, f, `{"op":"kind_in","values":["comment"]}`)

	stub := &stubPoster{}
	p := activitysink.NewMSGraphPumperForTest(f.sp, sinkID, f.projectID, time.Second)
	p.SetPoster(stub.post)
	p.SetBatchLimit(10_000)
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(stub.calls) != 0 {
		t.Errorf("filter blocked all rows but poster got %d calls", len(stub.calls))
	}
	// Pointer should still advance past scanned rows — re-running must
	// not rescan, regardless of filter outcome.
	if pointerOf(t, f, sinkID) == 0 {
		t.Error("pointer should advance even when filter drops every row")
	}
}

func TestPumperMarksFaultOnPermanentError(t *testing.T) {
	f := setupSink(t, "kitp_test_sink_perm_fault")
	sinkID := seedSink(t, f, "")

	stub := &stubPoster{err: &activitysink.MSGraphPermanentError{Status: 401, Body: "InvalidAuthenticationToken"}}
	p := activitysink.NewMSGraphPumperForTest(f.sp, sinkID, f.projectID, time.Second)
	p.SetPoster(stub.post)

	err := p.RunOnce(context.Background())
	if err == nil {
		t.Fatal("expected permanent error from RunOnce")
	}
	var perm *activitysink.MSGraphPermanentError
	if !errors.As(err, &perm) {
		t.Fatalf("error type=%T want *MSGraphPermanentError: %v", err, err)
	}

	// Sink should now be disabled-fault with the error embedded.
	status, reason := readSinkStatus(t, f, sinkID)
	if status != comm.ChannelStatusDisabledFault {
		t.Errorf("status=%q want %q", status, comm.ChannelStatusDisabledFault)
	}
	if !strings.Contains(reason, "401") {
		t.Errorf("fault reason should embed graph status, got %q", reason)
	}
}

// readSinkStatus reads channel_status + channel_fault_reason directly
// from attribute_value. Mirrors comm_test.readChannelStatusDirect.
func readSinkStatus(t *testing.T, f *sinkFixture, sinkID int64) (string, string) {
	t.Helper()
	var statusRaw, reasonRaw []byte
	err := f.sp.P.QueryRow(context.Background(), `
		SELECT
			(SELECT value FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			   WHERE av.card_id = $1 AND ad.name = 'channel_status'),
			(SELECT value FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			   WHERE av.card_id = $1 AND ad.name = 'channel_fault_reason')
	`, sinkID).Scan(&statusRaw, &reasonRaw)
	if err != nil {
		t.Fatalf("read sink status: %v", err)
	}
	var status, reason string
	_ = json.Unmarshal(statusRaw, &status)
	_ = json.Unmarshal(reasonRaw, &reason)
	return status, reason
}
