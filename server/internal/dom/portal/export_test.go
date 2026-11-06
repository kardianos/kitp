package portal

import "context"

// MarkAttemptForTest counts a build try for portalID as RunOnce does before
// it builds.
func (b *Builder) MarkAttemptForTest(ctx context.Context, portalID int64) error {
	return b.markAttempt(ctx, portalID)
}

// LockPortalForTest takes the portal's build lock as RunOnce does.
func (b *Builder) LockPortalForTest(ctx context.Context, portalID int64) (release func(), ok bool, err error) {
	return b.lockPortal(ctx, portalID)
}

// SetPortalUnlockSQLForTest swaps the statement that releases the build
// lock; the returned func puts it back.
func SetPortalUnlockSQLForTest(sql string) func() {
	old := portalUnlockSQL
	portalUnlockSQL = sql
	return func() { portalUnlockSQL = old }
}
