package api

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"testing"

	"github.com/andybalholm/brotli"
)

func TestWriteJSONCompressed(t *testing.T) {
	// A batch-shaped payload large + repetitive enough that compression
	// meaningfully shrinks it (mirrors real card/attribute JSON).
	rows := make([]map[string]any, 200)
	for i := range rows {
		rows[i] = map[string]any{
			"id": fmt.Sprintf("%d", i), "card_type_name": "task",
			"title": "a reasonably repetitive task title for compression",
		}
	}
	payload := map[string]any{"rows": rows}
	wantJSON, _ := json.Marshal(payload)

	cases := []struct {
		name       string
		accept     string
		wantEnc    string
		decompress func([]byte) ([]byte, error)
	}{
		{"identity-none", "", "", func(b []byte) ([]byte, error) { return b, nil }},
		{"identity-unsupported", "zstd", "", func(b []byte) ([]byte, error) { return b, nil }},
		{"gzip", "gzip", "gzip", func(b []byte) ([]byte, error) {
			zr, err := gzip.NewReader(bytes.NewReader(b))
			if err != nil {
				return nil, err
			}
			return io.ReadAll(zr)
		}},
		{"brotli-preferred", "br, gzip", "br", func(b []byte) ([]byte, error) {
			return io.ReadAll(brotli.NewReader(bytes.NewReader(b)))
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/v1/batch", nil)
			if tc.accept != "" {
				r.Header.Set("Accept-Encoding", tc.accept)
			}
			w := httptest.NewRecorder()
			writeJSONCompressed(w, r, 200, payload)

			res := w.Result()
			if got := res.Header.Get("Content-Encoding"); got != tc.wantEnc {
				t.Fatalf("Content-Encoding = %q, want %q", got, tc.wantEnc)
			}
			if ct := res.Header.Get("Content-Type"); ct != "application/json" {
				t.Fatalf("Content-Type = %q", ct)
			}
			raw, err := io.ReadAll(res.Body)
			if err != nil {
				t.Fatal(err)
			}
			plain, err := tc.decompress(raw)
			if err != nil {
				t.Fatalf("decompress: %v", err)
			}
			if got := string(plain); got != string(wantJSON)+"\n" { // Encode appends \n
				t.Fatalf("decoded body mismatch (len got=%d want=%d)", len(got), len(wantJSON)+1)
			}
			if tc.wantEnc != "" {
				if len(raw) >= len(wantJSON) {
					t.Errorf("%s: compressed %d >= raw %d (no shrink)", tc.wantEnc, len(raw), len(wantJSON))
				}
				t.Logf("%s: %d -> %d bytes (%.1fx)", tc.wantEnc, len(wantJSON), len(raw), float64(len(wantJSON))/float64(len(raw)))
			}
		})
	}
}
