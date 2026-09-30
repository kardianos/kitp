package attachment

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/file"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
	"github.com/kitp/kitp/server/internal/textnorm"
)

// uploadChunkBytes is the slice size the signed upload route cuts the
// request body into before storing each piece in CAS. Matches the web
// client's FALLBACK_CHUNK_BYTES (web/src/task-detail/upload.ts) so the
// same file uploaded through either path yields the same chunk
// addresses and dedupes.
const uploadChunkBytes = 1 << 20

// defaultUploadMaxBytes backs Config.MaxUploadBytes when unset; matches
// the ATTACHMENT_MAX_MB default main wires in.
const defaultUploadMaxBytes = 250 << 20

// UploadURLInput requests a signed one-shot upload link for a card.
//
// A custom UnmarshalJSON runs textnorm.Filename on the filename (as
// file.CreateInput does) so the name the link signs is exactly the one
// file.create will store — an upload can't fail late on a name the
// mint accepted.
type UploadURLInput struct {
	CardID   int64  `json:"card_id,string" mcp:"required,desc=card (task or project) to attach the uploaded file to"`
	Filename string `json:"filename" mcp:"required,desc=display filename including its extension, e.g. report.pdf"`
	MimeType string `json:"mime_type,omitempty" mcp:"desc=MIME type, e.g. application/pdf; defaults to application/octet-stream"`
}

// uploadURLInputWire mirrors UploadURLInput without the custom
// UnmarshalJSON so decoding doesn't recurse.
type uploadURLInputWire struct {
	CardID   int64  `json:"card_id,string"`
	Filename string `json:"filename"`
	MimeType string `json:"mime_type,omitempty"`
}

// UnmarshalJSON normalises Filename via textnorm.Filename. A bad name
// surfaces as a JSON unmarshal error (the dispatcher's `bad_input`).
func (in *UploadURLInput) UnmarshalJSON(b []byte) error {
	var w uploadURLInputWire
	if err := json.Unmarshal(b, &w); err != nil {
		return err
	}
	clean, err := textnorm.Filename(w.Filename)
	if err != nil {
		return err
	}
	*in = UploadURLInput{CardID: w.CardID, Filename: clean, MimeType: w.MimeType}
	return nil
}

// UploadURLOutput carries the signed upload link. card_id / filename /
// mime_type come from the SQL function; url + expires_at are stamped by
// the PostRun hook (signUploadURLs).
type UploadURLOutput struct {
	CardID    int64  `json:"card_id,string" mcp:"desc=card the uploaded file will attach to"`
	Filename  string `json:"filename" mcp:"desc=normalised filename the attachment will carry"`
	MimeType  string `json:"mime_type" mcp:"desc=MIME type the file will be stored with"`
	URL       string `json:"url" mcp:"desc=time-limited signed URL; PUT the raw file bytes to it with no auth header (e.g. curl -T ./report.pdf '<url>'); the response body is the created attachment row"`
	ExpiresAt string `json:"expires_at" mcp:"desc=ISO8601 UTC instant after which the link no longer accepts an upload"`
}

// cardTypeFromUploadURLInput resolves the target card's card_type so the
// dispatcher can scope-check the actor's card.update grant — the same
// gate attachment.create runs.
func cardTypeFromUploadURLInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(UploadURLInput).CardID)
}

// uploadGrant is what an upload link authorises: attach a file named
// Filename (stored as MimeType) to CardID, acting as ActorID — the user
// the dispatcher authorised when it minted the link.
type uploadGrant struct {
	CardID   int64
	ActorID  int64
	Filename string
	MimeType string
}

