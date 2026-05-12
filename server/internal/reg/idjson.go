package reg

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// IDs is a slice of int64 ids that marshals/unmarshals each element as a
// JSON string. Go's `,string` JSON tag does not apply elementwise to a
// slice, so id-array fields use this named type to keep wire format
// consistent: every id (single or array) crosses the wire as a string so
// JavaScript clients can decode to bigint without precision loss.
//
// Reads accept either `"42"` (the canonical form) or `42` (legacy
// pre-int64 callers) per element. Writes always emit strings.
type IDs []int64

// MarshalJSON renders the slice as a JSON array of decimal-string ids.
func (s IDs) MarshalJSON() ([]byte, error) {
	if s == nil {
		return []byte("null"), nil
	}
	out := make([]string, len(s))
	for i, v := range s {
		out[i] = strconv.FormatInt(v, 10)
	}
	return json.Marshal(out)
}

// UnmarshalJSON accepts both `"42"` and `42` element shapes.
func (s *IDs) UnmarshalJSON(data []byte) error {
	if len(data) >= 4 && string(data[:4]) == "null" {
		*s = nil
		return nil
	}
	var raw []json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("idjson: expected array: %w", err)
	}
	out := make([]int64, len(raw))
	for i, r := range raw {
		txt := string(r)
		if len(txt) >= 2 && txt[0] == '"' && txt[len(txt)-1] == '"' {
			txt = txt[1 : len(txt)-1]
		}
		n, err := strconv.ParseInt(txt, 10, 64)
		if err != nil {
			return fmt.Errorf("idjson: element %d %q: %w", i, txt, err)
		}
		out[i] = n
	}
	*s = out
	return nil
}
