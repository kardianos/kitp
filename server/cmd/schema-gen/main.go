// Command schema-gen reads db/schema/declarative.json and prints a
// CREATE-everything SQL script to stdout. Used by the parity test in
// internal/schema/declarative and (eventually) by the migration
// runner once the document covers every table.
//
// Usage:
//   go run ./server/cmd/schema-gen          # to stdout
//   go run ./server/cmd/schema-gen -o out   # to a file
//
// The generator is deterministic: tables are emitted in
// topologically-sorted order with alphabetic tie-breaks, so the
// output is suitable for diffing in PRs.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/kitp/kitp/server/internal/schema/declarative"
)

func main() {
	var out string
	flag.StringVar(&out, "o", "", "write to this file instead of stdout")
	var path string
	flag.StringVar(&path, "schema", "", "path to declarative.json (default: walk up from package source)")
	flag.Parse()

	doc, err := declarative.Load(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "schema-gen:", err)
		os.Exit(1)
	}
	sql := declarative.GenerateSQL(doc)
	if out == "" {
		os.Stdout.WriteString(sql)
		return
	}
	if err := os.WriteFile(out, []byte(sql), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "schema-gen: write:", err)
		os.Exit(1)
	}
}