// signUploadPayload is the HMAC-SHA256 of the canonical upload message,
// base64url-encoded (no padding). The "upload|" prefix keeps it disjoint
// from download messages ("id|mode|exp" always starts with a digit), and
// %q-quoting the free-text fields keeps a '|' inside a filename from
// shifting bytes between fields.
func signUploadPayload(g uploadGrant, exp int64) string {
	mac := hmac.New(sha256.New, linkDeps.secret)
	fmt.Fprintf(mac, "upload|%d|%d|%q|%q|%d", g.CardID, g.ActorID, g.Filename, g.MimeType, exp)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// verifyUploadURL checks a presented grant + exp + sig against `now`
// (unix seconds). Same rejection surface as verifyDownloadURL.
func verifyUploadURL(g uploadGrant, exp int64, sig string, now int64) error {
	if len(linkDeps.secret) == 0 {
		return api.Internal(fmt.Errorf("attachment.upload_url: link secret not configured"))
	}
	return verifyLink("upload", signUploadPayload(g, exp), sig, exp, now)
}

// buildUploadURL assembles the absolute (or site-relative when no
// publicURL is configured) signed upload link.
func buildUploadURL(g uploadGrant, exp int64) string {
	q := url.Values{}
	q.Set("card_id", strconv.FormatInt(g.CardID, 10))
	q.Set("actor_id", strconv.FormatInt(g.ActorID, 10))
	q.Set("filename", g.Filename)
	q.Set("mime_type", g.MimeType)
	q.Set("exp", strconv.FormatInt(exp, 10))
	q.Set("sig", signUploadPayload(g, exp))
	return linkDeps.publicURL + "/api/v1/attachment/upload?" + q.Encode()
}

// signUploadURLs is the PostRun hook for attachment.upload_url. The SQL
// function has validated each input and echoed the normalised values;
// here we bind them to the calling actor + a fresh expiry and sign.
// Touches no DB — a failure (unconfigured secret, no actor) aborts the
// batch with a logged internal error.
func signUploadURLs(ctx context.Context, _ store.Querier, _ []any, outs []any) error {
	if len(linkDeps.secret) == 0 {
		return fmt.Errorf("link secret not configured (set KITP_LINK_SECRET)")
	}
	user, ok := auth.FromContext(ctx)
	if !ok || user == nil || user.ID == 0 {
		return fmt.Errorf("attachment.upload_url: no actor on context")
	}
	exp := time.Now().Add(linkTTL)
	for i := range outs {
		out, ok := outs[i].(UploadURLOutput)
		if !ok {
			continue
		}
		out.URL = buildUploadURL(uploadGrant{
			CardID:   out.CardID,
			ActorID:  user.ID,
			Filename: out.Filename,
			MimeType: out.MimeType,
		}, exp.Unix())
		out.ExpiresAt = exp.UTC().Format(time.RFC3339)
		outs[i] = out
	}
	return nil
}

// handleSignedUpload is the public, signature-gated upload route: the
// agent PUTs (or POSTs) raw file bytes to a link minted by
// attachment.upload_url. It verifies the signature before reading the
// body, cuts the body into CAS chunks, then runs file.create +
// attachment.create through the dispatcher AS the signed actor — so
// created_by, the attachment_create activity, thumbnails, and the
// dispatcher's own role + scope checks behave exactly as for a browser
// upload. Responds 201 with the attachment row.
func handleSignedUpload(ctx context.Context, w http.ResponseWriter, r *http.Request, cfg Config) error {
	q := r.URL.Query()
	cardID, err := strconv.ParseInt(q.Get("card_id"), 10, 64)
	if err != nil || cardID <= 0 {
		return api.BadRequest("validation", "invalid card_id")
	}
	actorID, err := strconv.ParseInt(q.Get("actor_id"), 10, 64)
	if err != nil || actorID <= 0 {
		return api.BadRequest("validation", "invalid actor_id")
	}
	exp, err := strconv.ParseInt(q.Get("exp"), 10, 64)
	if err != nil {
		return api.BadRequest("validation", "invalid exp")
	}
	g := uploadGrant{
		CardID:   cardID,
		ActorID:  actorID,
		Filename: q.Get("filename"),
		MimeType: q.Get("mime_type"),
	}
	if err := verifyUploadURL(g, exp, q.Get("sig"), time.Now().Unix()); err != nil {
		return err
	}
	if cfg.Dispatcher == nil || cfg.Storage == nil {
		return api.Internal(fmt.Errorf("attachment upload: dispatcher or storage not configured"))
	}
	ctx = auth.WithUser(ctx, &auth.UserCtx{ID: g.ActorID})

	chunks, err := storeUploadBody(ctx, w, r, cfg, g.MimeType)
	if err != nil {
		return err
	}
	var f file.CreateOutput
	if err := dispatchOne(ctx, cfg.Dispatcher, "file", "create", file.CreateInput{
		Filename: g.Filename,
		MimeType: g.MimeType,
		Chunks:   chunks,
	}, &f); err != nil {
		return err
	}
	var att CreateOutput
	if err := dispatchOne(ctx, cfg.Dispatcher, "attachment", "create", CreateInput{
		CardID: g.CardID,
		FileID: f.ID,
	}, &att); err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(att); err != nil {
		// Status + headers are already on the wire; returning err would
		// make writeErr attempt a second status. The attachment exists.
		return nil
	}
	return nil
}

// storeUploadBody streams the request body into CAS in uploadChunkBytes
// slices (peak memory is one slice) and returns the ordered chunk list
// for file.create. Bodies over cfg.MaxUploadBytes fail 413; chunks
// already stored by then are orphans the CAS reaper sweeps.
func storeUploadBody(ctx context.Context, w http.ResponseWriter, r *http.Request, cfg Config, mime string) ([]file.Chunk, error) {
	maxBytes := cfg.MaxUploadBytes
	if maxBytes <= 0 {
		maxBytes = defaultUploadMaxBytes
	}
	body := http.MaxBytesReader(w, r.Body, maxBytes)
	buf := make([]byte, uploadChunkBytes)
	var chunks []file.Chunk
	for {
		n, err := io.ReadFull(body, buf)
		if n > 0 {
			addr, perr := cfg.Storage.Put(ctx, mime, buf[:n])
			if perr != nil {
				return nil, api.Internal(fmt.Errorf("attachment upload: %w", perr))
			}
			chunks = append(chunks, file.Chunk{Address: addr, Size: int64(n)})
		}
		// EOF (empty body) and ErrUnexpectedEOF (short final slice) both
		// mean the body is drained.
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			break
		}
		if err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				return nil, &api.HTTPError{
					Status:  http.StatusRequestEntityTooLarge,
					Code:    "request_too_large",
					Message: fmt.Sprintf("file exceeds %d-byte limit", maxBytes),
				}
			}
			return nil, api.Internal(fmt.Errorf("attachment upload: read body: %w", err))
		}
	}
	if len(chunks) == 0 {
		return nil, api.BadRequest("empty_body", "upload body is empty")
	}
	return chunks, nil
}

