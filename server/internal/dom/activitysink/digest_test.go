package activitysink

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/dom/comm"
)

// digestFixture: project 1, tasks 10 + 11, a comm 20 under task 10, two
// status value-cards and two actors.
var digestCards = map[int64]cardInfo{
	1:  {typeName: "project", title: "Alpha"},
	10: {typeName: "task", title: "Fix the login redirect loop that happens when the session cookie expires mid-flow"},
	11: {typeName: "task", title: "Write onboarding docs"},
	20: {typeName: "comm", title: "Billing question"},
	30: {typeName: "status", title: "Todo"},
	31: {typeName: "status", title: "Doing"},
	32: {typeName: "status", title: "Done"},
	40: {typeName: "screen", title: "Inbox"},
}

var digestActors = map[int64]string{1: "System", 7: "Alex Kim", 8: "Sam Lee"}

func row(id, cardID, subject, actor int64, kind, attr, vt, old, new string) scannedRow {
	r := scannedRow{
		ActivityRow: ActivityRow{ID: id, CardID: cardID, Kind: kind, AttributeName: attr, ActorID: actor},
		ValueType:   vt,
		SubjectID:   subject,
		CreatedAt:   time.Date(2026, 10, 5, 12, 0, int(id), 0, time.UTC),
	}
	if old != "" {
		r.ValueOld = []byte(old)
	}
	if new != "" {
		r.ValueNew = []byte(new)
	}
	return r
}

func TestGroupRows(t *testing.T) {
	comments := map[int64]string{500: "Looks good.\nShipping tomorrow."}
	cases := []struct {
		name      string
		rows      []scannedRow
		publicURL string
		want      []string // rendered "heading | url | line, line" per group
	}{
		{
			name: "repeated attribute changes roll up first-old to last-new",
			rows: []scannedRow{
				row(1, 10, 10, 7, "attr_update", "status", "card_ref", "30", "31"),
				row(2, 10, 10, 8, "attr_update", "status", "card_ref", "31", "32"),
			},
			want: []string{"#10 Fix the login redirect loop that happens when the session… |  | Status: Todo → Done (2 changes)  — Alex Kim, Sam Lee"},
		},
		{
			name: "groups by task in first-seen order; comm activity lands under its task",
			rows: []scannedRow{
				row(1, 11, 11, 7, "card_create", "", "", "", ""),
				row(2, 20, 10, 8, "attr_update", "comm_status", "card_ref", "30", "31"),
				row(3, 11, 11, 7, "comment", "", "", "", `{"comment_body_id": 500}`),
			},
			publicURL: "https://kitp.example.com",
			want: []string{
				"#11 Write onboarding docs | https://kitp.example.com/task/11 | Created  — Alex Kim, Comment  — Alex Kim",
				"#10 Fix the login redirect loop that happens when the session… | https://kitp.example.com/task/10 | Comm “Billing question”: Comm status: Todo → Doing  — Sam Lee",
			},
		},
		{
			name: "non-task subjects are type-labelled and never linked",
			rows: []scannedRow{
				row(1, 40, 40, 7, "attr_update", "hotkey", "text", `"i"`, `"x"`),
			},
			publicURL: "https://kitp.example.com",
			want:      []string{"Screen #40 Inbox |  | Hotkey: i → x  — Alex Kim"},
		},
		{
			name: "unset values render as a dash; lifecycle kinds get labels",
			rows: []scannedRow{
				row(1, 11, 11, 7, "attr_update", "milestone_ref", "card_ref", "", "30"),
				row(2, 11, 11, 7, "attachment_create", "", "", "", `{"attachment_id":"9","file_id":"3","filename":"spec.pdf"}`),
				row(3, 11, 11, 1, "card_delete", "", "", "", ""),
			},
			want: []string{"#11 Write onboarding docs |  | Milestone: — → Todo  — Alex Kim, Attached “spec.pdf”  — Alex Kim, Deleted  — System"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			groups := groupRows(c.rows, digestCards, digestActors, comments, c.publicURL)
			var got []string
			for _, g := range groups {
				lines := make([]string, 0, len(g.Lines))
				for _, ln := range g.Lines {
					lines = append(lines, ln.text())
				}
				got = append(got, groupHeading(g)+" | "+g.URL+" | "+strings.Join(lines, ", "))
			}
			if strings.Join(got, "\n") != strings.Join(c.want, "\n") {
				t.Errorf("groups:\n got: %q\nwant: %q", got, c.want)
			}
		})
	}
}

