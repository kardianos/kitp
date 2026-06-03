package main

import (
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/mcp"
	"github.com/kitp/kitp/server/internal/reg"
)

// TestCuratedToolsAreRegistered guards the MCP curated tool surface
// (internal/mcp/curated.go) against drift: every advertised tool name
// must resolve to a registered handler. A rename / removal that the
// curated set didn't follow would otherwise silently drop the tool
// from tools/list with no error. Lives in cmd/kitpd because that's
// where registerHandlers populates the full process-global registry.
func TestCuratedToolsAreRegistered(t *testing.T) {
	reg.Reset()
	registerHandlers(nil, nil)

	for _, name := range mcp.CuratedToolNames() {
		endpoint, action, ok := strings.Cut(name, "__")
		if !ok {
			t.Errorf("curated tool %q is not in <endpoint>__<action> form", name)
			continue
		}
		if _, found := reg.Lookup(endpoint, action); !found {
			t.Errorf("curated tool %q resolves to no registered handler", name)
		}
	}
}
