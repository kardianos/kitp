package mailin_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-msgauth/dkim"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/dom/flow"
	"github.com/kitp/kitp/server/internal/dom/mailin"
	"github.com/kitp/kitp/server/internal/netx"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

type fixture struct {
	srv       *api.Server
	sp        *store.Pool
	ctx       context.Context
	projectID int64
	channelID int64
	status    *mailin.Status
	trusted   *netx.Trusted
}

func dispatch(t *testing.T, f *fixture, endpoint, action string, data any) api.SubResponse {
	t.Helper()
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	return f.srv.Dispatch(f.ctx, api.BatchRequest{Subrequests: []api.SubRequest{{ID: "x", Endpoint: endpoint, Action: action, Data: b}}}).Subresponses[0]
}

func decode(t *testing.T, r api.SubResponse, v any) {
	t.Helper()
	if !r.OK {
		t.Fatalf("dispatch: %+v", r.Error)
	}
	b, _ := json.Marshal(r.Data)
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

func setup(t *testing.T, schema string) *fixture {
	t.Helper()
	reg.Reset()
	sp := store.NewPool(store.TestPool(t, schema))
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	flow.Register(sp)
	comm.Register(sp)
	trusted, _ := netx.ParseTrusted("")
	status := mailin.NewStatus(trusted)
	mailin.Register(sp, status)
	f := &fixture{srv: api.NewServer(sp), sp: sp, ctx: auth.WithSystemUser(context.Background()), status: status, trusted: trusted}

	var p card.InsertOutput
	decode(t, dispatch(t, f, "card", "insert", map[string]any{"card_type_name": "project", "title": "Intake"}), &p)
	f.projectID = p.ID
	var ch comm.ChannelSetOutput
	decode(t, dispatch(t, f, "comm_channel", "set", map[string]any{
		"project_id": fmt.Sprint(p.ID), "name": "Support", "channel_type": "email",
		"from_address": "support@example.com", "intake_mode": "thread",
		"smtp_host": "127.0.0.1", "smtp_port": 587, "smtp_username": "u", "smtp_password": "p",
	}), &ch)
	f.channelID = ch.ChannelID
	return f
}

func (f *fixture) route(t *testing.T, purpose, provider string, policy any, key string) mailin.RouteCreateOutput {
	t.Helper()
	in := map[string]any{"channel_id": fmt.Sprint(f.channelID), "purpose": purpose, "provider": provider, "comment": provider + " test"}
	if policy != nil {
		in["policy"] = policy
	}
	if key != "" {
		in["signing_key"] = key
	}
	var out mailin.RouteCreateOutput
	decode(t, dispatch(t, f, "comm_route", "create", in), &out)
	if len(out.Token) != 40 {
		t.Fatalf("token %q", out.Token)
	}
	return out
}

func (f *fixture) handler(maxBytes int64) http.Handler {
	rt := api.NewRouter(api.RouterConfig{})
	mailin.MountPOST(rt, mailin.POSTConfig{Pool: f.sp, Intake: &comm.Intake{Pool: f.sp}, Trusted: f.trusted, Status: f.status, MaxBytes: maxBytes})
	return rt.Mux()
}

func post(h http.Handler, path, ctype string, body []byte, remote string, hdr ...string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", path, bytes.NewReader(body))
	req.Header.Set("Content-Type", ctype)
	if remote != "" {
		req.RemoteAddr = remote
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func mailText(id, from, subject string) []byte {
	return []byte("From: " + from + "\r\nTo: support@example.com\r\nSubject: " + subject +
		"\r\nDate: Tue, 3 Nov 2026 10:00:00 +0000\r\nMessage-ID: " + id + "\r\n\r\nHello there.\r\n")
}

func statusOf(t *testing.T, rr *httptest.ResponseRecorder) string {
	t.Helper()
	var v struct {
		Status string `json:"status"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &v)
	return v.Status
}

func logCount(t *testing.T, f *fixture, routeID, kind string) int {
	t.Helper()
	var n int
	if err := f.sp.P.QueryRow(context.Background(), `SELECT count(*) FROM comm_log WHERE route_id = $1::bigint AND kind = $2`, routeID, kind).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPOSTRaw(t *testing.T) {
	f := setup(t, "kitp_test_mailin_raw")
	r := f.route(t, mailin.PurposePOST, mailin.ProviderRaw, nil, "")
	h := f.handler(0)
	path := mailin.InboundPathPrefix + r.Token

	rr := post(h, path, "message/rfc822", mailText("<r1@example.com>", "Ada <ada@example.com>", "Hi"), "203.0.113.5:4000")
	if rr.Code != 200 || statusOf(t, rr) != comm.OutcomeThread {
		t.Fatalf("raw: %d %s", rr.Code, rr.Body.String())
	}
	if rr := post(h, path, "message/rfc822", mailText("<r1@example.com>", "Ada <ada@example.com>", "Hi"), "203.0.113.5:4000"); rr.Code != 200 || statusOf(t, rr) != comm.OutcomeDuplicate {
		t.Errorf("the same message again: %d %s", rr.Code, rr.Body.String())
	}
	if logCount(t, f, fmt.Sprint(r.ID), "received") != 1 || logCount(t, f, fmt.Sprint(r.ID), "duplicate") != 1 {
		t.Error("the route's log should show one received and one duplicate")
	}
	var routes mailin.RouteListOutput
	decode(t, dispatch(t, f, "comm_route", "list", map[string]any{"channel_id": fmt.Sprint(f.channelID)}), &routes)
	if len(routes.Routes) != 1 || routes.Routes[0].LastUsedAt == "" || routes.Routes[0].LastClient != "203.0.113.5" || routes.Routes[0].Hint != r.Token[:6] {
		t.Errorf("route row = %+v", routes.Routes)
	}
	if strings.Contains(fmt.Sprint(routes), r.Token) {
		t.Error("the list shows the token")
	}

	if rr := post(h, mailin.InboundPathPrefix+strings.Repeat("0", 40), "message/rfc822", mailText("<x@e.com>", "a@b.com", "x"), ""); rr.Code != 404 {
		t.Errorf("unknown token: %d", rr.Code)
	}
	if rr := post(h, path, "message/rfc822", []byte("   "), ""); rr.Code != 403 {
		t.Errorf("empty body: %d", rr.Code)
	}
	if rr := post(h, path, "message/rfc822", []byte("\x00\x01garbage"), ""); rr.Code != 200 || statusOf(t, rr) != "unparseable" {
		t.Errorf("garbage: %d %s", rr.Code, rr.Body.String())
	}

	small := f.handler(64)
	if rr := post(small, path, "message/rfc822", mailText("<big@example.com>", "a@b.com", strings.Repeat("x", 200)), ""); rr.Code != 413 {
		t.Errorf("over the cap: %d", rr.Code)
	}

	if err := comm.MarkChannelFault(context.Background(), f.sp, f.channelID, "test"); err != nil {
		t.Fatal(err)
	}
	if rr := post(h, path, "message/rfc822", mailText("<paused@example.com>", "a@b.com", "x"), ""); rr.Code != 503 {
		t.Errorf("paused account: %d", rr.Code)
	}
}

func TestPOSTFilters(t *testing.T) {
	f := setup(t, "kitp_test_mailin_filters")
	h := f.handler(0)
	src := f.route(t, mailin.PurposePOST, mailin.ProviderRaw, map[string]any{"sources": []string{"198.51.100.0/24"}}, "")
	if rr := post(h, mailin.InboundPathPrefix+src.Token, "message/rfc822", mailText("<s1@e.com>", "a@b.com", "x"), "203.0.113.5:1"); rr.Code != 403 {
		t.Errorf("outside the sources: %d", rr.Code)
	}
	// Behind a trusted proxy the forwarded address is the client.
	if rr := post(h, mailin.InboundPathPrefix+src.Token, "message/rfc822", mailText("<s2@e.com>", "a@b.com", "x"), "10.0.0.2:1", "X-Forwarded-For", "198.51.100.7"); rr.Code != 200 {
		t.Errorf("an allowed source behind a proxy: %d %s", rr.Code, rr.Body.String())
	}
	if logCount(t, f, fmt.Sprint(src.ID), "inbound_refused") != 1 {
		t.Error("the refusal isn't in the route's log")
	}
	var routes mailin.RouteListOutput
	decode(t, dispatch(t, f, "comm_route", "list", map[string]any{"channel_id": fmt.Sprint(f.channelID)}), &routes)
	for _, r := range routes.Routes {
		if r.ID == src.ID && !strings.HasPrefix(r.LastError, "sources:") {
			t.Errorf("last_error = %q", r.LastError)
		}
	}

	from := f.route(t, mailin.PurposePOST, mailin.ProviderRaw, map[string]any{"header_from": []string{"example.org", "boss@example.net"}}, "")
	for _, c := range []struct {
		from string
		code int
	}{{"Ann <ann@example.org>", 200}, {"boss@example.net", 200}, {"ann@sub.example.org", 403}, {"eve@evil.example", 403}} {
		if rr := post(h, mailin.InboundPathPrefix+from.Token, "message/rfc822", mailText("<hf-"+c.from+"@e.com>", c.from, "x"), ""); rr.Code != c.code {
			t.Errorf("header From %s: %d, want %d", c.from, rr.Code, c.code)
		}
	}
}

func TestPOSTMailgunAndPostmark(t *testing.T) {
	f := setup(t, "kitp_test_mailin_providers")
	h := f.handler(0)
	const key = "key-test-signing"
	mg := f.route(t, mailin.PurposePOST, mailin.ProviderMailgun, nil, key)
	form := func(ts, token, sig string) (string, []byte) {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		for k, v := range map[string]string{"timestamp": ts, "token": token, "signature": sig, "body-mime": string(mailText("<mg-"+token+"@e.com>", "a@b.com", "Mailgun"))} {
			_ = mw.WriteField(k, v)
		}
		_ = mw.Close()
		return mw.FormDataContentType(), buf.Bytes()
	}
	sign := func(ts, token string) string {
		m := hmac.New(sha256.New, []byte(key))
		m.Write([]byte(ts + token))
		return hex.EncodeToString(m.Sum(nil))
	}
	ts := fmt.Sprint(time.Now().Unix())
	ct, body := form(ts, "tok1", sign(ts, "tok1"))
	if rr := post(h, mailin.InboundPathPrefix+mg.Token+"/mime", ct, body, ""); rr.Code != 200 {
		t.Errorf("signed Mailgun post: %d %s", rr.Code, rr.Body.String())
	}
	if rr := post(h, mailin.InboundPathPrefix+mg.Token+"/mime", ct, body, ""); rr.Code != 406 {
		t.Errorf("a replayed Mailgun post: %d", rr.Code)
	}
	ct, body = form(ts, "tok2", "00ff")
	if rr := post(h, mailin.InboundPathPrefix+mg.Token+"/mime", ct, body, ""); rr.Code != 406 {
		t.Errorf("a bad signature: %d", rr.Code)
	}
	old := fmt.Sprint(time.Now().Add(-time.Hour).Unix())
	ct, body = form(old, "tok3", sign(old, "tok3"))
	if rr := post(h, mailin.InboundPathPrefix+mg.Token+"/mime", ct, body, ""); rr.Code != 406 {
		t.Errorf("an hour-old timestamp: %d", rr.Code)
	}
	if r := dispatch(t, f, "comm_route", "create", map[string]any{"channel_id": fmt.Sprint(f.channelID), "purpose": "inbound_post", "provider": "mailgun"}); r.OK {
		t.Error("a Mailgun route without a signing key")
	}

	pm := f.route(t, mailin.PurposePOST, mailin.ProviderPostmark, nil, "")
	js, _ := json.Marshal(map[string]any{"From": "a@b.com", "RawEmail": string(mailText("<pm@e.com>", "a@b.com", "Postmark"))})
	if rr := post(h, mailin.InboundPathPrefix+pm.Token, "application/json", js, ""); rr.Code != 200 {
		t.Errorf("Postmark: %d %s", rr.Code, rr.Body.String())
	}
	js, _ = json.Marshal(map[string]any{"From": "a@b.com", "TextBody": "no raw"})
	if rr := post(h, mailin.InboundPathPrefix+pm.Token, "application/json", js, ""); rr.Code != 403 || !strings.Contains(rr.Body.String(), "Include raw email") {
		t.Errorf("Postmark without RawEmail: %d %s", rr.Code, rr.Body.String())
	}
}

func TestPOSTDKIM(t *testing.T) {
	f := setup(t, "kitp_test_mailin_dkim")
	h := f.handler(0)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	restore := mailin.SetLookupTXTForTest(func(domain string) ([]string, error) {
		if domain == "k1._domainkey.example.com" {
			return []string{"v=DKIM1; k=ed25519; p=" + base64.StdEncoding.EncodeToString(pub)}, nil
		}
		return nil, fmt.Errorf("no record for %s", domain)
	})
	defer restore()
	signed := func(id string) []byte {
		var out bytes.Buffer
		if err := dkim.Sign(&out, bytes.NewReader(mailText(id, "ada@example.com", "Signed")), &dkim.SignOptions{Domain: "example.com", Selector: "k1", Signer: priv}); err != nil {
			t.Fatal(err)
		}
		return out.Bytes()
	}

	rec := f.route(t, mailin.PurposePOST, mailin.ProviderRaw, map[string]any{"dkim": map[string]any{"mode": "record"}}, "")
	if rr := post(h, mailin.InboundPathPrefix+rec.Token, "message/rfc822", mailText("<d1@e.com>", "a@b.com", "x"), ""); rr.Code != 200 {
		t.Errorf("record mode, unsigned: %d", rr.Code)
	}
	if logCount(t, f, fmt.Sprint(rec.ID), "dkim_result") != 1 {
		t.Error("record mode logs a dkim_result")
	}

	req := f.route(t, mailin.PurposePOST, mailin.ProviderRaw, map[string]any{"dkim": map[string]any{"mode": "require", "domains": []string{"example.com"}}}, "")
	if rr := post(h, mailin.InboundPathPrefix+req.Token, "message/rfc822", signed("<d2@e.com>"), ""); rr.Code != 200 {
		t.Errorf("require, signed by example.com: %d %s", rr.Code, rr.Body.String())
	}
	if rr := post(h, mailin.InboundPathPrefix+req.Token, "message/rfc822", mailText("<d3@e.com>", "a@b.com", "x"), ""); rr.Code != 403 {
		t.Errorf("require, unsigned: %d", rr.Code)
	}
	other := f.route(t, mailin.PurposePOST, mailin.ProviderRaw, map[string]any{"dkim": map[string]any{"mode": "require", "domains": []string{"example.net"}, "on_fail": "file"}}, "")
	if rr := post(h, mailin.InboundPathPrefix+other.Token, "message/rfc822", signed("<d4@e.com>"), ""); rr.Code != 200 {
		t.Errorf("require another domain, on_fail file: %d", rr.Code)
	}
	if logCount(t, f, fmt.Sprint(other.ID), "dkim_failed") != 1 {
		t.Error("on_fail file logs dkim_failed")
	}
}

func TestPOSTRateLimitsGuessing(t *testing.T) {
	f := setup(t, "kitp_test_mailin_rate")
	h := f.handler(0)
	got429 := false
	for i := 0; i < 40; i++ {
		rr := post(h, mailin.InboundPathPrefix+fmt.Sprintf("%040d", i), "message/rfc822", []byte("x"), "203.0.113.9:1")
		if rr.Code == 429 {
			got429 = true
			break
		}
	}
	if !got429 {
		t.Error("forty bad tokens from one source should be throttled")
	}
	snap := f.status.Snapshot()
	if len(snap.Throttled) != 1 || snap.Throttled[0] != "203.0.113.9" || len(snap.RecentRefusals) == 0 {
		t.Errorf("status = throttled %v, %d refusals", snap.Throttled, len(snap.RecentRefusals))
	}
}

func TestRouteAdmin(t *testing.T) {
	f := setup(t, "kitp_test_mailin_routes")
	for _, bad := range []map[string]any{
		{"sources": []string{"not-a-cidr"}},
		{"header_from": []string{"no spaces allowed.com x"}},
		{"dkim": map[string]any{"mode": "maybe"}},
	} {
		if r := dispatch(t, f, "comm_route", "create", map[string]any{"channel_id": fmt.Sprint(f.channelID), "purpose": "inbound_smtp", "policy": bad}); r.OK {
			t.Errorf("policy %v accepted", bad)
		}
	}
	r := f.route(t, mailin.PurposeSMTP, "", map[string]any{"sources": []string{"40.92.0.0/15"}, "header_from": []string{"@Example.COM"}}, "")
	var routes mailin.RouteListOutput
	decode(t, dispatch(t, f, "comm_route", "list", map[string]any{"channel_id": fmt.Sprint(f.channelID)}), &routes)
	if len(routes.Routes) != 1 || fmt.Sprint(routes.Routes[0].Policy.HeaderFrom) != "[example.com]" {
		t.Errorf("normalised policy = %+v", routes.Routes)
	}
	if res := dispatch(t, f, "comm_route", "update", map[string]any{"id": fmt.Sprint(r.ID), "comment": "Exchange forward"}); !res.OK {
		t.Errorf("update: %+v", res.Error)
	}
	if res := dispatch(t, f, "comm_route", "delete", map[string]any{"id": fmt.Sprint(r.ID)}); !res.OK {
		t.Errorf("delete: %+v", res.Error)
	}
	if res := dispatch(t, f, "comm_route", "delete", map[string]any{"id": fmt.Sprint(r.ID)}); res.OK {
		t.Error("deleting twice")
	}
}
