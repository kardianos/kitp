package comm_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
)

// ---- shared helpers ----

// seedAttachment inserts a CAS blob + file + attachment on cardID and
// returns the new attachment id along with the digest so callers can
// later build inbound MIME parts whose bytes hash to the same value.
// Mirrors the on-the-wire flow the file.create handler runs through.
func seedAttachment(t *testing.T, f *fixture, cardID int64, filename, mimeType string, body []byte) (attachmentID int64, digest string) {
	t.Helper()
	sum := sha256.Sum256(body)
	digest = hex.EncodeToString(sum[:])
	ctx := context.Background()
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO cas_blob (address, size_bytes, mime_type, storage_kind)
		VALUES ($1, $2, $3, 'pg')
		ON CONFLICT (address) DO NOTHING
	`, digest, int64(len(body)), mimeType); err != nil {
		t.Fatalf("cas_blob: %v", err)
	}
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO cas_blob_data (address, data)
		VALUES ($1, $2)
		ON CONFLICT (address) DO NOTHING
	`, digest, body); err != nil {
		t.Fatalf("cas_blob_data: %v", err)
	}
	var fileID int64
	if err := f.sp.P.QueryRow(ctx, `
		INSERT INTO file (filename, size_bytes, mime_type, created_by, sha256)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id
	`, filename, int64(len(body)), mimeType, f.adminID, digest).Scan(&fileID); err != nil {
		t.Fatalf("file: %v", err)
	}
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO file_chunk (file_id, seq, cas_address, chunk_size)
		VALUES ($1, 0, $2, $3)
	`, fileID, digest, int64(len(body))); err != nil {
		t.Fatalf("file_chunk: %v", err)
	}
	if err := f.sp.P.QueryRow(ctx, `
		INSERT INTO attachment (card_id, file_id) VALUES ($1, $2) RETURNING id
	`, cardID, fileID).Scan(&attachmentID); err != nil {
		t.Fatalf("attachment: %v", err)
	}
	return attachmentID, digest
}

// linkReplyAttachment inserts a reply_body_attachment row joining the
// reply to a pre-existing attachment so the SMTP loader can find it.
// Mirrors what reply.post does when AttachmentIDs is non-empty.
func linkReplyAttachment(t *testing.T, f *fixture, replyID, attachmentID int64) {
	t.Helper()
	if _, err := f.sp.P.Exec(context.Background(), `
		INSERT INTO reply_body_attachment (reply_body_id, attachment_id)
		VALUES ($1, $2)
		ON CONFLICT DO NOTHING
	`, replyID, attachmentID); err != nil {
		t.Fatalf("reply_body_attachment: %v", err)
	}
}

// attachmentCount returns the number of live attachment rows on
// cardID. Drives round-trip dedup assertions.
func attachmentCount(t *testing.T, f *fixture, cardID int64) int {
	t.Helper()
	var n int
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT count(*) FROM attachment WHERE card_id = $1 AND deleted_at IS NULL
	`, cardID).Scan(&n); err != nil {
		t.Fatalf("attachmentCount: %v", err)
	}
	return n
}

// replyAttachmentIDs returns the attachment ids linked to replyID via
// reply_body_attachment, sorted for deterministic comparison.
func replyAttachmentIDs(t *testing.T, f *fixture, replyID int64) []int64 {
	t.Helper()
	rows, err := f.sp.P.Query(context.Background(), `
		SELECT attachment_id FROM reply_body_attachment
		WHERE reply_body_id = $1 ORDER BY attachment_id
	`, replyID)
	if err != nil {
		t.Fatalf("replyAttachmentIDs: %v", err)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, id)
	}
	return out
}

// ---- SMTP outbound ----

// TestSMTPSenderAttachesFiles drives one full send cycle and asserts
// the recorded MIME envelope is multipart/mixed and contains the
// attachment bytes (base64-decoded back to the original payload).
func TestSMTPSenderAttachesFiles(t *testing.T) {
	f := setupAdmin(t, "kitp_test_smtp_attaches")
	channelID, replyID := seedPendingReply(t, f, "kitp@example.com")
	payload := []byte("hello world from kitp\n")
	attID, _ := seedAttachment(t, f, f.taskID, "greeting.txt", "text/plain", payload)
	linkReplyAttachment(t, f, replyID, attID)

	s := comm.NewSMTPSenderForTest(f.sp, channelID, 5*time.Second)
	rt := &recordingTransport{}
	s.SetTransport(rt.fn)
	if err := s.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(rt.calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(rt.calls))
	}
	msg := rt.calls[0].msg
	// Header sanity.
	if !bytes.Contains(msg, []byte("Content-Type: multipart/mixed;")) {
		t.Fatalf("expected multipart/mixed Content-Type; got:\n%s", msg)
	}
	if !bytes.Contains(msg, []byte("greeting.txt")) {
		t.Fatalf("expected attachment filename in MIME; got:\n%s", msg)
	}

	// Parse the multipart and verify the attachment part decodes back
	// to the original bytes.
	hdrEnd := bytes.Index(msg, []byte("\r\n\r\n"))
	if hdrEnd < 0 {
		t.Fatalf("no header/body separator")
	}
	headerBlock := string(msg[:hdrEnd])
	bodyBytes := msg[hdrEnd+4:]
	var ctype string
	for _, line := range strings.Split(headerBlock, "\r\n") {
		if strings.HasPrefix(strings.ToLower(line), "content-type:") {
			ctype = strings.TrimSpace(line[len("Content-Type:"):])
		}
	}
	mt, params, err := mime.ParseMediaType(ctype)
	if err != nil {
		t.Fatalf("parse ctype %q: %v", ctype, err)
	}
	if mt != "multipart/mixed" {
		t.Fatalf("ctype: got %q, want multipart/mixed", mt)
	}
	mr := multipart.NewReader(bytes.NewReader(bodyBytes), params["boundary"])
	var foundAttachment bool
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("NextPart: %v", err)
		}
		disp := strings.ToLower(p.Header.Get("Content-Disposition"))
		if !strings.HasPrefix(disp, "attachment") {
			io.Copy(io.Discard, p)
			continue
		}
		raw, _ := io.ReadAll(p)
		clean := strings.Map(func(r rune) rune {
			if r == '\r' || r == '\n' || r == ' ' || r == '\t' {
				return -1
			}
			return r
		}, string(raw))
		decoded, err := base64.StdEncoding.DecodeString(clean)
		if err != nil {
			t.Fatalf("decode b64: %v (raw=%q)", err, raw)
		}
		if !bytes.Equal(decoded, payload) {
			t.Fatalf("decoded attachment mismatch: got %q want %q", decoded, payload)
		}
		foundAttachment = true
	}
	if !foundAttachment {
		t.Fatalf("no attachment part found in MIME:\n%s", msg)
	}
}

