package portal

import "context"

// MarkAttemptForTest counts a build try for portalID as RunOnce does before
// it builds.
func (b *Builder) MarkAttemptForTest(ctx context.Context, portalID int64) error {
	return b.markAttempt(ctx, portalID)
}
