// Package cas provides content-addressable blob storage that fronts one or
// more pluggable backends.
//
// Domain tables (today: attachment) carry only the cas_blob.address. The
// Storage value walks its configured backends in order on read, and writes
// every Put through the head backend. Adding S3 later is a Backend
// implementation: append it to the list and existing rows keep resolving
// against the older 'pg' backend.
//
// All addresses are SHA-256 hex (lowercase). The hash is computed during
// Put — callers stream bytes in, the backend computes the hash on the fly,
// the returned address is what every consumer table stores.
package cas

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
)

// ErrNotFound is returned by Backend.Get / Storage.Get when the address is
// not known to any backend.
var ErrNotFound = errors.New("cas: address not found")

// Backend is the pluggable storage interface. Every implementation owns
// a single storage_kind label (e.g. 'pg', 's3') — Storage uses it to write
// the right cas_blob.storage_kind on Put.
type Backend interface {
	// Kind returns the storage_kind label written into cas_blob when this
	// backend stores the bytes (e.g. 'pg', 's3').
	Kind() string
	// Has reports whether this backend already holds the address. Used by
	// Storage on Put to skip duplicate writes when the bytes are already
	// somewhere down the chain.
	Has(ctx context.Context, address string) (bool, error)
	// Put stores the data under address. Implementations MUST be safe to
	// retry / safe against duplicate writes (the caller may race against
	// itself); ON CONFLICT DO NOTHING in the SQL backend, ETag in S3.
	//
	// `data` is the raw bytes (already buffered by the caller — typically
	// from a hashing reader that drained the request body). Passing a
	// slice instead of an io.Reader avoids a second in-memory copy on the
	// pg backend; future streaming backends (S3 multipart) can wrap the
	// slice in `bytes.NewReader` if they want streaming semantics.
	Put(ctx context.Context, address string, mimeType string, sizeBytes int64, data []byte) error
	// GetAll fetches every address in `addresses` (a single chunk list,
	// in order) and streams the bytes to `w` in the order supplied. One
	// round-trip total; chunks are written as they come off the wire so
	// peak memory is one chunk regardless of file size.
	//
	// Single-blob callers pass a one-element slice — there is no `Get`
	// shortcut by design (S8 of the security audit called out the
	// per-chunk N+1 the old per-blob API encouraged).
	//
	// If any requested address is not present in this backend, GetAll
	// MUST return ErrNotFound and SHOULD NOT have written anything to
	// `w`. After the first row is written the response is committed and
	// a mid-stream failure can only surface as a truncated stream + an
	// error return — log and bail at the call site.
	GetAll(ctx context.Context, addresses []string, w io.Writer) error
	// Delete removes the bytes (used by the reaper). Implementations must
	// be idempotent — deleting an absent address is a no-op.
	Delete(ctx context.Context, address string) error
}

// Storage is an ordered chain of backends. The first entry receives every
// Put; reads walk the chain until a backend reports the bytes.
type Storage struct {
	backends []Backend
}

// New builds a Storage from an ordered backend list. Order matters: the
// head is the write target and the first read fallback. Pass an empty
// list and Storage returns ErrNotFound on every read (used in tests).
func New(backends ...Backend) *Storage {
	return &Storage{backends: backends}
}

// Backends returns the configured backends in order. Read-only; callers
// MUST NOT mutate the returned slice.
func (s *Storage) Backends() []Backend {
	return s.backends
}

// AddressOf returns the SHA-256 hex of data.
func AddressOf(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// GetAll fetches every address in `addresses` and streams the bytes
// to `w` in the order supplied. The chain walks backends in order;
// on ErrNotFound it falls through to the next backend, on any other
// error it short-circuits. v1 has one backend ('pg') so addresses
// must all live there; a future multi-backend setup will need to
// group `addresses` by `cas_blob.storage_kind` before dispatch
// (otherwise a backend will see addresses it doesn't own and return
// ErrNotFound for them).
//
// Returns ErrNotFound only when no backend successfully served the
// addresses. Single-blob callers pass a one-element slice.
func (s *Storage) GetAll(ctx context.Context, addresses []string, w io.Writer) error {
	if len(s.backends) == 0 {
		return ErrNotFound
	}
	if len(addresses) == 0 {
		return nil
	}
	var firstErr error
	for _, b := range s.backends {
		err := b.GetAll(ctx, addresses, w)
		if err == nil {
			return nil
		}
		if !errors.Is(err, ErrNotFound) {
			return fmt.Errorf("cas: %s: %w", b.Kind(), err)
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// Has reports whether any backend holds address.
func (s *Storage) Has(ctx context.Context, address string) (bool, error) {
	for _, b := range s.backends {
		ok, err := b.Has(ctx, address)
		if err != nil {
			return false, fmt.Errorf("cas: %s: %w", b.Kind(), err)
		}
		if ok {
			return true, nil
		}
	}
	return false, nil
}

// Head returns the first backend, used by callers that need to write. nil
// when no backends are configured (tests).
func (s *Storage) Head() Backend {
	if len(s.backends) == 0 {
		return nil
	}
	return s.backends[0]
}

// Put hashes data and writes it through the head backend, skipping the
// write when any backend already holds the address (identical bytes
// collapse to one blob). Returns the SHA-256 address. `data` is not
// retained after Put returns, so callers may reuse the buffer.
func (s *Storage) Put(ctx context.Context, mimeType string, data []byte) (string, error) {
	head := s.Head()
	if head == nil {
		return "", errors.New("cas: no backend configured")
	}
	address := AddressOf(data)
	exists, err := s.Has(ctx, address)
	if err != nil {
		return "", err
	}
	if !exists {
		if err := head.Put(ctx, address, mimeType, int64(len(data)), data); err != nil {
			return "", fmt.Errorf("cas: %s: put: %w", head.Kind(), err)
		}
	}
	return address, nil
}