// ---- IMAP inbound dedup ----

// buildInboundMessage assembles a synthetic InboundMessage with a
// pre-decoded attachment payload. Avoids the raw-RFC822 parse step
// (already exercised by other tests) so this test focuses on the
// ingest + dedup logic.
func makeInboundWithAttachment(threadID, from, body, filename, mimeType string, payload []byte) comm.InboundMessage {
	return comm.InboundMessage{
		UID:         101,
		MessageID:   "<inbound-1@client.com>",
		From:        from,
		To:          "kitp@example.com",
		Subject:     "Re: Bug report",
		ThreadIDHdr: threadID,
		Body:        body,
		Attachments: []comm.InboundAttachment{{
			Filename: filename,
			MimeType: mimeType,
			Bytes:    payload,
		}},
	}
}

// TestIMAPInboundDedupRoundTrip verifies that an inbound attachment
// whose bytes match an existing task attachment is recognised as a
// round-trip: no new attachment row, and the new reply links to the
// pre-existing one via reply_body_attachment.
func TestIMAPInboundDedupRoundTrip(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_dedup_roundtrip")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", 0)
	commID, threadID := seedCommForIMAP(t, f, channelID, "Bug report")

	payload := []byte("attachment bytes that go out and come back\n")
	originalAttID, _ := seedAttachment(t, f, f.taskID, "rt.bin", "application/octet-stream", payload)
	startCount := attachmentCount(t, f, f.taskID)
	if startCount != 1 {
		t.Fatalf("startCount: got %d, want 1", startCount)
	}

	stub := &stubIMAPClient{
		messages: []comm.InboundMessage{
			makeInboundWithAttachment(threadID, "alice@example.com",
				"Thanks, see attached.", "rt.bin", "application/octet-stream", payload),
		},
	}
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(ctx context.Context, _ comm.IMAPConfig) (comm.InboundClient, error) {
		return stub, nil
	})
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	if got := attachmentCount(t, f, f.taskID); got != 1 {
		t.Errorf("post-ingest attachment count: got %d, want 1 (round-trip recognised)", got)
	}

	// Locate the new reply and confirm it links to the original
	// attachment id — not a freshly-created duplicate. The comm's
	// `replies` attribute is a JSON array of bigint ids.
	var raw []byte
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT av.value
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'replies'
	`, commID).Scan(&raw); err != nil {
		t.Fatalf("read replies: %v", err)
	}
	var ids []json.Number
	if err := json.Unmarshal(raw, &ids); err != nil {
		t.Fatalf("decode replies: %v", err)
	}
	if len(ids) == 0 {
		t.Fatalf("no reply ids: %s", raw)
	}
	newReplyID, _ := ids[len(ids)-1].Int64()
	linked := replyAttachmentIDs(t, f, newReplyID)
	if len(linked) != 1 || linked[0] != originalAttID {
		t.Fatalf("reply links: got %v, want [%d] (existing attachment)", linked, originalAttID)
	}
}

// TestIMAPInboundNovelAttachment confirms a brand-new payload lands
// as a new file + attachment row (dedup query miss) and the reply
// links to it.
func TestIMAPInboundNovelAttachment(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_novel_attachment")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", 0)
	_, threadID := seedCommForIMAP(t, f, channelID, "Bug report")

	startCount := attachmentCount(t, f, f.taskID)
	novel := []byte("brand-new content never seen before " + fmt.Sprintf("%d", time.Now().UnixNano()))
	stub := &stubIMAPClient{
		messages: []comm.InboundMessage{
			makeInboundWithAttachment(threadID, "alice@example.com",
				"Here is something new.", "novel.txt", "text/plain", novel),
		},
	}
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(ctx context.Context, _ comm.IMAPConfig) (comm.InboundClient, error) {
		return stub, nil
	})
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if got := attachmentCount(t, f, f.taskID); got != startCount+1 {
		t.Errorf("attachment count: got %d, want %d", got, startCount+1)
	}
}

// quiet unused-import nags when this file is built standalone.
var _ = textproto.MIMEHeader{}
var _ = api.SubRequest{}
