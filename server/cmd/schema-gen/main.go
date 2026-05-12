// Command schema-gen reads db/schema/declarative.toml and prints a
// CREATE-everything + INSERT-seeds SQL script to stdout. Pipe to psql
// for a fresh install, or use `make db-reset` which drives the same
// generator.
//
// Usage:
//   go run ./server/cmd/schema-gen                     # seed only
//   go run ./server/cmd/schema-gen -demo               # seed + demo
//   go run ./server/cmd/schema-gen -o build/schema.sql # write to file
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
	flag.StringVar(&path, "schema", "", "path to declarative.toml (default: walk up from package source)")
	var demo bool
	flag.BoolVar(&demo, "demo", false, "include the opt-in demo seed section after the built-in seeds")
	flag.Parse()

	doc, err := declarative.Load(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "schema-gen:", err)
		os.Exit(1)
	}
	sql := declarative.GenerateSQL(doc, declarative.Options{Demo: demo})
	if out == "" {
		os.Stdout.WriteString(sql)
		return
	}
	if err := os.WriteFile(out, []byte(sql), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "schema-gen: write:", err)
		os.Exit(1)
	}
}
