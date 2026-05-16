package comm_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
)

// markChannelStatusViaSet flips a channel's status by going through
// the public comm_channel.set handler — the same path the admin UI
// uses — rather than poking attribute_value directly. Tests use it
// to put the fixture into the precondition state for the gates.
func markChannelStatusViaSet(t *testing.T, f *fixture, channelID int64, status string) {
	t.Helper()
	body := fmt.Sprintf(`{
		"id":"%d","project_id":"%d","name":"Support","channel_type":"email",
		"channel_status":%q
	}`, channelID, f.projectID, status)
	var out comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "ch", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(body),
	}, &out)
}

// readChannelStatusDirect peeks at the channel_status attribute via a
// raw SQL read. Used by the auto-disable test to confirm the runtime
// flipped the value without going through comm_channel.list.
func readChannelStatusDirect(t *testing.T, f *fixture, channelID int64) (string, string) {
	t.Helper()
	var statusRaw, reasonRaw []byte
	err := f.sp.P.QueryRow(context.Background(), `
		SELECT
			(SELECT value FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			   WHERE av.card_id = $1 AND ad.name = 'channel_status'),
			(SELECT value FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			   WHERE av.card_id = $1 AND ad.name = 'channel_fault_reason')
	`, channelID).Scan(&statusRaw, &reasonRaw)
	if err != nil {
		t.Fatalf("read channel_status: %v", err)
	}
	var status, reason string
	_ = json.Unmarshal(statusRaw, &status)
	_ = json.Unmarshal(reasonRaw, &reason)
	return status, reason
}

// TestIMAPPollerSkipsWhenDisabledAdmin verifies the status gate: an
// admin-paused channel runs RunOnce without dialing or marking
// messages seen.
func TestIMAPPollerSkipsWhenDisabledAdmin(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_disabled_admin")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", 0)
	markChannelStatusViaSet(t, f, channelID, comm.ChannelStatusDisabledAdmin)

	dialed := false
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(ctx context.Context, _ comm.IMAPConfig) (comm.InboundClient, error) {
		dialed = true
		return &stubIMAPClient{}, nil
	})
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if dialed {
		t.Errorf("dial should NOT be invoked while channel is disabled-admin")
	}
}

// TestIMAPPollerSkipsWhenDisabledFault confirms a runtime-faulted
// channel also stays parked until an admin re-enables it.
func TestIMAPPollerSkipsWhenDisabledFault(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_disabled_fault")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", 0)
	markChannelStatusViaSet(t, f, channelID, comm.ChannelStatusDisabledFault)

	dialed := false
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(ctx context.Context, _ comm.IMAPConfig) (comm.InboundClient, error) {
		dialed = true
		return &stubIMAPClient{}, nil
	})
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if dialed {
		t.Errorf("dial should NOT be invoked while channel is disabled-fault")
	}
}

// TestIMAPPollerAuthFailTripsFault drives a credential-shaped dial
// failure through RunOnce and confirms the channel automatically
// flips to disabled-fault with the error embedded in fault_reason.
// This is the "credentials rotated" hazard: retrying with the same
// bad password risks account lockout, so trip immediately.
func TestIMAPPollerAuthFailTripsFault(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_auth_fail_trips")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", 0)

	dialErr := errors.New("AUTHENTICATIONFAILED Invalid credentials")
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(ctx context.Context, _ comm.IMAPConfig) (comm.InboundClient, error) {
		return nil, dialErr
	})
	if err := p.RunOnce(context.Background()); err == nil {
		t.Fatal("RunOnce should return dial error")
	}

	status, reason := readChannelStatusDirect(t, f, channelID)
	if status != comm.ChannelStatusDisabledFault {
		t.Errorf("status=%q want %q", status, comm.ChannelStatusDisabledFault)
	}
	if !strings.Contains(reason, "Invalid credentials") {
		t.Errorf("fault reason should embed dial error, got %q", reason)
	}
}