// dispatchOne runs a single sub-request through the dispatcher (role,
// scope, timeout, tx — everything a batch call gets) and decodes its
// output into out. A handler rejection comes back as *reg.HandlerError,
// which the router renders with the dispatcher's own code + message.
func dispatchOne(ctx context.Context, srv *api.Server, endpoint, action string, in, out any) error {
	data, err := json.Marshal(in)
	if err != nil {
		return api.Internal(fmt.Errorf("%s.%s: marshal input: %w", endpoint, action, err))
	}
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "0", Endpoint: endpoint, Action: action, Data: data},
	}})
	if len(resp.Subresponses) != 1 {
		return api.Internal(fmt.Errorf("%s.%s: got %d subresponses", endpoint, action, len(resp.Subresponses)))
	}
	sr := resp.Subresponses[0]
	if !sr.OK {
		if sr.Error == nil {
			return api.Internal(fmt.Errorf("%s.%s: failed without an error envelope", endpoint, action))
		}
		return &reg.HandlerError{Code: sr.Error.Code, Message: sr.Error.Message}
	}
	raw, err := json.Marshal(sr.Data)
	if err != nil {
		return api.Internal(fmt.Errorf("%s.%s: marshal output: %w", endpoint, action, err))
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return api.Internal(fmt.Errorf("%s.%s: decode output: %w", endpoint, action, err))
	}
	return nil
}
