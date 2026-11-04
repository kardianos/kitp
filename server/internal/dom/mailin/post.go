package mailin

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/netx"
	"github.com/kitp/kitp/server/internal/obs/logpath"
	"github.com/kitp/kitp/server/internal/store"
)

// InboundPathPrefix is where providers POST mail. The rest of the path is
// the route's secret token, so it is kept out of logs (logpath).
const InboundPathPrefix = "/api/v1/comm/inbound/"

// DefaultPOSTMaxBytes caps a POST body (KITP_COMM_INBOUND_MAX_BYTES).
// Postmark's JSON carries attachments in base64, a third bigger than the
// message.
const DefaultPOSTMaxBytes = 50 << 20

// POSTConfig wires the POST intake routes.
type POSTConfig struct {
	Pool     *store.Pool
	Intake   *comm.Intake
	Trusted  *netx.Trusted
	Status   *Status
	MaxBytes int64
	Logger   *slog.Logger
}

type postServer struct {
	POSTConfig
	sources *netx.Limiter
	routes  *netx.Limiter
	seen    *replayCache
}

// MountPOST registers
//
//	POST /api/v1/comm/inbound/{token}
//	POST /api/v1/comm/inbound/{token}/mime   (Mailgun posts raw MIME only to a URL ending in "mime")
//
// on the app router. No session: the token is the credential. See
// docs/MAIL_INTAKE_AND_CALENDARS.md §6.
func MountPOST(rt *api.Router, cfg POSTConfig) {
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = DefaultPOSTMaxBytes
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	s := &postServer{
		POSTConfig: cfg,
		sources:    netx.NewLimiter(limits.PerSourcePerMinute, limits.PerSourceBurst, 100_000),
		routes:     netx.NewLimiter(limits.PerRoutePerMinute, limits.PerRoutePerMinute, 100_000),
		seen:       &replayCache{seen: map[string]time.Time{}},
	}
	cfg.Status.watch(s.sources)
	logpath.Mark(InboundPathPrefix)
	rt.Public("POST "+InboundPathPrefix+"{token}", s.handle)
	rt.Public("POST "+InboundPathPrefix+"{token}/mime", s.handle)
}

type postReply struct {
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

func reply(w http.ResponseWriter, code int, status, msg string) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	return json.NewEncoder(w).Encode(postReply{Status: status, Message: msg})
}

func (s *postServer) handle(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	client := netx.ClientIP(r, s.Trusted)
	src := netx.SourceKey(client)
	if !s.sources.Allow(src, 1) {
		s.Status.Refuse(comm.TransportPOST, client, "rate limited")
		w.Header().Set("Retry-After", "60")
		return reply(w, http.StatusTooManyRequests, "throttled", "too many requests; try again later")
	}
	rt, ok, err := lookupRoute(ctx, s.Pool, r.PathValue("token"), PurposePOST)
	if err != nil {
		return api.Internal(err)
	}
	if !ok {
		s.sources.Charge(src, float64(limits.MissCost))
		s.Status.Refuse(comm.TransportPOST, client, "unknown token")
		return reply(w, http.StatusNotFound, "not_found", "no such route")
	}
	if !s.routes.Allow(strconv.FormatInt(rt.ID, 10), 1) {
		w.Header().Set("Retry-After", "60")
		return reply(w, http.StatusTooManyRequests, "throttled", "too many messages on this route; try again later")
	}
	// A refusal answers a status the provider won't retry: Mailgun stops
	// on 406, Postmark on 403.
	refused := http.StatusForbidden
	if rt.Provider == ProviderMailgun {
		refused = http.StatusNotAcceptable
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.MaxBytes))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			if lerr := rt.refuse(ctx, s.Pool, comm.TransportPOST, "size", fmt.Sprintf("over %d bytes", s.MaxBytes), client); lerr != nil {
				s.Logger.Warn("inbound post: log refusal", "route_id", rt.ID, "err", lerr)
			}
			return reply(w, http.StatusRequestEntityTooLarge, "too_large", "message too large")
		}
		return reply(w, http.StatusBadRequest, "bad_request", "could not read the request body")
	}

	refuse := func(check, reason string) error {
		s.sources.Charge(src, float64(limits.MissCost))
		if err := rt.refuse(ctx, s.Pool, comm.TransportPOST, check, reason, client); err != nil {
			s.Logger.Warn("inbound post: log refusal", "route_id", rt.ID, "err", err)
		}
		return reply(w, refused, "refused", check+": "+reason)
	}
	if len(rt.Policy.Sources) > 0 && !netx.InPrefixes(client, rt.Policy.Sources) {
		return refuse("sources", client.String()+" is not an allowed source")
	}

	raw, replayToken, check, why := s.decode(rt, r, body)
	if check != "" {
		return refuse(check, why)
	}
	// A Mailgun request's token is spent when it's used, so a replay is
	// refused; but an answer that asks the provider to retry gives it back,
	// or the retry would be refused as a replay and the mail lost (review
	// 2026-11-03 #22).
	retryLater := func() {
		if replayToken != "" {
			s.seen.forget(replayToken)
		}
	}
	check, why, after := checkMessage(rt.Policy, raw)
	if check != "" {
		return refuse(check, why)
	}

	filed, err := s.Intake.FileRaw(ctx, rt.ChannelID, comm.TransportPOST, rt.ID, raw)
	switch {
	case errors.Is(err, comm.ErrChannelPaused):
		retryLater()
		w.Header().Set("Retry-After", "300")
		return reply(w, http.StatusServiceUnavailable, "paused", "the mail account is paused; try again later")
	case errors.Is(err, comm.ErrUnparseable):
		if terr := rt.touch(ctx, s.Pool, client); terr != nil {
			s.Logger.Warn("inbound post: touch route", "route_id", rt.ID, "err", terr)
		}
		return reply(w, http.StatusOK, "unparseable", "not mail; logged and dropped")
	case errors.Is(err, comm.ErrUnfileable):
		// A retry can't help: answered OK so the provider stops (logged
		// as file_error).
		if terr := rt.touch(ctx, s.Pool, client); terr != nil {
			s.Logger.Warn("inbound post: touch route", "route_id", rt.ID, "err", terr)
		}
		return reply(w, http.StatusOK, "unfileable", "can't be filed; logged and dropped")
	case err != nil:
		s.Logger.Error("inbound post: file", "route_id", rt.ID, "err", err)
		if nerr := rt.noteError(ctx, s.Pool, "filing failed; the provider will retry"); nerr != nil {
			s.Logger.Warn("inbound post: note error", "route_id", rt.ID, "err", nerr)
		}
		retryLater()
		w.Header().Set("Retry-After", "60")
		return reply(w, http.StatusServiceUnavailable, "retry", "could not file the message; try again later")
	}
	for _, row := range after {
		row.detail["card_id"] = filed.CardID
		if err := rt.logEvent(ctx, s.Pool, comm.TransportPOST, row.kind, row.detail); err != nil {
			s.Logger.Warn("inbound post: log", "route_id", rt.ID, "kind", row.kind, "err", err)
		}
	}
	if err := rt.touch(ctx, s.Pool, client); err != nil {
		s.Logger.Warn("inbound post: touch route", "route_id", rt.ID, "err", err)
	}
	status := filed.Outcome
	if filed.Duplicate {
		status = comm.OutcomeDuplicate
	}
	return reply(w, http.StatusOK, status, "")
}

