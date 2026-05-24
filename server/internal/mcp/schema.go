// File schema.go: reflect-based JSONSchema generator for handler I/O
// types. The "mcp" struct-tag schema (v1) is locked in
// docs/mcp-tags.md; this file is the only consumer.
package mcp

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"time"
)

// SchemaVersion is the locked tag-schema version emitted by this
// generator. Bumping this string is a breaking change and must come
// with an updated docs/mcp-tags.md.
//
// v2 (this version) adds format=, maxlen=, minlen=, min=, max=,
// pattern= to the mcp: tag schema, so the published JSON Schema is
// rich enough to drive the client's data-bound form kernel without
// each screen re-declaring validation rules.
const SchemaVersion = "2"

// Schema is the JSON Schema document we emit per tool. It is a small,
// stable subset of JSON Schema 2020-12 — enough to drive both the MCP
// catalogue and the client's data-bound form kernel.
type Schema struct {
	Type                 string             `json:"type,omitempty"`
	Description          string             `json:"description,omitempty"`
	Properties           map[string]*Schema `json:"properties,omitempty"`
	Required             []string           `json:"required,omitempty"`
	Items                *Schema            `json:"items,omitempty"`
	Enum                 []string           `json:"enum,omitempty"`
	AdditionalProperties any                `json:"additionalProperties,omitempty"`
	Format               string             `json:"format,omitempty"`
	// v2 string-shape constraints.
	MinLength *int   `json:"minLength,omitempty"`
	MaxLength *int   `json:"maxLength,omitempty"`
	Pattern   string `json:"pattern,omitempty"`
	// v2 numeric-shape constraints. Pointer-typed so 0 can be sent
	// when the caller really means 0.
	Minimum *float64 `json:"minimum,omitempty"`
	Maximum *float64 `json:"maximum,omitempty"`
}

// SchemaForType produces a Schema for a Go reflect.Type.
//
// rules summary (locked v1):
//   - string / bool / int* / float* / time.Time / json.RawMessage / map[string]any
//     map directly to a JSON Schema scalar/object.
//   - struct types recurse: each field with a non-empty json tag becomes
//     one property, `mcp` tag drives description/required/enum, pointer
//     types and `omitempty` json tags are emitted as optional.
//   - slices/maps recurse on their element types.
//
// Recursive types (e.g. a Predicate that contains a slice of Predicate
// for compound `and` clauses) are detected and the recursive reference
// is emitted as an opaque "object" without recursing again. This keeps
// schema generation finite without sacrificing useful schema for the
// non-recursive parts of the type.
//
// requireRoot toggles whether the top-level struct's required list is
// emitted (always true for input types; we still call SchemaForType on
// outputs but the caller decides whether to keep `required`).
func SchemaForType(t reflect.Type, requireRoot bool) *Schema {
	if t == nil {
		return &Schema{}
	}
	return buildSchema(t, "", "", map[reflect.Type]bool{})
}

// fieldOpt is the parsed "mcp" tag for one field.
type fieldOpt struct {
	desc      string
	required  bool
	enum      []string
	format    string   // v2: format=email|url|json|date|date-time|uuid|…
	minLength *int     // v2: minlen=N
	maxLength *int     // v2: maxlen=N
	pattern   string   // v2: pattern=<regex>
	minimum   *float64 // v2: min=N
	maximum   *float64 // v2: max=N
}