// TestIMAPPollerNetworkErrorDoesNotTrip confirms a transient
// network-shaped dial failure (i/o timeout, connection refused, TLS)
// does NOT immediately flip the channel into disabled-fault. The
// channel stays enabled and the backoff/cap-hits path is responsible
// for tripping it after the failure becomes sustained.
func TestIMAPPollerNetworkErrorDoesNotTrip(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_network_no_trip")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", 0)

	dialErr := errors.New("dial tcp 1.2.3.4:993: i/o timeout")
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(ctx context.Context, _ comm.IMAPConfig) (comm.InboundClient, error) {
		return nil, dialErr
	})
	if err := p.RunOnce(context.Background()); err == nil {
		t.Fatal("RunOnce should return dial error")
	}

	// Empty / unset is fine — it means no attribute_value row was
	// written, which is how an enabled-by-default channel reads. What
	// we care about is that the runtime did NOT flip to disabled-fault
	// on a network blip.
	status, _ := readChannelStatusDirect(t, f, channelID)
	if status == comm.ChannelStatusDisabledFault {
		t.Errorf("network error should NOT trip disabled-fault, got status=%q", status)
	}
}

// TestMarkChannelFaultSurvivesExpiredContext exercises the context
// detach in updateChannelStatus: even when the caller passes a
// context that is already past its deadline (as happens when an IMAP
// dial blocks long enough to exhaust the tick context), the status
// flip still lands. Without the detach, this returns "context
// deadline exceeded" — the exact failure mode the live server hit.
func TestMarkChannelFaultSurvivesExpiredContext(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_expired_ctx")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", 0)

	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	time.Sleep(time.Millisecond) // ensure the deadline is in the past

	if err := comm.MarkChannelFault(ctx, f.sp, channelID, "simulated"); err != nil {
		t.Fatalf("MarkChannelFault: %v", err)
	}
	if s, _ := readChannelStatusDirect(t, f, channelID); s != comm.ChannelStatusDisabledFault {
		t.Errorf("status=%q want %q", s, comm.ChannelStatusDisabledFault)
	}
}

// TestSustainedBackoffCapHits drives the bump-backoff counter and
// confirms capHits only starts climbing after the ceiling is reached
// twice in a row. Pure in-memory — no fixture needed.
func TestSustainedBackoffCapHits(t *testing.T) {
	// No DB needed: NewIMAPPollerForTest accepts a nil-friendly pool,
	// but the constructor stores it. We don't dial or write, so a nil
	// pool is fine for this state-machine test.
	p := comm.NewIMAPPollerForTest(nil, 0, 5*time.Second)

	// Each call to BumpBackoffForTest simulates one failed RunOnce.
	// Doubling sequence with backoffMin=30s, backoffMax=10m:
	//   30s, 1m, 2m, 4m, 8m, 10m (capped, first time), 10m (cap hit #1),
	//   10m (cap hit #2). Trip threshold is 2.
	wantCapHitsByCall := []int{
		0, // 30s
		0, // 1m
		0, // 2m
		0, // 4m
		0, // 8m
		0, // 10m capped, prev was 8m so no cap hit yet
		1, // 10m (prev=10m, current=10m → first cap hit)
		2, // 10m → second cap hit, trip threshold
		3, // 10m → still climbing
	}
	for i, want := range wantCapHitsByCall {
		p.BumpBackoffForTest()
		if got := p.CapHitsForTest(); got != want {
			t.Errorf("call %d: capHits=%d want %d (backoff=%v)", i, got, want, p.Backoff())
		}
	}
}

// TestReEnableClearsFaultReason confirms a deliberate admin re-enable
// also clears the stale fault reason so the admin UI doesn't keep
// surfacing the prior failure next to a healthy channel.
func TestReEnableClearsFaultReason(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_reenable_clears")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", 0)

	// Fault it via the runtime path so the fault_reason is set.
	if err := comm.MarkChannelFault(context.Background(), f.sp, channelID, "IMAP dial failed: boom"); err != nil {
		t.Fatalf("MarkChannelFault: %v", err)
	}
	if s, r := readChannelStatusDirect(t, f, channelID); s != comm.ChannelStatusDisabledFault || r == "" {
		t.Fatalf("pre-reenable: status=%q reason=%q", s, r)
	}

	// Admin re-enables via the regular handler path.
	markChannelStatusViaSet(t, f, channelID, comm.ChannelStatusEnabled)

	status, reason := readChannelStatusDirect(t, f, channelID)
	if status != comm.ChannelStatusEnabled {
		t.Errorf("status=%q want enabled", status)
	}
	if reason != "" {
		t.Errorf("fault reason should be cleared on re-enable, got %q", reason)
	}
}
