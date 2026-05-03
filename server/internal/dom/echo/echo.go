// Package echo provides a trivial echo.ping handler. It exists to prove
// the registry/dispatcher path end-to-end without touching the database.
package echo

import (
	"context"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/reg"
)

// PingInput is the wire shape for echo.ping. The handler simply echoes
// the message back. It carries an "x" field because that mirrors the
// example curl in IMPLEMENTATION_PLAN.md §1.
type PingInput struct {
	X       int    `json:"x" mcp:"desc=an integer that will be echoed back unchanged"`
	Message string `json:"message" mcp:"desc=a free-form string echoed back to the caller"`
}

// PingOutput is what we return.
type PingOutput struct {
	X       int    `json:"x" mcp:"desc=the integer from the input"`
	Message string `json:"message" mcp:"desc=the message from the input"`
}

// Register installs the handler. Tests call this explicitly; production
// gets it via the import in cmd/kitpd.
func Register() {
	reg.Register(reg.Handler{
		Endpoint:   "echo",
		Action:     "ping",
		Doc:        "Echo the input back unchanged; used to smoke-test the dispatcher.",
		InputType:  reflect.TypeFor[PingInput](),
		OutputType: reflect.TypeFor[PingOutput](),
		Run: func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
			outs := make([]any, len(ins))
			for i, raw := range ins {
				in := raw.(PingInput)
				outs[i] = PingOutput{X: in.X, Message: in.Message}
			}
			return outs, nil
		},
	})
}