// parseMCPTag parses tag bodies of the form "<key>[=<value>][,<key>...]" where:
//   - "required" is a boolean flag (no =).
//   - "enum=A|B|C" lists pipe-separated string values.
//   - "format=<token>" emits JSON Schema `format` (email/url/json/uuid/…).
//   - "minlen=N" / "maxlen=N" emit string-length bounds.
//   - "min=N" / "max=N" emit numeric bounds.
//   - "pattern=<regex>" emits a regex constraint (commas allowed in regex
//     are NOT supported — use char classes if needed; the parser splits
//     on the next comma).
//   - "desc=..." is greedy: it consumes the entire remainder of the tag
//     (so the description may contain commas, parentheses, slashes, etc).
//
// Greedy desc means `desc=` should be the last directive in the tag.
// Any directives following `desc=...` are treated as part of the
// description text; writers should always put `desc=` last.
func parseMCPTag(tag string) fieldOpt {
	var o fieldOpt
	if tag == "" {
		return o
	}
	rest := tag
	for {
		rest = strings.TrimLeft(rest, ", ")
		if rest == "" {
			break
		}
		// desc consumes the whole remainder.
		if after, ok := strings.CutPrefix(rest, "desc="); ok {
			o.desc = strings.TrimSpace(after)
			break
		}
		var part string
		if i := strings.IndexByte(rest, ','); i >= 0 {
			part = strings.TrimSpace(rest[:i])
			rest = rest[i+1:]
		} else {
			part = strings.TrimSpace(rest)
			rest = ""
		}
		if part == "" {
			continue
		}
		switch {
		case part == "required":
			o.required = true
		case strings.HasPrefix(part, "enum="):
			vals := strings.TrimPrefix(part, "enum=")
			if vals == "" {
				continue
			}
			o.enum = strings.Split(vals, "|")
		case strings.HasPrefix(part, "format="):
			o.format = strings.TrimPrefix(part, "format=")
		case strings.HasPrefix(part, "minlen="):
			if n, ok := parseIntDirective(part, "minlen="); ok {
				o.minLength = &n
			}
		case strings.HasPrefix(part, "maxlen="):
			if n, ok := parseIntDirective(part, "maxlen="); ok {
				o.maxLength = &n
			}
		case strings.HasPrefix(part, "min="):
			if n, ok := parseFloatDirective(part, "min="); ok {
				o.minimum = &n
			}
		case strings.HasPrefix(part, "max="):
			if n, ok := parseFloatDirective(part, "max="); ok {
				o.maximum = &n
			}
		case strings.HasPrefix(part, "pattern="):
			o.pattern = strings.TrimPrefix(part, "pattern=")
		}
	}
	return o
}

func parseIntDirective(part, prefix string) (int, bool) {
	v := strings.TrimPrefix(part, prefix)
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, false
	}
	return n, true
}

