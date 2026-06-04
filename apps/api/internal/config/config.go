package config

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"

	"github.com/rs/zerolog"
)

type Config struct {
	APIPort         string
	APIBaseURL      string
	FrontendBaseURL string
	DatabaseURL     string
	RedisURL        string

	OIDCIssuerURL      string
	OIDCClientID       string
	OIDCClientSecret   string
	OIDCRedirectURL    string
	OIDCTokenAudience  string // required for Auth0; empty for Dex/generic OIDC

	CookieSecret []byte
	CookieSecure bool

	SMTPHost     string
	SMTPPort     string
	SMTPFrom     string
	SMTPUsername string
	SMTPPassword string

	// AdminSecret gates the /admin/* endpoints. Empty = no auth (dev only).
	AdminSecret string

	LogLevel zerolog.Level
}

func Load() (*Config, error) {
	cfg := &Config{
		APIPort:          envOr("API_PORT", "8080"),
		APIBaseURL:       envOr("API_BASE_URL", "http://localhost:8080"),
		FrontendBaseURL:  envOr("FRONTEND_BASE_URL", "http://localhost:3000"),
		DatabaseURL:      os.Getenv("DATABASE_URL"),
		RedisURL:         os.Getenv("REDIS_URL"),
		OIDCIssuerURL:     os.Getenv("OIDC_ISSUER_URL"),
		OIDCClientID:      os.Getenv("OIDC_CLIENT_ID"),
		OIDCClientSecret:  os.Getenv("OIDC_CLIENT_SECRET"),
		OIDCRedirectURL:   os.Getenv("OIDC_REDIRECT_URL"),
		OIDCTokenAudience: os.Getenv("OIDC_TOKEN_AUDIENCE"),
		CookieSecure:     envOr("COOKIE_SECURE", "false") == "true",
		SMTPHost:         envOr("SMTP_HOST", "localhost"),
		SMTPPort:         envOr("SMTP_PORT", "1026"),
		SMTPFrom:         envOr("SMTP_FROM", "noreply@syncscribe.local"),
		SMTPUsername:     os.Getenv("SMTP_USERNAME"),
		SMTPPassword:     os.Getenv("SMTP_PASSWORD"),
		AdminSecret:      os.Getenv("ADMIN_SECRET"),
		LogLevel:         parseLevel(envOr("LOG_LEVEL", "info")),
	}

	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if cfg.OIDCIssuerURL == "" || cfg.OIDCClientID == "" || cfg.OIDCRedirectURL == "" {
		return nil, fmt.Errorf("OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_REDIRECT_URL are required")
	}

	secret := os.Getenv("COOKIE_SECRET")
	if secret == "" {
		return nil, fmt.Errorf("COOKIE_SECRET is required (32+ random bytes, hex or raw)")
	}
	if decoded, err := hex.DecodeString(secret); err == nil && len(decoded) >= 32 {
		cfg.CookieSecret = decoded
	} else {
		sum := sha256.Sum256([]byte(secret))
		cfg.CookieSecret = sum[:]
	}

	return cfg, nil
}


func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func parseLevel(s string) zerolog.Level {
	lvl, err := zerolog.ParseLevel(s)
	if err != nil {
		return zerolog.InfoLevel
	}
	return lvl
}
