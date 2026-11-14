package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Release builds inject the tagged version with -X main.pluginVersion.
var pluginVersion = "1.0.1"

const resourceBase = "/v0/resource/plugins/media-studio/"

//go:embed studio.html studio.css app.mjs models.mjs realtime.mjs catalog.json
var assets embed.FS

type managementRequest struct {
	Method string
	Path   string
}
type managementResponse struct {
	StatusCode int
	Headers    http.Header
	Body       []byte
}

func main() {}

func dispatch(method string, body []byte) (any, error) {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		return map[string]any{"schema_version": 6, "metadata": map[string]any{
			"Name": "Media Studio", "Version": pluginVersion, "Author": "Yousha-dev",
			"GitHubRepository": "https://github.com/Yousha-dev/media-studio",
			"Description":      "Discover and try image, voice, and video models through this proxy.", "ConfigFields": []any{},
		}, "capabilities": map[string]bool{"management_api": true}}, nil
	case "management.register":
		resources := []map[string]string{{"Path": "/studio", "Menu": "Media Studio", "Description": "Images, voice, and video playground"}}
		for _, name := range []string{"studio.css", "app.mjs", "models.mjs", "realtime.mjs", "catalog.json"} {
			resources = append(resources, map[string]string{"Path": "/" + name})
		}
		return map[string]any{"routes": []any{}, "resources": resources}, nil
	case "management.handle":
		var req managementRequest
		if err := json.Unmarshal(body, &req); err != nil {
			return nil, fmt.Errorf("invalid resource request")
		}
		return serveResource(req), nil
	default:
		return nil, fmt.Errorf("unsupported plugin method")
	}
}

func serveResource(req managementRequest) managementResponse {
	headers := http.Header{
		"Cache-Control": {"no-store"}, "X-Content-Type-Options": {"nosniff"}, "Referrer-Policy": {"no-referrer"},
		"Content-Security-Policy": {"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"},
		"Permissions-Policy":      {"microphone=(self), camera=()"},
	}
	response := managementResponse{StatusCode: 404, Headers: headers, Body: []byte("Resource not found")}
	if req.Method != http.MethodGet {
		response.StatusCode = http.StatusMethodNotAllowed
		headers.Set("Allow", "GET")
		return response
	}
	if !strings.HasPrefix(req.Path, resourceBase) {
		return response
	}
	name := strings.TrimPrefix(req.Path, resourceBase)
	mime := map[string]string{"studio": "text/html; charset=utf-8", "studio.css": "text/css; charset=utf-8", "app.mjs": "text/javascript; charset=utf-8", "models.mjs": "text/javascript; charset=utf-8", "realtime.mjs": "text/javascript; charset=utf-8", "catalog.json": "application/json"}
	contentType, ok := mime[name]
	if !ok {
		return response
	}
	if name == "studio" {
		name = "studio.html"
	}
	content, err := assets.ReadFile(name)
	if err != nil {
		response.StatusCode = 500
		return response
	}
	response.StatusCode = 200
	headers.Set("Content-Type", contentType)
	response.Body = content
	return response
}