func parseFloatDirective(part, prefix string) (float64, bool) {
	v := strings.TrimPrefix(part, prefix)
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

// jsonOpts is the subset of json struct tag flags the MCP schema
// generator cares about.
type jsonOpts struct {
	name      string
	hasOmit   bool
	hasString bool // ",string" — numeric value encoded as JSON string on the wire
}

// jsonName returns the json tag's parsed options. Returns ok=false
// when the field is not exported, has tag "-", or has no tag at all.
func jsonName(f reflect.StructField) (jsonOpts, bool) {
	if !f.IsExported() {
		return jsonOpts{}, false
	}
	tag, ok := f.Tag.Lookup("json")
	if !ok {
		return jsonOpts{}, false
	}
	if tag == "-" {
		return jsonOpts{}, false
	}
	parts := strings.Split(tag, ",")
	name := parts[0]
	if name == "" {
		name = f.Name
	}
	out := jsonOpts{name: name}
	for _, opt := range parts[1:] {
		switch opt {
		case "omitempty":
			out.hasOmit = true
		case "string":
			out.hasString = true
		}
	}
	return out, true
}

// rawMessageType caches reflect.Type of json.RawMessage for fast compare.
var (
	rawMessageType = reflect.TypeFor[json.RawMessage]()
	timeType       = reflect.TypeFor[time.Time]()
	anyType        = reflect.TypeFor[any]()
)

// buildSchema walks t recursively, threading a `seen` set so a recursive
// struct (like Predicate, which contains []Predicate) terminates instead
// of overflowing the stack.
func buildSchema(t reflect.Type, desc string, mcpTag string, seen map[reflect.Type]bool) *Schema {
	opt := parseMCPTag(mcpTag)
	if desc == "" {
		desc = opt.desc
	}
	// Unwrap pointer.
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}

	// Special types first.
	if t == rawMessageType {
		return &Schema{Description: desc}
	}
	if t == timeType {
		return &Schema{Type: "string", Format: "date-time", Description: desc}
	}

	switch t.Kind() {
	case reflect.String:
		s := &Schema{Type: "string", Description: desc}
		if len(opt.enum) > 0 {
			s.Enum = opt.enum
		}
		if opt.format != "" {
			s.Format = opt.format
		}
		s.MinLength = opt.minLength
		s.MaxLength = opt.maxLength
		s.Pattern = opt.pattern
		return s
	case reflect.Bool:
		return &Schema{Type: "boolean", Description: desc}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		s := &Schema{Type: "integer", Description: desc}
		s.Minimum = opt.minimum
		s.Maximum = opt.maximum
		return s
	case reflect.Float32, reflect.Float64:
		s := &Schema{Type: "number", Description: desc}
		s.Minimum = opt.minimum
		s.Maximum = opt.maximum
		return s
	case reflect.Slice, reflect.Array:
		return &Schema{
			Type:        "array",
			Description: desc,
			Items:       buildSchema(t.Elem(), "", "", seen),
		}
	case reflect.Map:
		return &Schema{
			Type:                 "object",
			Description:          desc,
			AdditionalProperties: true,
		}
	case reflect.Interface:
		// any / interface{} => any JSON
		if t == anyType {
			return &Schema{Description: desc}
		}
		return &Schema{Description: desc}
	case reflect.Struct:
		// Cycle guard: a self-referential struct (e.g. Predicate.And of
		// type []Predicate) would otherwise recurse forever. Emit an
		// opaque object the second time we encounter the same type.
		if seen[t] {
			return &Schema{
				Type:                 "object",
				Description:          desc,
				AdditionalProperties: true,
			}
		}
		seen[t] = true
		out := buildStruct(t, desc, seen)
		// Allow the same type to appear in unrelated subtrees by clearing
		// the marker on the way out — only the active descent should
		// short-circuit.
		delete(seen, t)
		return out
	}
	// fallthrough: unsupported kind, emit empty schema.
	return &Schema{Description: desc}
}

func buildStruct(t reflect.Type, desc string, seen map[reflect.Type]bool) *Schema {
	s := &Schema{
		Type:        "object",
		Description: desc,
		Properties:  map[string]*Schema{},
	}
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		jo, ok := jsonName(f)
		if !ok {
			continue
		}
		opt := parseMCPTag(f.Tag.Get("mcp"))
		// Treat pointer-typed and omitempty fields as optional unless
		// `required` is explicitly set.
		isPointer := f.Type.Kind() == reflect.Pointer
		fieldSchema := buildSchema(f.Type, opt.desc, f.Tag.Get("mcp"), seen)
		// `,string` flips numeric Go types onto the JSON-string wire
		// shape (encoding/json decodes them from a quoted decimal
		// string). The MCP client must send the value as a string;
		// emit type:"string" so its validator + the model's
		// argument-shaping agree with what our decoder accepts.
		if jo.hasString && (fieldSchema.Type == "integer" || fieldSchema.Type == "number") {
			fieldSchema.Type = "string"
		}
		s.Properties[jo.name] = fieldSchema
		if opt.required && !isPointer && !jo.hasOmit {
			s.Required = append(s.Required, jo.name)
		} else if opt.required {
			// User asked for required even on a pointer/omitempty field.
			s.Required = append(s.Required, jo.name)
		}
	}
	return s
}

// formatSchemaJSON pretty-prints a schema (2-space indent). Used by
// goldens.
func formatSchemaJSON(s *Schema) ([]byte, error) {
	if s == nil {
		return []byte("{}"), nil
	}
	buf, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal schema: %w", err)
	}
	return append(buf, '\n'), nil
}
