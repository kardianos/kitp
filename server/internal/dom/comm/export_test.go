package comm

import (
	"context"
	"time"
)

// ClaimForTest runs the sender's claim on one message (review 2026-11-03
// round 5 #3).
func ClaimForTest(ctx context.Context, s *SMTPSender, replyID int64) (bool, error) {
	_, ok, err := s.claim(ctx, replyID)
	return ok, err
}

// SetSendTimeoutForTest shortens one send's budget; the returned func
// restores it.
func SetSendTimeoutForTest(d time.Duration) func() {
	old := sendTimeout
	sendTimeout = d
	return func() { sendTimeout = old }
}

// SetFileFailureSetAsideAfterForTest shortens how long a message must keep
// failing to file before it is set aside; the returned func restores it.
func SetFileFailureSetAsideAfterForTest(d time.Duration) func() {
	old := fileFailureSetAsideAfter
	fileFailureSetAsideAfter = d
	return func() { fileFailureSetAsideAfter = old }
}

// SetPollBudgetForTest shortens how long one poll of p may run.
func (p *IMAPPoller) SetPollBudgetForTest(d time.Duration) { p.budget = d }
