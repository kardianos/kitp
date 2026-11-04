package api_test

// Regression test for review 2026-11-03 round 2 #20: a sub-request whose
// data doesn't decode is told where, in its own words — never
// encoding/json's text, which names Go types and struct fields.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
)

func TestBadInputHidesDecoderText(t *testing.T) {
	srv, _ := setupServer(t, "kitp_test_r2_decode_text")
	resp := srv.Dispatch(context.Background(), api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "other", Action: "count", Data: json.RawMessage(`{"n":"not a number"}`)},
	}})
	sr := resp.Subresponses[0]
	if sr.OK || sr.Error == nil || sr.Error.Code != "bad_input" {
		t.Fatalf("sub-response = %+v, want bad_input", sr)
	}
	for _, leak := range []string{"Go struct", "otherInput", "api_test"} {
		if strings.Contains(sr.Error.Message, leak) {
			t.Errorf("message %q quotes the decoder (%q)", sr.Error.Message, leak)
		}
	}
	if !strings.Contains(sr.Error.Message, "n must be") {
		t.Errorf("message %q doesn't say which field", sr.Error.Message)
	}
}
