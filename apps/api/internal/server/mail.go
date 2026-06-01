package server

import (
	"fmt"
	"net/smtp"
	"strings"

	"github.com/abhishek/sync-scribe/api/internal/store"
)

func (s *Server) sendInviteEmail(invite *store.Invite) error {
	docURL := fmt.Sprintf("%s/d/%s", strings.TrimRight(s.cfg.FrontendBaseURL, "/"), invite.DocumentID)
	subject := "SyncScribe document invite"
	body := fmt.Sprintf("You were invited to collaborate on a SyncScribe document.\n\nOpen it here:\n%s\n", docURL)
	msg := strings.Join([]string{
		"From: " + s.cfg.SMTPFrom,
		"To: " + invite.Email,
		"Subject: " + subject,
		"Content-Type: text/plain; charset=UTF-8",
		"",
		body,
	}, "\r\n")
	addr := s.cfg.SMTPHost + ":" + s.cfg.SMTPPort
	return smtp.SendMail(addr, nil, s.cfg.SMTPFrom, []string{invite.Email}, []byte(msg))
}