// decode gets the raw RFC 5322 message out of a provider's request. A
// non-empty check names why it was refused. replayToken is the request's
// one-time token (Mailgun), now spent; "" for other providers.
func (s *postServer) decode(rt route, r *http.Request, body []byte) (raw []byte, replayToken, check, reason string) {
	switch rt.Provider {
	case ProviderRaw:
		if len(bytes.TrimSpace(body)) == 0 {
			return nil, "", "body", "empty request"
		}
		return body, "", "", ""
	case ProviderMailgun:
		return s.decodeMailgun(rt, r, body)
	case ProviderPostmark:
		var pm struct {
			RawEmail string `json:"RawEmail"`
		}
		if err := json.Unmarshal(body, &pm); err != nil {
			return nil, "", "body", "not Postmark's inbound JSON"
		}
		if pm.RawEmail == "" {
			return nil, "", "raw_email", "RawEmail is empty: turn on \"Include raw email content in JSON payload\" in the Postmark server's inbound settings"
		}
		return []byte(pm.RawEmail), "", "", ""
	}
	return nil, "", "provider", "unknown provider " + rt.Provider
}

// decodeMailgun reads a Mailgun route forward to a URL ending in "mime":
// multipart/form-data with the raw message in body-mime, signed with the
// account's HTTP webhook signing key.
func (s *postServer) decodeMailgun(rt route, r *http.Request, body []byte) (raw []byte, replayToken, check, reason string) {
	_, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || params["boundary"] == "" {
		return nil, "", "body", "not multipart/form-data (forward to the URL ending in /mime)"
	}
	form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(s.MaxBytes)
	if err != nil {
		return nil, "", "body", "unreadable form"
	}
	defer func() { _ = form.RemoveAll() }()
	get := func(k string) string {
		if v := form.Value[k]; len(v) > 0 {
			return v[0]
		}
		return ""
	}
	ts, token, sig := get("timestamp"), get("token"), get("signature")
	if !mailgunSigned(rt.SigningKey, ts, token, sig) {
		return nil, "", "signature", "the Mailgun signature doesn't match the signing key"
	}
	if t, err := strconv.ParseInt(ts, 10, 64); err != nil || absDur(time.Since(time.Unix(t, 0))) > 15*time.Minute {
		return nil, "", "signature", "the Mailgun timestamp is more than 15 minutes off"
	}
	if s.seen.replayed(token) {
		return nil, "", "signature", "this Mailgun request was already used"
	}
	mimeBody := get("body-mime")
	if mimeBody == "" {
		return nil, token, "body", "no body-mime field: the route must forward to the URL ending in /mime"
	}
	return []byte(mimeBody), token, "", ""
}

func mailgunSigned(key, ts, token, sig string) bool {
	if key == "" || ts == "" || token == "" || sig == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(ts + token))
	want := mac.Sum(nil)
	got, err := hex.DecodeString(strings.ToLower(sig))
	return err == nil && hmac.Equal(got, want)
}

func absDur(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

// replayCache remembers Mailgun request tokens for 15 minutes (memory only).
type replayCache struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

func (c *replayCache) replayed(token string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if len(c.seen) > 10_000 {
		for k, at := range c.seen {
			if now.Sub(at) > 15*time.Minute {
				delete(c.seen, k)
			}
		}
	}
	if at, ok := c.seen[token]; ok && now.Sub(at) <= 15*time.Minute {
		return true
	}
	c.seen[token] = now
	return false
}

// forget gives a token back: its request was answered with "try again".
func (c *replayCache) forget(token string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.seen, token)
}
