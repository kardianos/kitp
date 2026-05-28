// Per-request logging toggle (KITP_REQUEST_LOG=1 in kitpd) — confirms the
// dispatcher's per-batch + per-subrequest slog lines fire ONLY when the
// Server's RequestLog flag is on, regardless of the Logger's level.
package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// captureLogger returns a JSON slog logger writing to buf at LevelDebug so
// BOTH the batch (info) + subrequest (debug) lines can land when enabled.
func captureLogger() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	h := slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})
	return slog.New(h), &buf
}

// pingBatch builds a one-row echo.ping request used to exercise Dispatch.
func pingBatch() api.BatchRequest {
	return api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Type: "data", Endpoint: "echo", Action: "ping",
			Data: json.RawMessage(`{"x":1,"message":"hi"}`)},
	}}
}

// TestServer_RequestLogOffByDefault — a fresh api.Server has RequestLog=false,
// so a successful Dispatch emits NO batch + NO subrequest log lines (the
// default kitpd posture; KITP_REQUEST_LOG=1 flips it).
func TestServer_RequestLogOffByDefault(t *testing.T) {
	reg.Reset()
	echo.Register()
	pool := store.TestPool(t, "kitp_test_request_log_off")
	srv := api.NewServer(store.NewPool(pool))
	logger, buf := captureLogger()
	srv.Logger = logger
	// srv.RequestLog stays false (zero value).

	resp := srv.Dispatch(context.Background(), pingBatch())
	if !resp.Subresponses[0].OK {
		t.Fatalf("ping failed: %+v", resp.Subresponses[0])
	}
	out := buf.String()
	if strings.Contains(out, `"msg":"batch"`) {
		t.Errorf("RequestLog off but got a batch line:\n%s", out)
	}
	if strings.Contains(out, `"msg":"subrequest"`) {
		t.Errorf("RequestLog off but got a subrequest line:\n%s", out)
	}
}

// TestServer_RequestLogOnEmits — flipping RequestLog to true brings back the
// per-batch (info) + per-subrequest (debug) lines, with the structured fields.
func TestServer_RequestLogOnEmits(t *testing.T) {
	reg.Reset()
	echo.Register()
	pool := store.TestPool(t, "kitp_test_request_log_on")
	srv := api.NewServer(store.NewPool(pool))
	logger, buf := captureLogger()
	srv.Logger = logger
	srv.RequestLog = true

	resp := srv.Dispatch(context.Background(), pingBatch())
	if !resp.Subresponses[0].OK {
		t.Fatalf("ping failed: %+v", resp.Subresponses[0])
	}
	out := buf.String()
	if !strings.Contains(out, `"msg":"batch"`) {
		t.Errorf("RequestLog on but missing the batch line:\n%s", out)
	}
	if !strings.Contains(out, `"msg":"subrequest"`) {
		t.Errorf("RequestLog on but missing the subrequest line:\n%s", out)
	}
	// Structured fields the line carries (sanity).
	if !strings.Contains(out, `"endpoint":"echo"`) || !strings.Contains(out, `"action":"ping"`) {
		t.Errorf("subrequest line missing endpoint/action fields:\n%s", out)
	}
}
