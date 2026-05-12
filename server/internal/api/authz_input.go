// File api/authz_input.go: small reflection-based extractors so the
// dispatcher can locate the card_id (and parent_card_id, for inserts)
// inside any handler's typed input without a per-handler hook on
// reg.Handler.
//
// Why reflection: handler inputs all carry conventional JSON tags
// (`card_id`, `parent_card_id`, `target_card_id`, `card_type_name`). Each
// handler type is registered exactly once at startup, so the cost of the
// reflection walk is negligible compared to the SQL it precedes.
package api

import (
	"reflect"
)

// cardIDFromInput walks the input struct for a `json:"card_id,string"` or
// `json:"target_card_id,string"` field and returns its int64 value. Returns 0 if
// no match — the dispatcher then skips scoped-grant matching for that leaf.
func cardIDFromInput(h interface{}, in any) int64 {
	v := reflect.ValueOf(in)
	if !v.IsValid() {
		return 0
	}
	if v.Kind() == reflect.Pointer {
		if v.IsNil() {
			return 0
		}
		v = v.Elem()
	}
	if v.Kind() != reflect.Struct {
		return 0
	}
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag := jsonName(f.Tag.Get("json"))
		switch tag {
		case "card_id", "target_card_id":
			fv := v.Field(i)
			if fv.Kind() == reflect.Pointer {
				if fv.IsNil() {
					continue
				}
				fv = fv.Elem()
			}
			if fv.CanInt() {
				return fv.Int()
			}
		}
	}
	return 0
}

// cardInsertParent extracts the parent_card_id and "is project type" flag
// from a card.InsertInput value. We avoid importing the card package here
// to dodge an import cycle (api -> card would also import card -> reg, etc.);
// reflection on the named fields keeps the file self-contained.
func cardInsertParent(in any) (*int64, bool, error) {
	v := reflect.ValueOf(in)
	if v.Kind() == reflect.Pointer {
		v = v.Elem()
	}
	if v.Kind() != reflect.Struct {
		return nil, false, nil
	}
	t := v.Type()
	var parent *int64
	isProject := false
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag := jsonName(f.Tag.Get("json"))
		fv := v.Field(i)
		switch tag {
		case "parent_card_id":
			if fv.Kind() == reflect.Pointer {
				if !fv.IsNil() {
					p := fv.Elem().Int()
					parent = &p
				}
			} else if fv.CanInt() {
				p := fv.Int()
				if p != 0 {
					parent = &p
				}
			}
		case "card_type_name":
			if fv.Kind() == reflect.String && fv.String() == "project" {
				isProject = true
			}
		}
	}
	return parent, isProject, nil
}

// jsonName extracts the tag name from a `json:"name,opts..."` value. Returns
// the input unchanged if no comma is present.
func jsonName(tag string) string {
	for i := 0; i < len(tag); i++ {
		if tag[i] == ',' {
			return tag[:i]
		}
	}
	return tag
}
