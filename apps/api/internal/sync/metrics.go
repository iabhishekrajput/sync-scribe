package sync

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	activeConnections = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "syncscribe_sync_active_connections",
		Help: "Open WebSocket sync connections across all documents.",
	})

	activeSessions = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "syncscribe_sync_active_sessions",
		Help: "Documents with at least one open connection.",
	})

	updatesReceived = promauto.NewCounter(prometheus.CounterOpts{
		Name: "syncscribe_sync_updates_received_total",
		Help: "Yjs update frames received from clients.",
	})

	updatesPersisted = promauto.NewCounter(prometheus.CounterOpts{
		Name: "syncscribe_sync_updates_persisted_total",
		Help: "Yjs update frames written to document_updates.",
	})

	wsErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "syncscribe_sync_ws_errors_total",
		Help: "WebSocket errors by reason.",
	}, []string{"reason"})

	broadcastBytes = promauto.NewCounter(prometheus.CounterOpts{
		Name: "syncscribe_sync_broadcast_bytes_total",
		Help: "Total bytes broadcast to peer connections.",
	})

	replayBytes = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "syncscribe_sync_replay_bytes",
		Help:    "Bytes streamed on initial connect (replay of stored updates).",
		Buckets: prometheus.ExponentialBuckets(256, 4, 8),
	})

	resyncCloses = promauto.NewCounter(prometheus.CounterOpts{
		Name: "syncscribe_sync_resync_closes_total",
		Help: "Connections closed with code 4010 (RESYNC) after outbound buffer overflow.",
	})

	ipCapRejects = promauto.NewCounter(prometheus.CounterOpts{
		Name: "syncscribe_sync_ip_cap_rejects_total",
		Help: "WS upgrades rejected because the source IP exceeded its concurrent-connection cap.",
	})
)
