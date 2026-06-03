package mcp_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/store"
)

// TestMCPSubprocess_Initialize_ToolsList_ToolsCall spawns the kitpd
// binary in mcp mode, sends initialize / tools/list / tools/call
// (echo__ping), and asserts each response.
func TestMCPSubprocess_Initialize_ToolsList_ToolsCall(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping subprocess test in -short")
	}
	pool := store.TestPool(t, "kitp_test_mcp_e2e")
	dsn := poolDSN(t, pool)

	bin := buildKitpd(t)

	cmd := exec.Command(bin, "mcp")
	cmd.Env = append(os.Environ(),
		"DATABASE_URL="+dsn,
		"AUTH_MODE=off",
		"ENV=dev",
		"LOG_LEVEL=warn",
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()

	rd := bufio.NewReader(stdout)

	send := func(t *testing.T, method string, id any, params any) []byte {
		t.Helper()
		req := map[string]any{
			"jsonrpc": "2.0",
			"id":      id,
			"method":  method,
		}
		if params != nil {
			req["params"] = params
		}
		buf, err := json.Marshal(req)
		if err != nil {
			t.Fatal(err)
		}
		buf = append(buf, '\n')
		if _, err := stdin.Write(buf); err != nil {
			t.Fatalf("write %s: %v", method, err)
		}
		// Read one line within a generous deadline.
		line, err := readLineWithTimeout(rd, 10*time.Second)
		if err != nil {
			t.Fatalf("read %s: %v (stderr: %s)", method, err, stderr.String())
		}
		return line
	}

	// 1. initialize
	resp := send(t, "initialize", 1, map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "test-driver", "version": "0"},
	})
	{
		var got struct {
			Result struct {
				ProtocolVersion string `json:"protocolVersion"`
				ServerInfo      struct {
					Name string `json:"name"`
				} `json:"serverInfo"`
			} `json:"result"`
			Error any `json:"error"`
		}
		if err := json.Unmarshal(resp, &got); err != nil {
			t.Fatalf("initialize decode: %v: %s", err, resp)
		}
		if got.Error != nil {
			t.Fatalf("initialize error: %v", got.Error)
		}
		if got.Result.ProtocolVersion == "" || got.Result.ServerInfo.Name != "kitp" {
			t.Fatalf("initialize result: %s", resp)
		}
	}

	// 2. tools/list
	resp = send(t, "tools/list", 2, map[string]any{})
	{
		var got struct {
			Result struct {
				Tools []struct {
					Name string `json:"name"`
				} `json:"tools"`
			} `json:"result"`
			Error any `json:"error"`
		}
		if err := json.Unmarshal(resp, &got); err != nil {
			t.Fatalf("tools/list decode: %v", err)
		}
		if got.Error != nil {
			t.Fatalf("tools/list error: %v", got.Error)
		}
		// Must include the proc__batch meta-tool, proc__search, and
		// representative curated handlers so we know the curated surface
		// is wired correctly.
		want := []string{"proc__batch", "echo__ping", "proc__search", "card__insert", "attribute__update"}
		gotNames := make(map[string]bool, len(got.Result.Tools))
		for _, tt := range got.Result.Tools {
			gotNames[tt.Name] = true
		}
		for _, w := range want {
			if !gotNames[w] {
				t.Errorf("tools/list missing %q. got: %v", w, gotNames)
			}
		}
		// Non-curated handlers must NOT be advertised as standalone
		// tools — they stay reachable only via proc__search + proc__batch.
		for _, hidden := range []string{"user_token__create", "user_role__set", "flow__set", "comm__set_recipients"} {
			if gotNames[hidden] {
				t.Errorf("tools/list should not advertise non-curated %q", hidden)
			}
		}
	}

	// 2b. proc__batch reaches a non-curated op (role__list) and runs it
	// through the same dispatcher path, returning a per-op result.
	resp = send(t, "tools/call", 22, map[string]any{
		"name": "proc__batch",
		"arguments": map[string]any{
			"ops": []map[string]any{
				{"endpoint": "role", "action": "list", "data": map[string]any{}},
			},
		},
	})
	{
		var got struct {
			Result struct {
				IsError bool `json:"isError"`
				Data    struct {
					Results []struct {
						Idx  int    `json:"idx"`
						OK   bool   `json:"ok"`
						Code string `json:"code"`
					} `json:"results"`
				} `json:"data"`
			} `json:"result"`
			Error any `json:"error"`
		}
		if err := json.Unmarshal(resp, &got); err != nil {
			t.Fatalf("proc__batch decode: %v: %s", err, resp)
		}
		if got.Error != nil {
			t.Fatalf("proc__batch error: %v", got.Error)
		}
		if got.Result.IsError {
			t.Fatalf("proc__batch envelope isError=true: %s", resp)
		}
		if len(got.Result.Data.Results) != 1 {
			t.Fatalf("proc__batch want 1 result, got %d: %s", len(got.Result.Data.Results), resp)
		}
		if r := got.Result.Data.Results[0]; !r.OK {
			t.Fatalf("proc__batch role.list op failed: code=%q", r.Code)
		}
	}

	// 3. tools/call -> echo__ping
	resp = send(t, "tools/call", 3, map[string]any{
		"name": "echo__ping",
		"arguments": map[string]any{
			"x":       42,
			"message": "hello",
		},
	})
	{
		var got struct {
			Result map[string]any `json:"result"`
			Error  any            `json:"error"`
		}
		if err := json.Unmarshal(resp, &got); err != nil {
			t.Fatalf("tools/call decode: %v", err)
		}
		if got.Error != nil {
			t.Fatalf("tools/call error: %v", got.Error)
		}
		// data should carry x:42 and message:hello.
		dataRaw, _ := json.Marshal(got.Result["data"])
		var data struct {
			X       int    `json:"x"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(dataRaw, &data); err != nil {
			t.Fatalf("tools/call data decode: %v: %s", err, dataRaw)
		}
		if data.X != 42 || data.Message != "hello" {
			t.Fatalf("tools/call data: %+v", data)
		}
	}
}

// readLineWithTimeout returns one CR-stripped line from rd, or an error
// if the deadline expires.
func readLineWithTimeout(rd *bufio.Reader, d time.Duration) ([]byte, error) {
	type lr struct {
		line []byte
		err  error
	}
	ch := make(chan lr, 1)
	go func() {
		l, err := rd.ReadBytes('\n')
		ch <- lr{l, err}
	}()
	select {
	case r := <-ch:
		if r.err != nil && r.err != io.EOF {
			return nil, r.err
		}
		return bytes.TrimRight(r.line, "\r\n"), nil
	case <-time.After(d):
		return nil, context.DeadlineExceeded
	}
}

// buildKitpd compiles the kitpd binary for the duration of the test.
// We compile every time so we always test current source.
func buildKitpd(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "kitpd")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	cmd := exec.Command("go", "build", "-o", bin, "./cmd/kitpd")
	cmd.Dir = serverRoot(t)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

// serverRoot returns the absolute path of the server module root, so
// `go build` finds cmd/kitpd.
func serverRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// Walk up looking for go.mod.
	d := wd
	for range 8 {
		if _, err := os.Stat(filepath.Join(d, "go.mod")); err == nil {
			return d
		}
		d = filepath.Dir(d)
	}
	t.Fatalf("go.mod not found above %s", wd)
	return ""
}

// poolDSN extracts the DSN that store.TestPool used to create the pool.
// We rely on the same env var fallback as TestPool (DATABASE_URL or the
// default 127.0.0.1:5544 dev DB), but we prepend the schema search path.
//
// The subprocess connects with the default search_path ("public") and
// then runs migrations into the test schema. Our TestPool already
// migrated into the schema; we want the subprocess to run AGAINST
// that schema. So we pass the test schema name via an explicit DSN
// option (search_path).
func poolDSN(t *testing.T, _ any) string {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://kitp:kitp@127.0.0.1:5544/kitp?sslmode=disable"
	}
	// Append the test schema search_path option.
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	return dsn + sep + "search_path=kitp_test_mcp_e2e,public"
}