func TestDigestTextAndSubject(t *testing.T) {
	comments := map[int64]string{500: "Looks good.\nShipping tomorrow."}
	rows := []scannedRow{
		row(1, 10, 10, 7, "attr_update", "status", "card_ref", "30", "31"),
		row(2, 10, 10, 8, "comment", "", "", "", `{"comment_body_id": 500}`),
	}
	d := Digest{
		ProjectName: "Alpha",
		UnitName:    "Assigned to me",
		Personal:    true,
		PublicURL:   "https://kitp.example.com",
		EventCount:  len(rows),
		Groups:      groupRows(rows, digestCards, digestActors, comments, "https://kitp.example.com"),
	}
	if got, want := d.Subject(), "[Alpha] #10 Fix the login redirect loop that happens when the session…"; got != want {
		t.Errorf("single-task subject = %q, want %q", got, want)
	}
	text := d.Text()
	for _, want := range []string{
		"Alpha — 2 updates on 1 task\n",
		"\n#10 Fix the login redirect loop that happens when the session…\nhttps://kitp.example.com/task/10\n",
		"  - Status: Todo → Doing  — Alex Kim\n",
		"  - Comment  — Sam Lee\n      Looks good.\n      Shipping tomorrow.\n",
		`notification subscription “Assigned to me” in Alpha.`,
		"Manage your notifications: https://kitp.example.com/account\n",
		"Replies to this email are not read.\n",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("text missing %q:\n%s", want, text)
		}
	}

	d.Groups = append(d.Groups, DigestGroup{CardID: 11, CardType: "task", Title: "Write onboarding docs"})
	d.EventCount = 3
	if got, want := d.Subject(), "[Alpha] 3 updates on 2 tasks"; got != want {
		t.Errorf("multi-task subject = %q, want %q", got, want)
	}
	html := d.HTML()
	if !strings.Contains(html, `<a href="https://kitp.example.com/task/10">#10 Fix`) {
		t.Errorf("HTML missing linked task heading:\n%s", html)
	}
	if !strings.Contains(html, "Looks good.<br>Shipping tomorrow.") {
		t.Errorf("HTML missing comment body:\n%s", html)
	}
}

func TestDisplayValue(t *testing.T) {
	cases := []struct {
		vt, raw, want string
	}{
		{"card_ref", `30`, "Todo"},
		{"card_ref", `"31"`, "Doing"},
		{"card_ref[]", `[30, 32]`, "Todo, Done"},
		{"card_ref[]", `[]`, "—"},
		{"card_ref", `999`, "#999"},
		{"text", `"line one\nline two"`, "line one line two"},
		{"text", `""`, "—"},
		{"bool", `true`, "yes"},
		{"number", `2.5`, "2.5"},
		{"date", `"2026-10-05"`, "2026-10-05"},
		{"text", ``, "—"},
		{"text", `null`, "—"},
	}
	for _, c := range cases {
		if got := displayValue(c.vt, []byte(c.raw), digestCards); got != c.want {
			t.Errorf("displayValue(%s, %s) = %q, want %q", c.vt, c.raw, got, c.want)
		}
	}
}

func TestParseCardFilter(t *testing.T) {
	cases := []struct {
		name   string
		raw    string
		person int64
		wantOK bool
		want   string // re-marshalled node
	}{
		{"empty", "", 5, false, ""},
		{"empty object", "{}", 5, false, ""},
		{"leaf with @me", `{"attr":"assignee","op":"=","values":["@me"]}`, 5, true,
			`{"attr":"assignee","op":"=","values":[5]}`},
		{"group keeps @me without a subscriber", `{"connective":"and","children":[{"attr":"assignee","op":"=","values":["@me"]}]}`, 0, true,
			`{"connective":"and","children":[{"attr":"assignee","op":"=","values":["@me"]}]}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			n, ok, err := parseCardFilter(c.raw, c.person)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if ok != c.wantOK {
				t.Fatalf("ok = %v, want %v", ok, c.wantOK)
			}
			if !ok {
				return
			}
			buf, err := json.Marshal(n)
			if err != nil {
				t.Fatal(err)
			}
			if string(buf) != c.want {
				t.Errorf("node = %s, want %s", buf, c.want)
			}
		})
	}
	if _, _, err := parseCardFilter(`{not json`, 1); err == nil {
		t.Error("expected an error for invalid JSON")
	}
}

func TestBuildNotificationMIME(t *testing.T) {
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	msg := string(buildNotificationMIME("Kitp <notify@example.com>", "sam@example.com",
		"[Alpha] #10 Héllo\r\nBcc: evil@example.com", "Line one\nLine two\n", 77, now))
	head, body, ok := strings.Cut(msg, "\r\n\r\n")
	if !ok {
		t.Fatalf("no header/body separator:\n%s", msg)
	}
	if strings.Contains(head, "\r\nBcc:") {
		t.Errorf("subject CRLF injected a header:\n%s", head)
	}
	for _, want := range []string{
		"From: Kitp <notify@example.com>\r\n",
		"To: sam@example.com\r\n",
		"Subject: =?utf-8?q?",
		"Message-ID: <kitp-notify.77.",
		"@example.com>\r\n",
		"X-Kitp-Notification: 77\r\n",
		"Auto-Submitted: auto-generated\r\n",
		"Content-Transfer-Encoding: quoted-printable\r\n",
	} {
		if !strings.Contains(head+"\r\n", want) {
			t.Errorf("headers missing %q:\n%s", want, head)
		}
	}
	if body != "Line one\r\nLine two\r\n" {
		t.Errorf("body = %q", body)
	}

	// A reply quoting our Message-ID is recognised by the IMAP side.
	var msgID string
	for _, l := range strings.Split(head, "\r\n") {
		if v, ok := strings.CutPrefix(l, "Message-ID: "); ok {
			msgID = v
		}
	}
	if !comm.IsNotificationReply(comm.InboundMessage{InReplyTo: msgID}) {
		t.Errorf("IsNotificationReply did not recognise In-Reply-To %q", msgID)
	}
}
