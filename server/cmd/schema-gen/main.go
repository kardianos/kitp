// Command schema-gen reads db/schema/schema.hcsv (DDL),
// db/schema/seed.hcsv (install seeds), and (when -demo is given)
// db/schema/demo.hcsv, then prints one CREATE-everything + INSERT
// SQL script to stdout. Pipe to psql for a fresh install, or use
// `make db-reset` which drives the same generator.
//
// Usage:
//
//	go run ./server/cmd/schema-gen                     # seed only
//	go run ./server/cmd/schema-gen -demo               # seed + demo
//	go run ./server/cmd/schema-gen -o build/schema.sql # write to file
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/kitp/kitp/server/internal/schema/hcsv"
)

func main() {
	var out string
	flag.StringVar(&out, "o", "", "write to this file instead of stdout")
	var demo bool
	flag.BoolVar(&demo, "demo", false, "include the opt-in demo seed section after the built-in seeds")
	flag.Parse()

	sql, err := hcsv.GenerateAll(hcsv.GenerateOptions{Demo: demo})
	if err != nil {
		fmt.Fprintln(os.Stderr, "schema-gen:", err)
		os.Exit(1)
	}
	if out == "" {
		os.Stdout.WriteString(sql)
		return
	}
	if err := os.WriteFile(out, []byte(sql), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "schema-gen: write:", err)
		os.Exit(1)
	}
}
