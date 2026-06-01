package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/abhishek/sync-scribe/api/internal/auth"
	"github.com/abhishek/sync-scribe/api/internal/config"
	"github.com/abhishek/sync-scribe/api/internal/server"
	"github.com/abhishek/sync-scribe/api/internal/store"
	syncpkg "github.com/abhishek/sync-scribe/api/internal/sync"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal().Err(err).Msg("config")
	}

	zerolog.SetGlobalLevel(cfg.LogLevel)
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	provCtx, provCancel := context.WithTimeout(ctx, 10*time.Second)
	prov, err := auth.NewProvider(provCtx, auth.ProviderConfig{
		IssuerURL:    cfg.OIDCIssuerURL,
		ClientID:     cfg.OIDCClientID,
		ClientSecret: cfg.OIDCClientSecret,
		RedirectURL:  cfg.OIDCRedirectURL,
		Audience:     cfg.OIDCTokenAudience,
	})
	provCancel()
	if err != nil {
		log.Fatal().Err(err).Msg("oidc discovery")
	}
	log.Info().Str("issuer", cfg.OIDCIssuerURL).Bool("pkce_only", prov.UsePKCE).Msg("oidc ready")

	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal().Err(err).Msg("postgres")
	}
	defer st.Close()
	log.Info().Msg("postgres ready")

	go st.RunRetentionLoop(ctx, store.DefaultRetentionInterval)

	// Broker: enabled when REDIS_URL is set. When absent we run in
	// single-node mode — no cross-node relay.
	var broker syncpkg.Broker
	if cfg.RedisURL != "" {
		b, err := syncpkg.NewValkeyBroker(cfg.RedisURL)
		if err != nil {
			log.Fatal().Err(err).Str("url", cfg.RedisURL).Msg("redis broker init")
		}
		defer b.Close() //nolint:errcheck
		broker = b
		log.Info().Str("url", cfg.RedisURL).Msg("redis broker ready — multi-node mode")
	} else {
		log.Info().Msg("no REDIS_URL set — running in single-node mode")
	}

	srv := server.New(cfg, prov, st, broker)

	httpSrv := &http.Server{
		Addr:              ":" + cfg.APIPort,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Info().Str("addr", httpSrv.Addr).Msg("api listening")
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("listen")
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	log.Info().Msg("shutting down")
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		log.Error().Err(err).Msg("shutdown")
	}
}
