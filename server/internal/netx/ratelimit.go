package netx

import (
	"container/list"
	"sort"
	"sync"
	"time"
)

// Limiter is a set of token buckets kept in memory only (they reset when
// kitp restarts; nothing is stored). Each key — a source address or a route
// — refills at rate per minute up to burst. A miss (an unknown address, a
// bad token, a failed check) costs more than an ordinary request, so a
// source that keeps guessing is throttled first. At most maxKeys buckets are
// kept; the least recently used go first, so an attack can't grow memory
// without bound.
type Limiter struct {
	mu      sync.Mutex
	perSec  float64
	burst   float64
	maxKeys int
	keys    map[string]*list.Element
	lru     *list.List // front = most recently used
	now     func() time.Time
}

type bucket struct {
	key    string
	tokens float64
	at     time.Time
}

// NewLimiter makes a limiter: perMinute tokens a minute, burst at most,
// maxKeys buckets.
func NewLimiter(perMinute, burst, maxKeys int) *Limiter {
	return &Limiter{
		perSec:  float64(perMinute) / 60,
		burst:   float64(burst),
		maxKeys: maxKeys,
		keys:    map[string]*list.Element{},
		lru:     list.New(),
		now:     time.Now,
	}
}

// Allow takes cost tokens from key's bucket; false when there aren't
// enough (the request should be refused, and costs nothing more).
func (l *Limiter) Allow(key string, cost float64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.bucket(key)
	if b.tokens < cost {
		return false
	}
	b.tokens -= cost
	return true
}

// Charge takes cost tokens without refusing (a miss found after the
// request was let in); the bucket may go negative, which keeps the source
// throttled for longer.
func (l *Limiter) Charge(key string, cost float64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.bucket(key)
	b.tokens -= cost
	if b.tokens < -l.burst {
		b.tokens = -l.burst
	}
}

// Throttled lists the keys that can't currently make a request, sorted.
func (l *Limiter) Throttled() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []string
	for e := l.lru.Front(); e != nil; e = e.Next() {
		b := e.Value.(*bucket)
		l.refill(b)
		if b.tokens < 1 {
			out = append(out, b.key)
		}
	}
	sort.Strings(out)
	return out
}

func (l *Limiter) bucket(key string) *bucket {
	if e, ok := l.keys[key]; ok {
		l.lru.MoveToFront(e)
		b := e.Value.(*bucket)
		l.refill(b)
		return b
	}
	for l.lru.Len() >= l.maxKeys && l.lru.Len() > 0 {
		old := l.lru.Back()
		delete(l.keys, old.Value.(*bucket).key)
		l.lru.Remove(old)
	}
	b := &bucket{key: key, tokens: l.burst, at: l.now()}
	l.keys[key] = l.lru.PushFront(b)
	return b
}

func (l *Limiter) refill(b *bucket) {
	now := l.now()
	b.tokens += now.Sub(b.at).Seconds() * l.perSec
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.at = now
}
