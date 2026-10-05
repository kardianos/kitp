// msgraph.go: the MS Graph (Teams channel) output of the activity pump.
//
// A msgraph_teams sink posts each delivery (one digest — see digest.go)
// as a channel message via the client_credentials flow. The poster is a
// seam: tests inject a recording stub via Pumper.SetPoster.
package activitysink

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// SinkKindMSGraphTeams is the broadcast Teams-channel sink kind.
const SinkKindMSGraphTeams = "msgraph_teams"

// MSGraphPoster is the seam between the pump and the wire. Returns nil
// on a successful POST, *MSGraphPermanentError when MS Graph reports a
// non-retriable failure (auth, missing channel, …), and any other
// error for transient failure (network, 5xx, throttling).
//
// The default poster is realMSGraphPost; tests inject a recording stub
// via SetPoster.
type MSGraphPoster func(ctx context.Context, cfg MSGraphConfig, message string) error

// MSGraphConfig is the per-sink config the poster needs. Resolved once
// per RunOnce from the sink card's attributes + the decrypted secret.
type MSGraphConfig struct {
	TenantID     string
	ClientID     string
	ClientSecret string
	TeamID       string
	ChannelID    string
}

// MSGraphPermanentError signals a non-retriable failure. The pumper
// flips the sink to disabled-fault when it sees one.
type MSGraphPermanentError struct {
	Status int
	Body   string
}

func (e *MSGraphPermanentError) Error() string {
	return fmt.Sprintf("ms graph permanent error %d: %s", e.Status, truncate(e.Body, 200))
}

// ---- MS Graph HTTP client ----

// tokenCache is a single-tenant access token + expiry pair. The pumper
// keeps one per sink so successive ticks reuse the same token until it
// is close to expiring.
type tokenCache struct {
	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

// One cache per (tenant, client_id). MS Graph permits the same app
// registration to be used across many sinks; sharing the cache keeps
// us from rate-limiting ourselves on the token endpoint.
var (
	tokenCachesMu sync.Mutex
	tokenCaches   = map[string]*tokenCache{}
)

func getTokenCache(tenant, client string) *tokenCache {
	tokenCachesMu.Lock()
	defer tokenCachesMu.Unlock()
	key := tenant + "|" + client
	if tc, ok := tokenCaches[key]; ok {
		return tc
	}
	tc := &tokenCache{}
	tokenCaches[key] = tc
	return tc
}

// realMSGraphPost is the production poster. Acquires (or reuses) a
// client_credentials access token, then POSTs the message to
// /teams/{team}/channels/{channel}/messages.
func realMSGraphPost(ctx context.Context, cfg MSGraphConfig, message string) error {
	if cfg.TenantID == "" || cfg.ClientID == "" || cfg.ClientSecret == "" {
		return &MSGraphPermanentError{Status: 0, Body: "missing MS Graph credentials"}
	}
	if cfg.TeamID == "" || cfg.ChannelID == "" {
		return &MSGraphPermanentError{Status: 0, Body: "missing MS Graph team/channel id"}
	}

	tc := getTokenCache(cfg.TenantID, cfg.ClientID)
	tc.mu.Lock()
	tok := tc.token
	exp := tc.expiresAt
	tc.mu.Unlock()
	if tok == "" || time.Until(exp) < 60*time.Second {
		newTok, newExp, err := fetchMSGraphToken(ctx, cfg)
		if err != nil {
			return err
		}
		tc.mu.Lock()
		tc.token, tc.expiresAt = newTok, newExp
		tc.mu.Unlock()
		tok = newTok
	}

	endpoint := fmt.Sprintf("https://graph.microsoft.com/v1.0/teams/%s/channels/%s/messages",
		url.PathEscape(cfg.TeamID), url.PathEscape(cfg.ChannelID))
	body := map[string]any{
		"body": map[string]any{
			"contentType": "html",
			"content":     message,
		},
	}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal graph body: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	respBody, _ := io.ReadAll(resp.Body)
	if isPermanentStatus(resp.StatusCode) {
		return &MSGraphPermanentError{Status: resp.StatusCode, Body: string(respBody)}
	}
	return fmt.Errorf("ms graph transient %d: %s", resp.StatusCode, truncate(string(respBody), 200))
}

func fetchMSGraphToken(ctx context.Context, cfg MSGraphConfig) (string, time.Time, error) {
	tokenURL := fmt.Sprintf("https://login.microsoftonline.com/%s/oauth2/v2.0/token", url.PathEscape(cfg.TenantID))
	form := url.Values{}
	form.Set("client_id", cfg.ClientID)
	form.Set("client_secret", cfg.ClientSecret)
	form.Set("grant_type", "client_credentials")
	form.Set("scope", "https://graph.microsoft.com/.default")

	req, err := http.NewRequestWithContext(ctx, "POST", tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", time.Time{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", time.Time{}, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Token-endpoint failures with 4xx (bad creds, bad tenant) are
		// permanent; 5xx is transient.
		if isPermanentStatus(resp.StatusCode) {
			return "", time.Time{}, &MSGraphPermanentError{Status: resp.StatusCode, Body: string(respBody)}
		}
		return "", time.Time{}, fmt.Errorf("ms graph token transient %d: %s", resp.StatusCode, truncate(string(respBody), 200))
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(respBody, &tok); err != nil {
		return "", time.Time{}, fmt.Errorf("decode token: %w", err)
	}
	if tok.AccessToken == "" {
		return "", time.Time{}, &MSGraphPermanentError{Status: resp.StatusCode, Body: "missing access_token"}
	}
	exp := time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
	if tok.ExpiresIn == 0 {
		exp = time.Now().Add(30 * time.Minute) // safe default
	}
	return tok.AccessToken, exp, nil
}

// isPermanentStatus returns true for status codes that should flip the
// sink into disabled-fault rather than just retrying next tick.
func isPermanentStatus(code int) bool {
	switch code {
	case 400, 401, 403, 404:
		return true
	}
	return false
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
