package httpx

import (
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

// loggerForTesting swaps the package logger that LoggerFrom falls back to
// when no ctx logger is present. Returns the previous value so tests can
// restore it.
func loggerForTesting(next zerolog.Logger) zerolog.Logger {
	prev := log.Logger
	log.Logger = next
	return prev
}
