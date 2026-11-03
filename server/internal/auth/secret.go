package auth

import (
	"crypto/sha256"
	"encoding/hex"
)

// HashSecret is how a bearer secret (a session cookie, a user token) is
// stored: the hex SHA-256 of its text. session.id and user_token.id hold
// the hash, never the secret, so a read of those tables (a backup, a
// replica, a SQL console) can't be replayed as a login (review B10). The
// secrets are 256 random bits, so a plain hash is enough — there is
// nothing to guess.
//
// SQL spells the same thing encode(sha256(convert_to(x, 'UTF8')), 'hex')
// (user_token_create_batch, migration 0021).
func HashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}
